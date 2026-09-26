// Changes made to markerless comments from a checkout that shows none of them (the owner's,
// through the extension): each works on the code as it stands and returns the new sidecar.
import { promote } from "./filter.js";
import { freshId } from "./ids.js";
import { languageForPath } from "./languages.js";
import { applySplices, dominantEol, splitLines, type Splice } from "./lines.js";
import { PLACEMENT_KEYS, placeComments, recordComments, stripComments } from "./placement.js";
import { normalizeBody, type Sidecar, type SidecarEntry } from "./sidecar.js";

export const COPIED_FROM_KEY = "copied-from";

export interface ConfirmPlacedResult {
  sidecar: Sidecar;
  changed: boolean;
  /** Requested ids that do not place in `code`. */
  missing: string[];
}

/**
 * Records the current placement of each id, clearing its stale flag (design.md § Anchoring,
 * "Who saw it"). `code` is the file without AI comments; nothing is changed when an id does
 * not place.
 */
export async function confirmPlaced(path: string, code: string, sidecar: Sidecar, ids: readonly string[]): Promise<ConfirmPlacedResult> {
  const placed = await placeComments(path, code, sidecar);
  const missing = ids.filter((id) => !placed.placed.includes(id));
  if (missing.length) return { sidecar, changed: false, missing };
  // The code as it stands is the baseline: only the named ids take their new placement.
  const recorded = await recordComments(path, placed.source, sidecar, { baseline: code, confirm: new Set(ids) });
  return { sidecar: recorded.sidecar, changed: recorded.sidecarChanged, missing: [] };
}

export interface PromotePlacedResult {
  /** `code` with each promoted comment written in as an ordinary comment. */
  source: string;
  sidecar: Sidecar;
  missing: string[];
}

/**
 * Writes each id's body into `code` as an ordinary comment where it places, and drops its
 * entry. The other comments are recorded again, since a new human comment line can sit
 * between one of them and its code; their stale flags are kept.
 */
export async function promotePlaced(path: string, code: string, sidecar: Sidecar, ids: readonly string[]): Promise<PromotePlacedResult> {
  const placed = await placeComments(path, code, sidecar);
  const missing = ids.filter((id) => !placed.placed.includes(id));
  if (missing.length) return { source: code, sidecar, missing };
  const promoted = await promote(path, placed.source, sidecar, ids);
  const recorded = await recordComments(path, promoted.source, promoted.sidecar, { baseline: code });
  return { source: await stripComments(path, recorded.source), sidecar: recorded.sidecar, missing: promoted.missing };
}

/** A comment carried by a copy, to be added where the copy was pasted. */
export interface CarriedComment {
  /** The line of the code it goes above (`own`) or at the end of (`trail`). */
  row: number;
  kind: "own" | "trail";
  body: string;
  /** The copied entry's metadata; its provenance carries over, its placement does not. */
  meta: ReadonlyMap<string, string>;
  /** The copied entry's id, recorded as `copied-from`. */
  from: string;
}

export interface CarryResult {
  sidecar: Sidecar;
  /** The new entries' ids, in the order of `carried`; empty where one could not be recorded. */
  ids: string[];
}

/**
 * Adds a new entry for each carried comment, anchored to `code` (the file after the paste,
 * without AI comments) as `sync` would anchor it had an agent written it there. Ids are new,
 * so a copy never shares one with its original.
 */
export async function carryComments(path: string, code: string, sidecar: Sidecar, carried: readonly CarriedComment[]): Promise<CarryResult> {
  const spec = languageForPath(path);
  if (!spec || !carried.length) return { sidecar, ids: [] };
  const lines = splitLines(code);
  const eol = dominantEol(code);
  const taken = new Set(sidecar.entries.map((e) => e.id));
  const ids = carried.map((c) => freshId(path, c.body, taken));
  const splices: Splice[] = [];
  carried.forEach((c, i) => {
    const line = lines[c.row];
    const body = normalizeBody(c.body);
    if (!line || !body) return;
    const sigil = spec.lineSigil + ids[i]!;
    if (c.kind === "trail") {
      splices.push({ start: line.contentEnd, end: line.contentEnd, text: `  ${sigil} ${body.split("\n").join(" ")}` });
      return;
    }
    const indent = /^[ \t]*/.exec(code.slice(line.start, line.contentEnd))![0];
    const [head, ...rest] = body.split("\n");
    const block = [`${indent}${sigil} ${head!}`, ...rest.map((l) => indent + spec.lineSigil + (l ? " " + l : ""))];
    splices.push({ start: line.start, end: line.start, text: block.map((l) => l + eol).join("") });
  });
  const recorded = await recordComments(path, applySplices(code, splices), { preamble: "", entries: [] });
  const placementKeys: readonly string[] = PLACEMENT_KEYS;
  const added: SidecarEntry[] = [];
  const addedIds = carried.map((c, i) => {
    const entry = recorded.sidecar.entries.find((e) => e.id === ids[i]);
    if (!entry) return "";
    const provenance = [...c.meta].filter(([k]) => !placementKeys.includes(k) && k !== COPIED_FROM_KEY);
    added.push({ id: entry.id, meta: new Map([...provenance, [COPIED_FROM_KEY, c.from], ...entry.meta]), body: entry.body });
    return entry.id;
  });
  return { sidecar: { preamble: sidecar.preamble, entries: [...sidecar.entries, ...added] }, ids: addedIds };
}
