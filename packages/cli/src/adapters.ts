import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BRAND } from "@slopstash/core";
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
    for (const m of text.matchAll(/^\*\*\* (?:Add File|Update File|Move to): (.+?)\s*$/gm)) files.add(m[1]!);
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
  },
};

export function adapterFor(harness: string): Adapter {
  const adapter = ADAPTERS[harness];
  if (!adapter) throw new Error(`unknown harness "${harness}"; ${BRAND} has adapters for ${Object.keys(ADAPTERS).join(", ")}`);
  return adapter;
}

/** Writes the harness's hook entry into its settings file, keeping everything else in it. */
export function installAdapter(root: string, harness: string, command: string): string {
  const adapter = adapterFor(harness);
  const file = path.join(root, adapter.settingsFile);
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  let settings: Record<string, unknown>;
  try {
    settings = existing.trim() ? obj(JSON.parse(existing)) : {};
  } catch (error) {
    throw new Error(`${adapter.settingsFile} is not valid JSON, so the ${harness} hook was not installed: ${(error as Error).message}`, {
      cause: error,
    });
  }
  adapter.install(settings, command);
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const next = JSON.stringify(settings, null, 2).replaceAll("\n", eol) + eol;
  if (next === existing) return `${adapter.settingsFile}: ${harness} hook already up to date`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, next);
  return `${adapter.settingsFile}: ${harness} hook installed`;
}
