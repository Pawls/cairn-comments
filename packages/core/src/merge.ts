import { PLACEMENT_KEYS } from "./placement.js";
import type { Sidecar, SidecarEntry } from "./sidecar.js";

export interface MergeResult {
  sidecar: Sidecar;
  /** Ids whose body both sides changed differently; their body holds conflict markers. */
  conflicts: string[];
}

function conflictText(ours: string, theirs: string): string {
  return ["<<<<<<< ours", ours, "=======", theirs, ">>>>>>> theirs"].join("\n");
}

const isPlacementKey = (key: string) => (PLACEMENT_KEYS as readonly string[]).includes(key);

function placementOf(meta: ReadonlyMap<string, string>): string {
  return JSON.stringify([...meta].filter(([k]) => isPlacementKey(k)));
}

/**
 * Per key: a side that changed it wins; when both changed it differently, ours does. The
 * placement keys are one unit, taken whole from one side: a scope from one recording and a
 * node hash from another would place the comment on code neither side meant.
 */
function mergeMeta(base: ReadonlyMap<string, string>, ours: ReadonlyMap<string, string>, theirs: ReadonlyMap<string, string>): Map<string, string> {
  const placement = placementOf(ours) === placementOf(base) ? theirs : ours;
  const merged = new Map<string, string>();
  for (const key of new Set([...ours.keys(), ...theirs.keys(), ...base.keys()])) {
    const o = ours.get(key);
    // Placement keys come from one side together; any other key takes the side that changed it.
    let value = o === base.get(key) ? theirs.get(key) : o;
    if (isPlacementKey(key)) value = placement.get(key);
    if (value !== undefined) merged.set(key, value);
  }
  return merged;
}

const copy = (e: SidecarEntry): SidecarEntry => ({ ...e, meta: new Map(e.meta) });

function mergeEntry(base: SidecarEntry | undefined, ours: SidecarEntry, theirs: SidecarEntry): { entry: SidecarEntry; conflict: boolean } {
  const baseBody = base?.body;
  // Provenance and anchor describe the body they were written with, so they travel with it.
  if (ours.body !== theirs.body) {
    if (theirs.body === baseBody) return { entry: copy(ours), conflict: false };
    if (ours.body === baseBody) return { entry: copy(theirs), conflict: false };
    return { entry: { id: ours.id, meta: new Map(ours.meta), body: conflictText(ours.body, theirs.body) }, conflict: true };
  }
  return { entry: { id: ours.id, meta: mergeMeta(base?.meta ?? new Map(), ours.meta, theirs.meta), body: ours.body }, conflict: false };
}

/**
 * Three-way merge of one sidecar by entry id, for the `merge=<brand>` driver
 * (design.md § Sidecar merges). Ours keeps its order and theirs' new entries append. A
 * deletion wins over an unchanged entry but not over an edit, and a body both sides
 * changed differently is written with conflict markers so the user resolves it in place.
 */
export function mergeSidecars(base: Sidecar, ours: Sidecar, theirs: Sidecar): MergeResult {
  const byId = (s: Sidecar) => new Map(s.entries.map((e) => [e.id, e]));
  const b = byId(base);
  const o = byId(ours);
  const t = byId(theirs);
  const entries: SidecarEntry[] = [];
  const conflicts: string[] = [];

  for (const entry of ours.entries) {
    const other = t.get(entry.id);
    const was = b.get(entry.id);
    if (!other) {
      // Theirs deleted it: keep ours only if ours edited it since the base.
      if (was?.body !== entry.body) entries.push(copy(entry));
      continue;
    }
    const merged = mergeEntry(was, entry, other);
    entries.push(merged.entry);
    if (merged.conflict) conflicts.push(entry.id);
  }
  for (const entry of theirs.entries) {
    if (o.has(entry.id)) continue;
    const was = b.get(entry.id);
    if (was?.body !== entry.body) entries.push(copy(entry));
  }

  const preamble = mergePreamble(base.preamble, ours.preamble, theirs.preamble);
  if (preamble.conflict) conflicts.push("(preamble)");
  return { sidecar: { preamble: preamble.text, entries }, conflicts };
}

/** One side's change wins; two different changes are written with conflict markers. */
function mergePreamble(base: string, ours: string, theirs: string): { text: string; conflict: boolean } {
  if (ours === theirs || theirs === base) return { text: ours, conflict: false };
  if (ours === base) return { text: theirs, conflict: false };
  return { text: conflictText(ours, theirs), conflict: true };
}
