// Pure overlay planning: no `vscode` import, so vitest covers it (test/overlay.test.ts).
import { existsSync } from "node:fs";
import path from "node:path";
import { SIDECAR_ROOT, type Marker, type SidecarEntry } from "@slopstash/core";

export type OverlayMode = "off" | "on";

export interface PlannedDecoration {
  /** `hidden`: the token is replaced by `label`. `revealed`: the token stays visible with
   *  `label` after it. `missing`: the token is shown as a warning; no body exists. */
  kind: "hidden" | "revealed" | "missing";
  id: string;
  start: number;
  end: number;
  label: string;
}

const MISSING_LABEL = "no comment body";

/** The overlay label for a body: its first line, plus `(+N)` when more lines follow. */
export function labelFor(body: string, mode: OverlayMode): string {
  if (mode === "off") return "~";
  const lines = body.split("\n");
  const first = lines[0]!.trim() || "~";
  return lines.length > 1 ? `${first} (+${lines.length - 1})` : first;
}

/**
 * Decides how each bare marker renders. Markers that already carry text (an expanded
 * checkout) need no overlay. A marker whose line holds the cursor stays readable as
 * typed, because editing text you cannot see is worse than a flicker.
 */
export function planOverlay(
  markers: readonly Marker[],
  entries: ReadonlyMap<string, SidecarEntry>,
  mode: OverlayMode,
  isRevealed: (marker: Marker) => boolean,
): PlannedDecoration[] {
  const planned: PlannedDecoration[] = [];
  for (const m of markers) {
    if (m.kind !== "bare" || !m.id) continue;
    const body = entries.get(m.id)?.body ?? "";
    const base = { id: m.id, start: m.start, end: m.end };
    if (!body) planned.push({ ...base, kind: "missing", label: MISSING_LABEL });
    else if (isRevealed(m)) planned.push({ ...base, kind: "revealed", label: labelFor(body, "on") });
    else planned.push({ ...base, kind: "hidden", label: labelFor(body, mode) });
  }
  return planned;
}

/** Hover markdown: the body, then any provenance the sidecar carries (filled by A6). */
export function hoverMarkdown(id: string, entry: SidecarEntry | undefined, sidecarPath: string): string {
  const parts: string[] = [];
  if (entry?.body) parts.push(entry.body);
  else parts.push(`$(warning) **${MISSING_LABEL}** for \`${id}\` in \`${sidecarPath}\``);
  if (entry?.meta.size) parts.push("*" + [...entry.meta].map(([k, v]) => `${k}: ${v}`).join(" · ") + "*");
  return parts.join("\n\n");
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
