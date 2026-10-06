// Changes made to AI comments from a checkout that shows none of them (the owner's, through
// the extension or the CLI): each works on the code as it stands and returns the new sidecar.
import { freshId } from "./ids.js";
import { languageForPath, type LanguageSpec } from "./languages.js";
import { LITERAL_KEY, writeLiteral } from "./literals.js";
import { applySplices, dominantEol, splitLines, type Line, type Splice } from "./lines.js";
import { findMarkers, type Marker } from "./markers.js";
import { PLACEMENT_KEYS, placeComments, recordComments, stripComments } from "./placement.js";
import { normalizeBody, type Sidecar, type SidecarEntry } from "./sidecar.js";

export const COPIED_FROM_KEY = "copied-from";

const PLACEMENT_KEY_LIST: readonly string[] = PLACEMENT_KEYS;

/** The terminator ending the line at `offset`, or `fallback` on an unterminated last line. */
function eolAt(source: string, offset: number, fallback: string): string {
  if (source.startsWith("\r\n", offset)) return "\r\n";
  if (source[offset] === "\n") return "\n";
  return fallback;
}

export interface PromotePlacedResult {
  /** `code` with each promoted comment written in as an ordinary comment. */
  source: string;
  sidecar: Sidecar;
  /** Requested ids with no comment to promote. */
  missing: string[];
}

/** What replaces a promoted sigil comment: the string it was demoted from, else ordinary comment lines. */
function promotedText(spec: LanguageSpec, marker: Marker, body: string, eol: string, literal: string | undefined): string {
  const trailing = marker.placement === "trailing";
  if (literal !== undefined && !trailing) {
    const asString = writeLiteral(literal, body, marker.indent, eol);
    if (asString !== undefined) return asString;
  }
  const prefix = spec.lineSigil.slice(0, -1);
  const toComment = (line: string) => (line ? `${prefix} ${line}` : prefix);
  const lines = trailing ? [body.replaceAll("\n", " ")] : body.split("\n");
  return lines.map(toComment).join(eol + marker.indent);
}

/**
 * Turns each named sigil comment in `source` into an ordinary comment under the language's
 * plain line prefix (`#`, `//`), or back into the string it was demoted from, and drops its
 * entry. Inverse of `convertComments` for a line comment written `<prefix> text`
 * (design.md § Promote and demote). Returns the ids with no comment to promote.
 */
async function promoteShown(path: string, source: string, sidecar: Sidecar, ids: readonly string[]): Promise<PromotePlacedResult> {
  const spec = languageForPath(path);
  const markers = spec ? await findMarkers(spec, source) : [];
  const fallbackEol = dominantEol(source);
  const splices: Splice[] = [];
  const promoted = new Set<string>();
  const missing: string[] = [];
  for (const id of ids) {
    const marker = markers.find((m) => m.id === id);
    const body = marker && normalizeBody(marker.text ?? "");
    if (!spec || !marker || !body) {
      missing.push(id);
      continue;
    }
    const literal = sidecar.entries.find((e) => e.id === id)?.meta.get(LITERAL_KEY);
    const eol = eolAt(source, marker.end, fallbackEol);
    splices.push({ start: marker.start, end: marker.end, text: promotedText(spec, marker, body, eol, literal) });
    promoted.add(id);
  }
  const entries = sidecar.entries.filter((e) => !promoted.has(e.id)).map((e) => ({ ...e, meta: new Map(e.meta) }));
  return { source: applySplices(source, splices), sidecar: { preamble: sidecar.preamble, entries }, missing };
}

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

/**
 * Writes each id's body into `code` as an ordinary comment where it places, and drops its
 * entry. The other comments are recorded again, since a new human comment line can sit
 * between one of them and its code; their stale flags are kept.
 */
export async function promotePlaced(path: string, code: string, sidecar: Sidecar, ids: readonly string[]): Promise<PromotePlacedResult> {
  const placed = await placeComments(path, code, sidecar);
  const missing = ids.filter((id) => !placed.placed.includes(id));
  if (missing.length) return { source: code, sidecar, missing };
  const promoted = await promoteShown(path, placed.source, sidecar, ids);
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
  /**
   * The original no longer places (the copy was a cut), so this is the same comment moved:
   * it keeps `from` as its id when the sidecar has no entry with that id, and records no
   * `copied-from`. The caller removes the original entry.
   */
  moved?: boolean;
}

