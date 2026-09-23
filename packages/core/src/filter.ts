import { resolveIds } from "./ids.js";
import { languageForPath } from "./languages.js";
import { applySplices, dominantEol, type Splice } from "./lines.js";
import { STALE_TAG, findMarkers, type Marker } from "./markers.js";
import { bodiesOf, normalizeBody, type Sidecar, type SidecarEntry } from "./sidecar.js";

/** Metadata key holding the anchor hash recorded when the body was last written or confirmed. */
export const ANCHOR_KEY = "anchor";

/** The terminator ending the line at `offset`, or `fallback` on an unterminated last line. */
function eolAt(source: string, offset: number, fallback: string): string {
  if (source.startsWith("\r\n", offset)) return "\r\n";
  if (source[offset] === "\n") return "\n";
  return fallback;
}

/** How a stored body appears inline: a trailing comment has one line to live on. */
function inlineText(marker: Marker, body: string): string {
  return marker.placement === "trailing" ? body.split("\n").join(" ") : body;
}

/**
 * Collapses every sigil comment to `<sigil><id>`. Pure in (path, source): git runs it on
 * status, diff, and add, so it never reads or writes the sidecar (design.md § Mechanics).
 * Bytes outside a marker, including every line terminator, pass through untouched.
 */
export async function clean(path: string, source: string): Promise<string> {
  const spec = languageForPath(path);
  if (!spec) return source;
  const markers = await findMarkers(spec, source);
  if (!markers.length) return source;
  const ids = resolveIds(path, markers);
  return applySplices(
    source,
    markers.map((m, i) => ({ start: m.start, end: m.end, text: spec.lineSigil + ids[i]! })),
  );
}

/**
 * Whether a marker's anchored code changed since its body was last written or confirmed
 * (design.md § Staleness). Needs `marker.anchor`, so find markers with `anchors: true`.
 * An expanded marker whose text differs from the stored body is a pending edit, which
 * `sync` will record with a fresh anchor, so it is not stale.
 */
export function isStale(marker: Marker, stored: string | undefined, body: string | undefined): boolean {
  if (stored === undefined || !body || !marker.id || marker.anchor === undefined) return false;
  if (marker.text !== undefined && normalizeBody(marker.text) !== inlineText(marker, body)) return false;
  return marker.anchor !== stored;
}

/**
 * Expands bare markers from stored bodies. A marker with no body yet stays bare
 * (design.md § Git behavior, item 2); comments that already carry text are left as written.
 * Given the stored anchors, a possibly stale body is shown behind `STALE_TAG`, and the
 * tag is added to or removed from already expanded comments to match.
 */
export async function smudge(
  path: string,
  source: string,
  bodies: ReadonlyMap<string, string>,
  anchors: ReadonlyMap<string, string> = new Map(),
): Promise<string> {
  const spec = languageForPath(path);
  if (!spec) return source;
  const markers = await findMarkers(spec, source, { anchors: anchors.size > 0 });
  const fallbackEol = dominantEol(source);
  const splices: Splice[] = [];
  for (const m of markers) {
    const stored = m.id === undefined ? undefined : bodies.get(m.id);
    const stale = isStale(m, m.id === undefined ? undefined : anchors.get(m.id), stored);
    const tag = stale ? STALE_TAG + " " : "";
    if (m.kind === "expanded") {
      if (stale === m.staleTag) continue;
      const at = m.start + spec.lineSigil.length + m.id!.length + 1;
      splices.push({ start: at, end: m.staleTag ? at + STALE_TAG.length + 1 : at, text: tag });
      continue;
    }
    const body = m.kind === "bare" ? normalizeBody(stored ?? "") : "";
    if (!body) continue;
    const [first, ...rest] = inlineText(m, body).split("\n");
    // New lines reuse the marker line's own terminator, so clean restores it exactly.
    const eol = eolAt(source, m.end, fallbackEol);
    const continuation = rest.map((l) => eol + m.indent + spec.lineSigil + (l ? " " + l : ""));
    const text = `${spec.lineSigil}${m.id!} ${tag}${first!}${continuation.join("")}`;
    splices.push({ start: m.start, end: m.end, text });
  }
  return applySplices(source, splices);
}

export interface SyncResult {
  source: string;
  sidecar: Sidecar;
  sourceChanged: boolean;
  sidecarChanged: boolean;
}

export interface SyncOptions {
  /** Provenance merged into the metadata of every entry this sync creates or rewrites. */
  meta?: ReadonlyMap<string, string>;
}

function setAnchor(entry: SidecarEntry, anchor: string | null | undefined): boolean {
  if (entry.meta.get(ANCHOR_KEY) === (anchor ?? undefined)) return false;
  if (anchor == null) entry.meta.delete(ANCHOR_KEY);
  else entry.meta.set(ANCHOR_KEY, anchor);
  return true;
}

/**
 * Moves comment bodies from an expanded working file into its sidecar and stamps ids
 * onto new comments. A body it writes records its anchor's hash, and an entry with no
 * hash yet gets the current one; an unchanged body keeps its hash, which is what makes
 * it stale once the code moves on. Entries whose marker is gone are kept; `check` owns
 * orphans.
 */
