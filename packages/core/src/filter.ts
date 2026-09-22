import { resolveIds } from "./ids.js";
import { languageForPath } from "./languages.js";
import { applySplices, dominantEol, type Splice } from "./lines.js";
import { findMarkers, type Marker } from "./markers.js";
import { bodiesOf, normalizeBody, type Sidecar } from "./sidecar.js";

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
 * Expands bare markers from stored bodies. A marker with no body yet stays bare
 * (design.md, spike finding 2); comments that already carry text are left as written.
 */
export async function smudge(path: string, source: string, bodies: ReadonlyMap<string, string>): Promise<string> {
  const spec = languageForPath(path);
  if (!spec) return source;
  const markers = await findMarkers(spec, source);
  const fallbackEol = dominantEol(source);
  const splices: Splice[] = [];
  for (const m of markers) {
    const body = m.kind === "bare" ? normalizeBody(bodies.get(m.id!) ?? "") : "";
    if (!body) continue;
    const [first, ...rest] = inlineText(m, body).split("\n");
    // New lines reuse the marker line's own terminator, so clean restores it exactly.
    const eol = source.startsWith("\r\n", m.end) ? "\r\n" : source[m.end] === "\n" ? "\n" : fallbackEol;
    const continuation = rest.map((l) => eol + m.indent + spec.lineSigil + (l ? " " + l : ""));
    splices.push({ start: m.start, end: m.end, text: `${spec.lineSigil}${m.id!} ${first!}${continuation.join("")}` });
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

/**
 * Moves comment bodies from an expanded working file into its sidecar and stamps ids
 * onto new comments. Entries whose marker is gone are kept; `check` owns orphans (A9).
 */
export async function sync(path: string, source: string, sidecar: Sidecar, options: SyncOptions = {}): Promise<SyncResult> {
  const unchanged = { source, sidecar, sourceChanged: false, sidecarChanged: false };
  const spec = languageForPath(path);
  if (!spec) return unchanged;
  const markers = await findMarkers(spec, source);
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
    if (m.text === undefined) return;
    const text = normalizeBody(m.text);
    const known = stored.get(id);
    // A multi-line body flattened onto a trailing marker is not an edit.
    if (known !== undefined && inlineText(m, known) === text) return;
    let entry = entries.find((e) => e.id === id);
    if (!entry) entries.push((entry = { id, meta: new Map(), body: text }));
    entry.body = text;
    // Provenance names the last writer of the body, so an edit replaces it.
    for (const [k, v] of options.meta ?? []) entry.meta.set(k, v);
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
