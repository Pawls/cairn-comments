// Pure overlay helpers: no `vscode` import, so vitest covers them (test/overlay.test.ts).
import { existsSync } from "node:fs";
import path from "node:path";
import { SIDECAR_ROOT } from "@cairn-comments/core";

export type OverlayMode = "off" | "on";

/** The label for a body: its first line, plus `(+N)` when more lines follow. */
export function labelFor(body: string): string {
  const lines = body.split("\n");
  const first = lines[0]!.trim() || "~";
  return lines.length > 1 ? `${first} (+${lines.length - 1})` : first;
}

/**
 * One line of provenance from an entry's metadata (`tag` writes by, model, session, at):
 * `claude-code · claude-opus-5-5 · 2026-09-22 20:25 UTC · session f6bed7e6`. Keys it does
 * not know, such as the placement keys, are left out.
 */
export function provenanceLine(meta: ReadonlyMap<string, string>): string | undefined {
  const at = meta.get("at")?.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  const session = meta.get("session");
  const parts = [
    meta.get("by"),
    meta.get("model"),
    at ? `${at[1]} ${at[2]} UTC` : meta.get("at"),
    session && `session ${session.slice(0, 8)}`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

/**
 * A comment body as Markdown that keeps its lines: Markdown joins a paragraph's lines with
 * spaces, so each line followed by another ends in a hard break (two spaces).
 */
export function bodyMarkdown(body: string): string {
  const lines = body.split("\n");
  return lines.map((line, i) => (line && lines[i + 1] ? `${line}  ` : line)).join("\n");
}

/**
 * The directory a source file's sidecar path is relative to. The nearest ancestor that
 * holds the sidecar folder or a `.git` wins, in that order at each level, so a workspace
 * that keeps its own sidecars inside a larger repository still resolves to itself.
 */
export function findSidecarRoot(fileDir: string, fallback: string): string {
  let dir = path.resolve(fileDir);
  for (;;) {
    if (existsSync(path.join(dir, SIDECAR_ROOT)) || existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return fallback;
    dir = parent;
  }
}
