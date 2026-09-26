import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  BRAND,
  LANGUAGES,
  SIDECAR_ROOT,
  anchorsOf,
  bodiesOf,
  clean,
  confirm,
  confirmPlaced,
  findMarkers,
  languageForPath,
  parseSidecar,
  placeComments,
  promote,
  recordComments,
  serializeSidecar,
  sidecarPathFor,
  smudge,
  staleMarkers,
  stripComments,
  sync,
  type Sidecar,
  type SyncOptions,
} from "@cairn-comments/core";
import { filesContaining, indexBlobs, managedFiles, markerless, restat, smudges, stage, stagedFiles, toRepoPath, trackedFiles, worktreeGitDir } from "./git.js";

/** Text of a buffer, or undefined when it is not UTF-8 that re-encodes to the same bytes. */
export function decodeExact(bytes: Buffer): string | undefined {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : undefined;
}

/**
 * Async and a single open: on Windows each open costs ~0.45 ms, and the filter process
 * overlaps them.
 */
export async function readSidecar(root: string, file: string): Promise<Sidecar> {
  try {
    return parseSidecar(await readFile(path.join(root, sidecarPathFor(file)), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { preamble: "", entries: [] };
    throw error;
  }
}

function readSidecarSync(root: string, file: string): Sidecar {
  const sidecarFile = path.join(root, sidecarPathFor(file));
  return parseSidecar(existsSync(sidecarFile) ? readFileSync(sidecarFile, "utf8") : "");
}

function smudgeFrom(file: string, source: string, sidecar: Sidecar): Promise<string> {
  return smudge(file, source, bodiesOf(sidecar), anchorsOf(sidecar));
}

/**
 * Ids the tool last wrote into a working file of a smudged worktree, kept under that
 * worktree's git dir: what `recordComments` needs to tell a deleted comment from one that
 * was never placed (design.md § Anchoring).
 */
function seenPath(gitDir: string, file: string): string {
  return path.join(gitDir, BRAND, "seen", createHash("sha1").update(file).digest("hex"));
}

function readSeen(gitDir: string, file: string): Set<string> {
  const record = seenPath(gitDir, file);
  return new Set(existsSync(record) ? readFileSync(record, "utf8").split("\n").filter(Boolean) : []);
}

function writeSeen(gitDir: string, file: string, ids: readonly string[]): void {
  const record = seenPath(gitDir, file);
  if (!ids.length) {
    rmSync(record, { force: true });
    return;
  }
  mkdirSync(path.dirname(record), { recursive: true });
  writeFileSync(record, ids.join("\n") + "\n");
}

export interface FilterMode {
  markerless: boolean;
  /** Set on a smudging worktree in markerless mode, where smudge keeps the seen record. */
  gitDir?: string;
}

/** How this worktree filters, read once per command or filter process. */
export function filterMode(root: string, smudging: boolean): FilterMode {
  const on = markerless(root);
  return { markerless: on, gitDir: on && smudging ? worktreeGitDir(root) : undefined };
}

/**
 * One file through a filter endpoint, for the one-shot commands and the filter process
 * alike. Returns `input` itself when nothing changes, so non-UTF-8 passes byte for byte.
 */
export async function filterContent(
  endpoint: "clean" | "smudge",
  root: string,
  file: string,
  input: Buffer,
  mode: FilterMode = { markerless: false },
): Promise<Buffer> {
  const text = decodeExact(input);
  if (text === undefined) return input;
  let result: string;
  if (endpoint === "clean") {
    result = mode.markerless ? await stripComments(file, text) : await clean(file, text);
  } else if (mode.markerless) {
    const placed = await placeComments(file, text, await readSidecar(root, file));
    if (mode.gitDir) writeSeen(mode.gitDir, file, placed.placed);
    result = placed.source;
  } else {
    result = await smudgeFrom(file, text, await readSidecar(root, file));
  }
  return result === text ? input : Buffer.from(result, "utf8");
}

export interface Selection {
  files: string[];
  staged: boolean;
}

/** Named files, the staged set, or every tracked file; always narrowed to managed ones. */
export function selectFiles(root: string, selection: Selection): string[] {
  const candidates = selectionCandidates(root, selection);
  return managedFiles(root, candidates).filter((f) => existsSync(path.join(root, f)));
}

const SIGILS = [...new Set(LANGUAGES.map((l) => l.lineSigil))];

/**
 * In markerless mode a comment-only edit cleans to the committed blob, so git never
 * stages it; the staged set grows by every file that still holds a sigil.
 */
function selectionCandidates(root: string, selection: Selection): string[] {
  if (selection.files.length) return selection.files.map((f) => toRepoPath(root, f));
  if (selection.staged) return markerless(root) ? [...new Set([...stagedFiles(root), ...filesContaining(root, SIGILS)])] : stagedFiles(root);
  return trackedFiles(root);
}

/** Sources whose tracked sidecar exists: every file a refresh could place comments in. */
function filesWithSidecars(root: string): string[] {
  const prefix = `${SIDECAR_ROOT}/`;
  const sources = trackedFiles(root)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".md"))
    .map((f) => f.slice(prefix.length, -".md".length));
  return managedFiles(root, sources).filter((f) => existsSync(path.join(root, f)));
}

