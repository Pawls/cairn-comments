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

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

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
      record = obj(JSON.parse(lines[i]!));
    } catch {
      continue; // the first line of the tail is usually cut
    }
    const model = str(obj(record.message).model);
    if (record.type === "assistant" && model && !model.startsWith("<")) return model;
  }
  return undefined;
}

/** Paths an `apply_patch` envelope touches, in any string field of the tool input. */
export function patchedFiles(input: unknown): string[] {
  const texts: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") texts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(input);
  const files = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(/^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm)) {
      const file = m[1]!.trimEnd();
      if (file) files.add(file);
    }
  }
  return [...files];
}

/** The `{matcher, hooks: [{type: "command", command}]}` layout Claude Code and Codex share. */
function installMatcherHook(settings: Record<string, unknown>, event: string, matcher: string, command: string, ours: RegExp): void {
  const hooks = (settings.hooks = obj(settings.hooks));
  const groups = (hooks[event] = arr(hooks[event]));
  for (const group of groups) {
    for (const hook of arr(obj(group).hooks)) {
      const h = obj(hook);
      if (typeof h.command === "string" && ours.test(h.command)) {
        h.command = command;
        return;
      }
    }
  }
  groups.push({ matcher, hooks: [{ type: "command", command }] });
}

const isOurs = (entry: unknown, ours: RegExp) => {
  const command = obj(entry).command;
  return typeof command === "string" && ours.test(command);
};

/** Deletes `key` from `parent` when it holds an empty object or array. */
function prune(parent: Record<string, unknown>, key: string): void {
  const v = parent[key];
  if ((Array.isArray(v) && !v.length) || (v && typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length)) delete parent[key];
}

function uninstallMatcherHook(settings: Record<string, unknown>, event: string, ours: RegExp): void {
  const hooks = obj(settings.hooks);
  hooks[event] = arr(hooks[event]).filter((group) => {
    const g = obj(group);
    g.hooks = arr(g.hooks).filter((h) => !isOurs(h, ours));
    return (g.hooks as unknown[]).length > 0;
  });
  prune(hooks, event);
  if (settings.hooks !== undefined) prune(settings, "hooks");
}

export const ADAPTERS: Record<string, Adapter> = {
  "claude-code": {
    // Local settings: the command holds this machine's path to the CLI.
    settingsFile: ".claude/settings.local.json",
    parse(p) {
      const input = obj(p.tool_input);
      const file = str(input.file_path) ?? str(input.notebook_path);
      return {
        cwd: str(p.cwd) ?? process.cwd(),
        files: file ? [file] : [],
        provenance: { by: "claude-code", session: str(p.session_id), model: modelFromTranscript(str(p.transcript_path)) },
      };
    },
    install(settings, command) {
      installMatcherHook(settings, "PostToolUse", "Edit|Write|MultiEdit", `${command} hook claude-code`, /\bhook claude-code$/);
    },
    uninstall(settings) {
      uninstallMatcherHook(settings, "PostToolUse", /\bhook claude-code$/);
    },
  },
  codex: {
    settingsFile: ".codex/hooks.json",
    parse(p) {
      const input = p.tool_input;
      const file = str(obj(input).file_path);
      return {
        cwd: str(p.cwd) ?? process.cwd(),
        files: file ? [file] : patchedFiles(input),
        provenance: { by: "codex", session: str(p.session_id), model: str(p.model) },
      };
    },
    install(settings, command) {
      installMatcherHook(settings, "PostToolUse", "apply_patch|Edit|Write", `${command} hook codex`, /\bhook codex$/);
    },
    uninstall(settings) {
      uninstallMatcherHook(settings, "PostToolUse", /\bhook codex$/);
    },
  },
  cursor: {
    settingsFile: ".cursor/hooks.json",
    parse(p) {
      const file = str(p.file_path);
      const roots = arr(p.workspace_roots).map(str).filter((r): r is string => !!r);
      return {
        cwd: roots[0] ?? process.cwd(),
        files: file ? [file] : [],
        provenance: { by: "cursor", session: str(p.conversation_id), model: str(p.model) },
      };
    },
    install(settings, command) {
      settings.version ??= 1;
      const hooks = (settings.hooks = obj(settings.hooks));
      const entries = (hooks.afterFileEdit = arr(hooks.afterFileEdit));
      const ours = entries.map(obj).find((e) => typeof e.command === "string" && /\bhook cursor$/.test(e.command));
      if (ours) ours.command = `${command} hook cursor`;
      else entries.push({ command: `${command} hook cursor` });
    },
    uninstall(settings) {
      const hooks = obj(settings.hooks);
      hooks.afterFileEdit = arr(hooks.afterFileEdit).filter((e) => !isOurs(e, /\bhook cursor$/));
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

function editSettings(root: string, harness: string, edit: (adapter: Adapter, settings: Record<string, unknown>) => void): SettingsChange | undefined {
  const adapter = adapterFor(harness);
  const file = path.join(root, adapter.settingsFile);
  const existing = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  let settings: Record<string, unknown>;
  try {
    settings = existing?.trim() ? obj(JSON.parse(existing)) : {};
  } catch (error) {
    throw new Error(`${adapter.settingsFile} is not valid JSON, so the ${harness} hook was left alone: ${(error as Error).message}`, { cause: error });
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
