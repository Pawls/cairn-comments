import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BRAND } from "@cairn-comments/core";
import { isTracked, worktreeRoots } from "./git.js";
import type { Provenance } from "./tag.js";

/** What one post-edit hook call tells us, whatever the harness. */
export interface HookEvent {
  /** Directory the harness ran in; relative file paths resolve against it. */
  cwd: string;
  /** Edited files; empty means "whatever changed", for a payload that names none. */
  files: string[];
  provenance: Provenance;
}

export interface Adapter {
  /** Settings file the hook is installed into, relative to the repository root. */
  settingsFile: string;
  parse(payload: Record<string, unknown>): HookEvent;
  /** Adds or updates this tool's hook entry in the parsed settings object. */
  install(settings: Record<string, unknown>, command: string): void;
  /** Removes this tool's hook entry, pruning containers it leaves empty. */
  uninstall(settings: Record<string, unknown>): void;
}

// Payloads and settings files are JSON from elsewhere: read every field through these.
const asString = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const asObject = (v: unknown): Record<string, unknown> => (isObject(v) ? v : {});
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Matches the command this tool installs for `harness`, whatever CLI path precedes it. */
const ourHook = (harness: string) => new RegExp(String.raw`\bhook ${harness}$`);

/**
 * The model of the last assistant message in a Claude Code transcript (JSONL). The
 * PostToolUse payload carries no model; only the tail is read, since transcripts grow long.
 */
export function modelFromTranscript(file: string | undefined, tailBytes = 256 * 1024): string | undefined {
  if (!file || !existsSync(file)) return undefined;
  const fd = openSync(file, "r");
  let text: string;
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, tailBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    text = buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let record: Record<string, unknown>;
    try {
      record = asObject(JSON.parse(lines[i]!));
    } catch {
      continue; // the first line of the tail is usually cut
    }
    const model = asString(asObject(record.message).model);
    if (record.type === "assistant" && model && !model.startsWith("<")) return model;
  }
  return undefined;
}

/** Paths an `apply_patch` envelope touches, in any string field of the tool input. */
export function patchedFiles(input: unknown): string[] {
  const files = new Set<string>();
  for (const text of stringsIn(input)) {
    for (const m of text.matchAll(/^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm)) {
      const file = m[1]!.trimEnd();
      if (file) files.add(file);
    }
  }
  return [...files];
}

/** Every string in a parsed JSON value, depth first. */
function* stringsIn(value: unknown): Generator<string> {
  if (typeof value === "string") {
    yield value;
  } else if (Array.isArray(value)) {
    for (const item of value) yield* stringsIn(item);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) yield* stringsIn(item);
  }
}

const isOurs = (entry: unknown, harness: string) => {
  const command = asObject(entry).command;
  return typeof command === "string" && ourHook(harness).test(command);
};

/** The `{matcher, hooks: [{type: "command", command}]}` layout Claude Code and Codex share. */
function installMatcherHook(settings: Record<string, unknown>, matcher: string, command: string, harness: string): void {
  const hooks = (settings.hooks = asObject(settings.hooks));
  const groups = (hooks.PostToolUse = asArray(hooks.PostToolUse));
  const hookCommand = `${command} hook ${harness}`;
  for (const group of groups) {
    const ours = asArray(asObject(group).hooks).map(asObject).find((h) => isOurs(h, harness));
    if (ours) {
      ours.command = hookCommand;
      return;
    }
  }
  groups.push({ matcher, hooks: [{ type: "command", command: hookCommand }] });
}

function isEmptyContainer(value: unknown): boolean {
  if (Array.isArray(value)) return !value.length;
  return isObject(value) && !Object.keys(value).length;
}

/** Deletes `key` from `parent` when it holds an empty object or array. */
function prune(parent: Record<string, unknown>, key: string): void {
  if (isEmptyContainer(parent[key])) delete parent[key];
}

function uninstallMatcherHook(settings: Record<string, unknown>, harness: string): void {
  const hooks = asObject(settings.hooks);
  const kept: unknown[] = [];
  for (const group of asArray(hooks.PostToolUse)) {
    const g = asObject(group);
    const remaining = asArray(g.hooks).filter((h) => !isOurs(h, harness));
    g.hooks = remaining;
    if (remaining.length) kept.push(group);
  }
  hooks.PostToolUse = kept;
  prune(hooks, "PostToolUse");
  if (settings.hooks !== undefined) prune(settings, "hooks");
}

