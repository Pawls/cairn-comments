// Pure overlay planning: no `vscode` import, so vitest covers it (test/overlay.test.ts).
import { existsSync } from "node:fs";
import path from "node:path";
import { ANCHOR_KEY, SIDECAR_ROOT, STALE_TAG, isStale, type Marker, type SidecarEntry } from "@slopstash/core";

export type OverlayMode = "off" | "on";

export interface PlannedDecoration {
  /** `hidden`: the token is replaced by `label`. `revealed`: the token stays visible with
   *  `label` after it. `missing`: the token is shown as a warning; no body exists. */
  kind: "hidden" | "revealed" | "missing";
  id: string;
  start: number;
  end: number;
  label: string;
  /** The anchored code changed while the body did not (design.md § Staleness). */
  stale: boolean;
}

const MISSING_LABEL = "no comment body";

/** Whether a bare marker's entry is possibly stale; the marker needs its `anchor`. */
export function entryIsStale(marker: Marker, entry: SidecarEntry | undefined): boolean {
  return !!entry && isStale(marker, entry.meta.get(ANCHOR_KEY), entry.body);
}

/** The overlay label for a body: its first line, plus `(+N)` when more lines follow. */
export function labelFor(body: string, mode: OverlayMode): string {
  if (mode === "off") return "~";
  const lines = body.split("\n");
  const first = lines[0]!.trim() || "~";
  return lines.length > 1 ? `${first} (+${lines.length - 1})` : first;
}

/** A stale body's label: `~?` with the overlay off, the tag before the text with it on. */
function staleLabel(label: string, mode: OverlayMode): string {
  return mode === "off" ? "~?" : `${STALE_TAG} ${label}`;
}

/**
 * Decides how each bare marker renders. Markers that already carry text (an expanded
 * checkout) need no overlay. A marker whose line holds the cursor stays readable as
 * typed, because editing text you cannot see is worse than a flicker. Staleness shows
 * only when the markers were found with anchors.
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
    const entry = entries.get(m.id);
    const body = entry?.body ?? "";
    const stale = entryIsStale(m, entry);
    const base = { id: m.id, start: m.start, end: m.end, stale };
    const label = (text: string, as: OverlayMode) => (stale ? staleLabel(text, as) : text);
    if (!body) planned.push({ ...base, kind: "missing", label: MISSING_LABEL });
    else if (isRevealed(m)) planned.push({ ...base, kind: "revealed", label: label(labelFor(body, "on"), "on") });
    else planned.push({ ...base, kind: "hidden", label: label(labelFor(body, mode), mode) });
  }
  return planned;
}

/**
 * One line of provenance from an entry's metadata (`tag` writes by, model, session, at):
 * `claude-code · claude-opus-5-5 · 2026-09-22 20:25 UTC · session f6bed7e6`. Keys it does
 * not know, such as A7's anchor, are left out.
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

export const STALE_NOTICE = "$(warning) **Possibly stale**: the code this comment describes changed after it was written.";

/** Hover markdown: a stale notice when `stale`, the body, then the entry's provenance when it has any. */
export function hoverMarkdown(id: string, entry: SidecarEntry | undefined, sidecarPath: string, stale = false): string {
  const parts: string[] = [];
  if (stale) parts.push(STALE_NOTICE);
  if (entry?.body) parts.push(entry.body);
  else parts.push(`$(warning) **${MISSING_LABEL}** for \`${id}\` in \`${sidecarPath}\``);
  const provenance = entry && provenanceLine(entry.meta);
  if (provenance) parts.push(`*${provenance}*`);
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
