import { resolveIds } from "./ids.js";
import { languageForPath } from "./languages.js";
import { applySplices, dominantEol, type Splice } from "./lines.js";
import { STALE_TAG, findMarkers, type Marker } from "./markers.js";
import { bodiesOf, normalizeBody, type Sidecar, type SidecarEntry } from "./sidecar.js";

/** Metadata key holding the anchor hash recorded when the body was last written or confirmed. */
export const ANCHOR_KEY = "anchor";

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
 * (design.md, spike finding 2); comments that already carry text are left as written.
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
    const eol = source.startsWith("\r\n", m.end) ? "\r\n" : source[m.end] === "\n" ? "\n" : fallbackEol;
    const continuation = rest.map((l) => eol + m.indent + spec.lineSigil + (l ? " " + l : ""));
    splices.push({ start: m.start, end: m.end, text: `${spec.lineSigil}${m.id!} ${tag}${first!}${continuation.join("")}` });
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
 * orphans (A9).
 */
export async function sync(path: string, source: string, sidecar: Sidecar, options: SyncOptions = {}): Promise<SyncResult> {
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
  markers.forEach((m, i) => {
    const id = ids[i]!;
    if (m.id !== id) {
      const idStart = m.start + spec.lineSigil.length;
      splices.push({ start: idStart, end: idStart + (m.id?.length ?? 0), text: id });
    }
    const known = stored.get(id);
    const text = m.text === undefined ? undefined : normalizeBody(m.text);
    // A multi-line body flattened onto a trailing marker is not an edit.
    if (text === undefined || (known !== undefined && inlineText(m, known) === text)) {
      const entry = entries.find((e) => e.id === id);
      if (entry?.body && typeof m.anchor === "string" && !entry.meta.has(ANCHOR_KEY)) sidecarChanged = setAnchor(entry, m.anchor) || sidecarChanged;
      return;
    }
    let entry = entries.find((e) => e.id === id);
    if (!entry) entries.push((entry = { id, meta: new Map(), body: text }));
    entry.body = text;
    // Provenance names the last writer of the body, so an edit replaces it.
    for (const [k, v] of options.meta ?? []) entry.meta.set(k, v);
    setAnchor(entry, m.anchor);
    stored.set(id, text);
    sidecarChanged = true;
  });

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
    if (m.id && isStale(m, anchors.get(m.id), bodies.get(m.id))) stale.push({ id: m.id, marker: m, body: bodies.get(m.id)! });
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
export async function confirm(path: string, source: string, sidecar: Sidecar, ids: readonly string[]): Promise<ConfirmResult> {
  const spec = languageForPath(path);
  const markers = spec ? await findMarkers(spec, source, { anchors: true }) : [];
  const entries = sidecar.entries.map((e) => ({ ...e, meta: new Map(e.meta) }));
  let changed = false;
  const missing: string[] = [];
  for (const id of ids) {
    const marker = markers.find((m) => m.id === id);
    const entry = entries.find((e) => e.id === id);
    if (!marker || !entry) missing.push(id);
    else changed = setAnchor(entry, marker.anchor) || changed;
  }
  return { sidecar: { preamble: sidecar.preamble, entries }, changed, missing };
}
