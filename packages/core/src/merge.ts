import type { Sidecar, SidecarEntry } from "./sidecar.js";

export interface MergeResult {
  sidecar: Sidecar;
  /** Ids whose body both sides changed differently; their body holds conflict markers. */
  conflicts: string[];
}

function conflictText(ours: string, theirs: string): string {
  return ["<<<<<<< ours", ours, "=======", theirs, ">>>>>>> theirs"].join("\n");
}

/** Per key: a side that changed it wins; when both changed it differently, ours does. */
function mergeMeta(base: ReadonlyMap<string, string>, ours: ReadonlyMap<string, string>, theirs: ReadonlyMap<string, string>): Map<string, string> {
  const merged = new Map<string, string>();
  for (const key of new Set([...ours.keys(), ...theirs.keys(), ...base.keys()])) {
    const b = base.get(key);
    const o = ours.get(key);
    const t = theirs.get(key);
    const value = o === b ? t : o;
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
      if (!was || was.body !== entry.body) entries.push(copy(entry));
      continue;
    }
    const merged = mergeEntry(was, entry, other);
    entries.push(merged.entry);
    if (merged.conflict) conflicts.push(entry.id);
  }
  for (const entry of theirs.entries) {
    if (o.has(entry.id)) continue;
    const was = b.get(entry.id);
    if (!was || was.body !== entry.body) entries.push(copy(entry));
  }

  let preamble = ours.preamble;
  if (ours.preamble !== theirs.preamble) {
    if (ours.preamble === base.preamble) preamble = theirs.preamble;
    else if (theirs.preamble !== base.preamble) {
      preamble = conflictText(ours.preamble, theirs.preamble);
      conflicts.push("(preamble)");
    }
  }
  return { sidecar: { preamble, entries }, conflicts };
}