export const ADAPTERS: Record<string, Adapter> = {
  "claude-code": {
    // Local settings: the command holds this machine's path to the CLI.
    settingsFile: ".claude/settings.local.json",
    parse(p) {
      const input = asObject(p.tool_input);
      const file = asString(input.file_path) ?? asString(input.notebook_path);
      return {
        cwd: asString(p.cwd) ?? process.cwd(),
        files: file ? [file] : [],
        provenance: { by: "claude-code", session: asString(p.session_id), model: modelFromTranscript(asString(p.transcript_path)) },
      };
    },
    install(settings, command) {
      installMatcherHook(settings, "Edit|Write|MultiEdit", command, "claude-code");
    },
    uninstall(settings) {
      uninstallMatcherHook(settings, "claude-code");
    },
  },
  codex: {
    settingsFile: ".codex/hooks.json",
    parse(p) {
      const input = p.tool_input;
      const file = asString(asObject(input).file_path);
      return {
        cwd: asString(p.cwd) ?? process.cwd(),
        files: file ? [file] : patchedFiles(input),
        provenance: { by: "codex", session: asString(p.session_id), model: asString(p.model) },
      };
    },
    install(settings, command) {
      installMatcherHook(settings, "apply_patch|Edit|Write", command, "codex");
    },
    uninstall(settings) {
      uninstallMatcherHook(settings, "codex");
    },
  },
  cursor: {
    settingsFile: ".cursor/hooks.json",
    parse(p) {
      const file = asString(p.file_path);
      const root = asArray(p.workspace_roots).map(asString).find((r): r is string => !!r);
      return {
        cwd: root ?? process.cwd(),
        files: file ? [file] : [],
        provenance: { by: "cursor", session: asString(p.conversation_id), model: asString(p.model) },
      };
    },
    install(settings, command) {
      settings.version ??= 1;
      const hooks = (settings.hooks = asObject(settings.hooks));
      const entries = (hooks.afterFileEdit = asArray(hooks.afterFileEdit));
      const ours = entries.map(asObject).find((e) => isOurs(e, "cursor"));
      if (ours) ours.command = `${command} hook cursor`;
      else entries.push({ command: `${command} hook cursor` });
    },
    uninstall(settings) {
      const hooks = asObject(settings.hooks);
      hooks.afterFileEdit = asArray(hooks.afterFileEdit).filter((e) => !isOurs(e, "cursor"));
      prune(hooks, "afterFileEdit");
      if (settings.hooks !== undefined) prune(settings, "hooks");
      // `version` is ours too when nothing else is left.
      if (Object.keys(settings).length === 1 && settings.version === 1) delete settings.version;
    },
  },
};

export function adapterFor(harness: string): Adapter {
  const adapter = ADAPTERS[harness];
  if (!adapter) throw new Error(`unknown harness "${harness}"; ${BRAND} has adapters for ${Object.keys(ADAPTERS).join(", ")}`);
  return adapter;
}

/** A pending edit to a harness settings file; `next` null deletes the file. */
export interface SettingsChange {
  file: string;
  existed: boolean;
  next: string | null;
}

type SettingsEdit = (adapter: Adapter, settings: Record<string, unknown>) => void;

function editSettings(root: string, harness: string, edit: SettingsEdit): SettingsChange | undefined {
  const adapter = adapterFor(harness);
  const file = path.join(root, adapter.settingsFile);
  const existing = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  let settings: Record<string, unknown>;
  try {
    settings = existing?.trim() ? asObject(JSON.parse(existing)) : {};
  } catch (error) {
    const reason = `${adapter.settingsFile} is not valid JSON, so the ${harness} hook was left alone`;
    throw new Error(`${reason}: ${(error as Error).message}`, { cause: error });
  }
  edit(adapter, settings);
  const eol = existing?.includes("\r\n") ? "\r\n" : "\n";
  const next = Object.keys(settings).length ? JSON.stringify(settings, null, 2).replaceAll("\n", eol) + eol : null;
  if (next === (existing ?? null)) return undefined;
  return { file, existed: existing !== undefined, next };
}

/** Adds or updates the harness's hook entry, keeping everything else in its settings file. */
export function planAdapterInstall(root: string, harness: string, command: string): SettingsChange | undefined {
  return editSettings(root, harness, (adapter, settings) => adapter.install(settings, command));
}

/**
 * Removes the harness's hook entry; a settings file left empty is deleted. A file that does
 * not parse cannot hold our hook, so it is left alone here; only an install reports it.
 */
export function planAdapterUninstall(root: string, harness: string): SettingsChange | undefined {
  if (!existsSync(path.join(root, adapterFor(harness).settingsFile))) return undefined;
  try {
    return editSettings(root, harness, (adapter, settings) => adapter.uninstall(settings));
  } catch {
    return undefined;
  }
}

export function adapterInstalled(root: string, harness: string): boolean {
  return planAdapterUninstall(root, harness) !== undefined;
}

/**
 * The worktrees a harness's hook goes into: `root`, plus every other worktree whose
 * settings file is untracked. Agents run in linked worktrees, and an untracked file never
 * reaches them through a checkout; a tracked one does, through a commit.
 */
export function adapterRoots(root: string, harness: string): string[] {
  const file = adapterFor(harness).settingsFile;
  return [root, ...worktreeRoots(root).filter((wt) => wt !== root && !isTracked(wt, file))];
}

export function applySettingsChange(change: SettingsChange): void {
  if (change.next === null) {
    rmSync(change.file, { force: true });
    return;
  }
  mkdirSync(path.dirname(change.file), { recursive: true });
  writeFileSync(change.file, change.next);
}