export async function sync(
  path: string,
  source: string,
  sidecar: Sidecar,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const unchanged = { source, sidecar, sourceChanged: false, sidecarChanged: false };
  const spec = languageForPath(path);
  if (!spec) return unchanged;
  const markers = await findMarkers(spec, source, { anchors: true });
  if (!markers.length) return unchanged;
  const ids = resolveIds(path, markers);

  const entries = sidecar.entries.map((e) => ({ ...e, meta: new Map(e.meta) }));
  const stored = bodiesOf(sidecar);
  let sidecarChanged = false;
  const splices: Splice[] = [];
  for (const [i, m] of markers.entries()) {
    const id = ids[i]!;
    if (m.id !== id) {
      const idStart = m.start + spec.lineSigil.length;
      splices.push({ start: idStart, end: idStart + (m.id?.length ?? 0), text: id });
    }
    const known = stored.get(id);
    const text = m.text === undefined ? undefined : normalizeBody(m.text);
    const existing = entries.find((e) => e.id === id);
    // A multi-line body flattened onto a trailing marker is not an edit.
    const unedited = text === undefined || (known !== undefined && inlineText(m, known) === text);
    if (unedited) {
      // An entry written before anchors existed gets the current one.
      if (existing?.body && typeof m.anchor === "string" && !existing.meta.has(ANCHOR_KEY)) {
        existing.meta.set(ANCHOR_KEY, m.anchor);
        sidecarChanged = true;
      }
      continue;
    }
    let entry = existing;
    if (!entry) {
      entry = { id, meta: new Map(), body: text };
      entries.push(entry);
    }
    entry.body = text;
    // Provenance names the last writer of the body, so an edit replaces it.
    for (const [k, v] of options.meta ?? []) entry.meta.set(k, v);
    setAnchor(entry, m.anchor);
    stored.set(id, text);
    sidecarChanged = true;
  }

  return {
    source: applySplices(source, splices),
    sidecar: { preamble: sidecar.preamble, entries },
    sourceChanged: splices.length > 0,
    sidecarChanged,
  };
}

export function anchorsOf(sidecar: Sidecar): Map<string, string> {
  const anchors = new Map<string, string>();
  for (const e of sidecar.entries) {
    const anchor = e.meta.get(ANCHOR_KEY);
    if (anchor !== undefined) anchors.set(e.id, anchor);
  }
  return anchors;
}

/** A marker whose anchored code changed while its body did not. */
export interface StaleMarker {
  id: string;
  marker: Marker;
  body: string;
}

/** Possibly stale comments of one file, in source order. */
export async function staleMarkers(path: string, source: string, sidecar: Sidecar): Promise<StaleMarker[]> {
  const spec = languageForPath(path);
  const anchors = anchorsOf(sidecar);
  if (!spec || !anchors.size) return [];
  const bodies = bodiesOf(sidecar);
  const stale: StaleMarker[] = [];
  for (const m of await findMarkers(spec, source, { anchors: true })) {
    const body = m.id === undefined ? undefined : bodies.get(m.id);
    if (m.id && body && isStale(m, anchors.get(m.id), body)) stale.push({ id: m.id, marker: m, body });
  }
  return stale;
}

export interface ConfirmResult {
  sidecar: Sidecar;
  changed: boolean;
  /** Requested ids with no marker in the source or no sidecar entry. */
  missing: string[];
}

/**
 * Accepts the current code as what each named comment describes: records its anchor,
 * which clears the stale flag without touching the body.
 */
export async function confirm(
  path: string,
  source: string,
  sidecar: Sidecar,
  ids: readonly string[],
): Promise<ConfirmResult> {
  const spec = languageForPath(path);
  const markers = spec ? await findMarkers(spec, source, { anchors: true }) : [];
  const entries = sidecar.entries.map((e) => ({ ...e, meta: new Map(e.meta) }));
  let changed = false;
  const missing: string[] = [];
  for (const id of ids) {
    const marker = markers.find((m) => m.id === id);
    const entry = entries.find((e) => e.id === id);
    if (!marker || !entry) missing.push(id);
    else if (setAnchor(entry, marker.anchor)) changed = true;
  }
  return { sidecar: { preamble: sidecar.preamble, entries }, changed, missing };
}

export interface PromoteResult {
  source: string;
  sidecar: Sidecar;
  /** Requested ids with no marker in the source or no body to promote. */
  missing: string[];
}

/**
 * Turns each named AI comment into an ordinary committed comment: the marker becomes the
 * body under the language's plain line prefix (`#`, `//`), and the sidecar entry, anchor
 * included, is dropped. An expanded marker's own text wins over the stored body, so an
 * unsynced edit is what gets promoted. Inverse of `convertComments` for a line comment
 * written `<prefix> text` (design.md § Promote and demote).
 */
export async function promote(
  path: string,
  source: string,
  sidecar: Sidecar,
  ids: readonly string[],
): Promise<PromoteResult> {
  const spec = languageForPath(path);
  const markers = spec ? await findMarkers(spec, source) : [];
  const stored = bodiesOf(sidecar);
  const fallbackEol = dominantEol(source);
  const splices: Splice[] = [];
  const promoted = new Set<string>();
  const missing: string[] = [];
  for (const id of ids) {
    const m = markers.find((x) => x.id === id);
    const body = m && normalizeBody(m.text ?? stored.get(id) ?? "");
    if (!spec || !m || !body) {
      missing.push(id);
      continue;
    }
    const prefix = spec.lineSigil.slice(0, -1);
    const toComment = (line: string) => (line ? `${prefix} ${line}` : prefix);
    const eol = eolAt(source, m.end, fallbackEol);
    const text = inlineText(m, body).split("\n").map(toComment).join(eol + m.indent);
    splices.push({ start: m.start, end: m.end, text });
    promoted.add(id);
  }
  const entries = sidecar.entries
    .filter((e) => !promoted.has(e.id))
    .map((e) => ({ ...e, meta: new Map(e.meta) }));
  return { source: applySplices(source, splices), sidecar: { preamble: sidecar.preamble, entries }, missing };
}