export interface CarryResult {
  sidecar: Sidecar;
  /** The new entries' ids, in the order of `carried`; empty where one could not be recorded. */
  ids: string[];
}

/** A copy gets a new id, so it never shares one with its original; a moved comment keeps its own unless `taken` has it. */
function idFor(path: string, comment: CarriedComment, taken: Set<string>): string {
  if (!comment.moved || taken.has(comment.from)) return freshId(path, comment.body, taken);
  taken.add(comment.from);
  return comment.from;
}

/** The pasted code a carried comment is written into. */
interface PasteTarget {
  spec: LanguageSpec;
  code: string;
  lines: Line[];
  eol: string;
}

/** The sigil comment for `comment` in the pasted code, or undefined when its line or body is missing. */
function carriedSplice(target: PasteTarget, comment: CarriedComment, id: string): Splice | undefined {
  const { spec, code, lines, eol } = target;
  const line = lines[comment.row];
  const body = normalizeBody(comment.body);
  if (!line || !body) return undefined;
  const sigil = spec.lineSigil + id;
  if (comment.kind === "trail") {
    return { start: line.contentEnd, end: line.contentEnd, text: `  ${sigil} ${body.replaceAll("\n", " ")}` };
  }
  const indent = /^[ \t]*/.exec(code.slice(line.start, line.contentEnd))?.[0] ?? "";
  const [head = "", ...rest] = body.split("\n");
  const block = [`${indent}${sigil} ${head}`, ...rest.map((l) => indent + spec.lineSigil + (l ? " " + l : ""))];
  return { start: line.start, end: line.start, text: block.map((l) => l + eol).join("") };
}

/** The recorded entry given the provenance of the comment it came from. */
function carriedEntry(comment: CarriedComment, recorded: SidecarEntry): SidecarEntry {
  // A moved comment keeps its own `copied-from`, if it has one; a copy records its original.
  const provenance = [...comment.meta].filter(([k]) => !PLACEMENT_KEY_LIST.includes(k) && (comment.moved || k !== COPIED_FROM_KEY));
  const copiedFrom: [string, string][] = comment.moved ? [] : [[COPIED_FROM_KEY, comment.from]];
  return { id: recorded.id, meta: new Map([...provenance, ...copiedFrom, ...recorded.meta]), body: recorded.body };
}

/**
 * Adds a new entry for each carried comment, anchored to `code` (the file after the paste,
 * without AI comments) as `sync` would anchor it had an agent written it there. A copy gets
 * a new id, so it never shares one with its original; a moved comment keeps its id.
 */
export async function carryComments(path: string, code: string, sidecar: Sidecar, carried: readonly CarriedComment[]): Promise<CarryResult> {
  const spec = languageForPath(path);
  if (!spec || !carried.length) return { sidecar, ids: [] };
  const target: PasteTarget = { spec, code, lines: splitLines(code), eol: dominantEol(code) };
  const taken = new Set(sidecar.entries.map((e) => e.id));
  const pending = carried.map((comment) => ({ comment, id: idFor(path, comment, taken) }));

  const splices: Splice[] = [];
  for (const { comment, id } of pending) {
    const splice = carriedSplice(target, comment, id);
    if (splice) splices.push(splice);
  }
  const recorded = await recordComments(path, applySplices(code, splices), { preamble: "", entries: [] });

  const added: SidecarEntry[] = [];
  const addedIds: string[] = [];
  for (const { comment, id } of pending) {
    const entry = recorded.sidecar.entries.find((e) => e.id === id);
    if (entry) added.push(carriedEntry(comment, entry));
    addedIds.push(entry?.id ?? "");
  }
  return { sidecar: { preamble: sidecar.preamble, entries: [...sidecar.entries, ...added] }, ids: addedIds };
}
