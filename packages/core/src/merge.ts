import { PLACEMENT_KEYS } from "./placement.js";
import type { Sidecar, SidecarEntry } from "./sidecar.js";

export interface MergeResult {
  sidecar: Sidecar;
  /** Ids whose body both sides changed differently; their body holds conflict markers. */
  conflicts: string[];
}

const CONFLICT_START = "<<<<<<< ours";

function conflictText(ours: string, theirs: string): string {
  return [CONFLICT_START, ours, "=======", theirs, ">>>>>>> theirs"].join("\n");
}

/** Whether a body still holds the conflict markers a merge left in it. */
export function hasConflictMarkers(body: string): boolean {
  return body.split("\n").includes(CONFLICT_START);
}

const isPlacementKey = (key: string) => (PLACEMENT_KEYS as readonly string[]).includes(key);

function placementOf(meta: ReadonlyMap<string, string>): string {
  return JSON.stringify([...meta].filter(([k]) => isPlacementKey(k)));
}

/** A side that changed the value wins; when both did, ours does. */
function mergeValue(base: string | undefined, ours: string | undefined, theirs: string | undefined): string | undefined {
  return ours === base ? theirs : ours;
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
    const value = isPlacementKey(key) ? placement.get(key) : mergeValue(base.get(key), ours.get(key), theirs.get(key));
    if (value !== undefined) merged.set(key, value);
  }
  return merged;
}

const copyEntry = (e: SidecarEntry): SidecarEntry => ({ ...e, meta: new Map(e.meta) });

function mergeEntry(base: SidecarEntry | undefined, ours: SidecarEntry, theirs: SidecarEntry): { entry: SidecarEntry; conflict: boolean } {
  const baseBody = base?.body;
  // Provenance and anchor describe the body they were written with, so they travel with it.
  if (ours.body !== theirs.body) {
    if (theirs.body === baseBody) return { entry: copyEntry(ours), conflict: false };
    if (ours.body === baseBody) return { entry: copyEntry(theirs), conflict: false };
    return { entry: { id: ours.id, meta: new Map(ours.meta), body: conflictText(ours.body, theirs.body) }, conflict: true };
  }
  return { entry: { id: ours.id, meta: mergeMeta(base?.meta ?? new Map(), ours.meta, theirs.meta), body: ours.body }, conflict: false };
}

const entriesById = (sidecar: Sidecar) => new Map(sidecar.entries.map((e) => [e.id, e]));

/** Ours' entries in ours' order, each merged with theirs' copy of it. */
function mergeOurEntries(base: Map<string, SidecarEntry>, ours: Sidecar, theirs: Map<string, SidecarEntry>): { entries: SidecarEntry[]; conflicts: string[] } {
  const entries: SidecarEntry[] = [];
  const conflicts: string[] = [];
  for (const entry of ours.entries) {
    const other = theirs.get(entry.id);
    const was = base.get(entry.id);
    if (!other) {
      // Theirs deleted it, unless ours added it: ours keeps it only if its body differs from the base's.
      if (was?.body !== entry.body) entries.push(copyEntry(entry));
      continue;
    }
    const merged = mergeEntry(was, entry, other);
    entries.push(merged.entry);
    if (merged.conflict) conflicts.push(entry.id);
  }
  return { entries, conflicts };
}

/** Theirs' entries that ours lacks, except those ours deleted and theirs left as the base had them. */
function theirNewEntries(base: Map<string, SidecarEntry>, ours: Map<string, SidecarEntry>, theirs: Sidecar): SidecarEntry[] {
  return theirs.entries.filter((e) => !ours.has(e.id) && base.get(e.id)?.body !== e.body).map(copyEntry);
}

/**
 * Three-way merge of one sidecar by entry id, for the `merge=<brand>` driver
 * (design.md § Sidecar merges). Ours keeps its order and theirs' new entries append. A
 * deletion wins over an unchanged entry but not over an edit, and a body both sides
 * changed differently is written with conflict markers so the user resolves it in place.
 */
export function mergeSidecars(base: Sidecar, ours: Sidecar, theirs: Sidecar): MergeResult {
  const baseById = entriesById(base);
  const merged = mergeOurEntries(baseById, ours, entriesById(theirs));
  const additions = theirNewEntries(baseById, entriesById(ours), theirs);
  const preamble = mergePreamble(base.preamble, ours.preamble, theirs.preamble);
  const conflicts = preamble.conflict ? [...merged.conflicts, "(preamble)"] : merged.conflicts;
  return { sidecar: { preamble: preamble.text, entries: [...merged.entries, ...additions] }, conflicts };
}

/** One side's change wins; two different changes are written with conflict markers. */
function mergePreamble(base: string, ours: string, theirs: string): { text: string; conflict: boolean } {
  if (ours === theirs || theirs === base) return { text: ours, conflict: false };
  if (ours === base) return { text: theirs, conflict: false };
  return { text: conflictText(ours, theirs), conflict: true };
}