/** A new source, or a new source and sidecar when the rewrite moves bodies itself. */
type Rewrite = (file: string, source: string, sidecar: Sidecar) => Promise<string | Rewritten>;

interface Rewritten {
  source: string;
  sidecar: Sidecar;
}

/**
 * Syncs each working file into its sidecar, optionally rewrites the file, and finishes
 * with the guarded re-stat. Sync always runs first so a rewrite never drops a body that
 * exists only inline, and never meets a comment that still lacks an id.
 */
async function rewriteFiles(
  root: string,
  files: string[],
  rewrite?: Rewrite,
  options: SyncOptions = {},
): Promise<string[]> {
  const done: string[] = [];
  for (const file of files) {
    const absolute = path.join(root, file);
    const original = decodeExact(readFileSync(absolute));
    if (original === undefined) continue;
    const synced = await sync(file, original, readSidecarSync(root, file), options);
    if (synced.sidecarChanged) writeSidecar(root, file, synced.sidecar);
    const rewritten = rewrite ? await rewrite(file, synced.source, synced.sidecar) : synced.source;
    const source = typeof rewritten === "string" ? rewritten : rewritten.source;
    if (typeof rewritten !== "string") writeSidecar(root, file, rewritten.sidecar);
    if (source !== original) writeFileSync(absolute, source);
    done.push(file);
  }
  restat(root, done);
  return done;
}

/** An emptied sidecar is removed rather than left as a zero-byte file. */
export function writeSidecar(root: string, file: string, sidecar: Sidecar): void {
  const sidecarFile = path.join(root, sidecarPathFor(file));
  if (!sidecar.entries.length && !sidecar.preamble) {
    rmSync(sidecarFile, { force: true });
    return;
  }
  mkdirSync(path.dirname(sidecarFile), { recursive: true });
  writeFileSync(sidecarFile, serializeSidecar(sidecar));
}

/**
 * The markerless counterpart of `rewriteFiles`: records every file, then leaves its
 * comments as they are (`sync`), places all of them (`expand`), or strips them
 * (`collapse`). Where git smudges, the seen record follows each write.
 */
async function rewriteMarkerless(
  root: string,
  files: string[],
  then: "sync" | "expand" | "collapse",
  options: SyncOptions & { afterCheckout?: boolean } = {},
): Promise<string[]> {
  const gitDir = smudges(root) ? worktreeGitDir(root) : undefined;
  // What HEAD holds tells an edit made here from one that arrived by merge or checkout.
  const committed = indexBlobs(root, files, "HEAD");
  const done: string[] = [];
  for (const file of files) {
    const absolute = path.join(root, file);
    const original = decodeExact(readFileSync(absolute));
    if (original === undefined) continue;
    // After a checkout, comments on disk may belong to the previous commit's sidecar.
    const seen = gitDir && !options.afterCheckout ? readSeen(gitDir, file) : undefined;
    const head = committed.get(file);
    const recorded = await recordComments(file, original, readSidecarSync(root, file), {
      meta: options.meta,
      seen,
      knownOnly: options.afterCheckout,
      baseline: head && decodeExact(head),
    });
    if (recorded.sidecarChanged) writeSidecar(root, file, recorded.sidecar);
    let source = recorded.source;
    let onDisk = recorded.ids;
    if (then === "expand") {
      const placed = await placeComments(file, await stripComments(file, source), recorded.sidecar);
      source = placed.source;
      onDisk = placed.placed;
    } else if (then === "collapse") {
      source = await stripComments(file, source);
      onDisk = [];
    }
    if (source !== original) writeFileSync(absolute, source);
    if (gitDir) writeSeen(gitDir, file, onDisk);
    done.push(file);
  }
  restat(root, done);
  return done;
}

export async function syncFiles(root: string, files: string[], options: SyncOptions & { add: boolean }): Promise<void> {
  const done = markerless(root) ? await rewriteMarkerless(root, files, "sync", options) : await rewriteFiles(root, files, undefined, options);
  if (options.add) stage(root, done.map(sidecarPathFor).filter((s) => existsSync(path.join(root, s))));
}

/** Expands bare markers and brings every `[stale?]` tag up to date; in markerless mode, places every comment. */
export async function expandFiles(root: string, files: string[]): Promise<void> {
  if (markerless(root)) await rewriteMarkerless(root, files, "expand");
  else await rewriteFiles(root, files, smudgeFrom);
}

/**
 * Brings a smudged markerless worktree in line with its sidecars after a git operation
 * that changed them without rewriting the sources: every file with a sidecar or a
 * leftover sigil comment is placed again from the sidecar it now has.
 */
export async function refreshFiles(root: string): Promise<void> {
  const files = new Set([...filesWithSidecars(root), ...managedFiles(root, filesContaining(root, SIGILS))]);
  await rewriteMarkerless(root, [...files].filter((f) => existsSync(path.join(root, f))), "expand", { afterCheckout: true });
}

export async function collapseFiles(root: string, files: string[], options: SyncOptions = {}): Promise<void> {
  if (markerless(root)) await rewriteMarkerless(root, files, "collapse", options);
  else await rewriteFiles(root, files, (file, source) => clean(file, source), options);
}

export interface StaleReport {
  file: string;
  /**
   * 1-based line of the comment; in markerless mode, where the file shows no comments, the
   * line of the code it would be placed against.
   */
  line: number;
  id: string;
  body: string;
}

/** Possibly stale comments across `files` (design.md § Staleness); reads only, so CI can run it. */
export async function staleIn(root: string, files: string[]): Promise<StaleReport[]> {
  const found: StaleReport[] = [];
  const lineOf = (source: string, offset: number) => source.slice(0, offset).split("\n").length;
  for (const file of files) {
    const source = decodeExact(readFileSync(path.join(root, file)));
    if (source === undefined) continue;
    const sidecar = readSidecarSync(root, file);
    if (!markerless(root)) {
      for (const s of await staleMarkers(file, source, sidecar)) found.push({ file, line: lineOf(source, s.marker.start), id: s.id, body: s.body });
      continue;
    }
    if (!sidecar.entries.length) continue;
    const placed = await placeComments(file, await stripComments(file, source), sidecar);
    const shown = new Map((await findMarkers(languageForPath(file)!, source)).map((m) => [m.id, lineOf(source, m.start)]));
    const bodies = bodiesOf(sidecar);
    for (const s of placed.stale) found.push({ file, line: shown.get(s.id) ?? s.row + 1, id: s.id, body: bodies.get(s.id) ?? "" });
  }
  return found;
}

/**
 * Records the current anchor for each id in `file`, clearing its stale flag. In an agent
 * worktree the file is expanded again so its `[stale?]` tags match. Returns ids not found.
 */
export async function confirmIds(root: string, file: string, ids: string[], expand: boolean): Promise<string[]> {
  const source = decodeExact(readFileSync(path.join(root, file)));
  if (source === undefined) return ids;
  if (markerless(root)) {
    const confirmed = await confirmPlaced(file, await stripComments(file, source), readSidecarSync(root, file), ids);
    if (confirmed.missing.length) return confirmed.missing;
    if (confirmed.changed) writeSidecar(root, file, confirmed.sidecar);
    if (expand) await expandFiles(root, [file]);
    return [];
  }
  const result = await confirm(file, source, readSidecarSync(root, file), ids);
  if (result.changed) writeSidecar(root, file, result.sidecar);
  if (expand) await expandFiles(root, [file]);
  return result.missing;
}

/** Ids of the markers in a working file that have a body to promote, inline or stored. */
export async function promotableIds(root: string, file: string): Promise<string[]> {
  const spec = languageForPath(file);
  const source = decodeExact(readFileSync(path.join(root, file)));
  if (!spec || source === undefined) return [];
  const bodies = bodiesOf(readSidecarSync(root, file));
  const ids = new Set<string>();
  for (const m of await findMarkers(spec, source)) {
    if (m.id && (m.text || bodies.get(m.id))) ids.add(m.id);
  }
  return [...ids];
}

/**
 * Promotes each id in `file` to an ordinary comment. Outside an agent worktree the rest
 * of the file is collapsed as well, as `collapse` would. Returns ids not found.
 */
export async function promoteIds(root: string, file: string, ids: string[], expand: boolean): Promise<string[]> {
  let missing: string[] = [];
  await rewriteFiles(root, [file], async (f, source, sidecar) => {
    const result = await promote(f, source, sidecar, ids);
    missing = result.missing;
    if (missing.length) return source;
    return { source: expand ? result.source : await clean(f, result.source), sidecar: result.sidecar };
  });
  return missing;
}
