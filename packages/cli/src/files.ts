import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  BRAND,
  LANGUAGES,
  SIDECAR_ROOT,
  bodiesOf,
  confirmPlaced,
  findMarkers,
  languageForPath,
  parseSidecar,
  placeComments,
  promotePlaced,
  recordComments,
  serializeSidecar,
  sidecarPathFor,
  stripComments,
  type RecordResult,
  type Sidecar,
} from "@cairn-comments/core";
import { capturing, readWorkFile, removeWorkFile, writeWorkFile } from "./workfiles.js";
import { filesContaining, indexBlobs, isTracked, managedFiles, restat, smudges, stage, stagedFiles, toRepoPath, trackedFiles, worktreeGitDir } from "./git.js";

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

/** The sidecar of `file` through the `--print` overlay, so a rewrite reads its own earlier writes. */
export function readSidecarSync(root: string, file: string): Sidecar {
  const sidecarFile = path.join(root, sidecarPathFor(file));
  return parseSidecar(readWorkFile(sidecarFile)?.toString("utf8") ?? "");
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
  /** Set on a smudging worktree, where smudge keeps the seen record. */
  gitDir?: string;
}

/** How this worktree filters, read once per command or filter process. */
export function filterMode(root: string, smudging: boolean): FilterMode {
  return { gitDir: smudging ? worktreeGitDir(root) : undefined };
}

/**
 * One file through a filter endpoint, for the one-shot commands and the filter process
 * alike. Returns `input` itself when nothing changes, so non-UTF-8 passes byte for byte.
 */
export async function filterContent(endpoint: "clean" | "smudge", root: string, file: string, input: Buffer, mode: FilterMode = {}): Promise<Buffer> {
  const text = decodeExact(input);
  if (text === undefined) return input;
  let result: string;
  if (endpoint === "clean") {
    result = await stripComments(file, text);
  } else {
    const placed = await placeComments(file, text, await readSidecar(root, file));
    if (mode.gitDir) writeSeen(mode.gitDir, file, placed.placed);
    result = placed.source;
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
 * A comment-only edit cleans to the committed blob, so git never stages it; the staged set
 * grows by every file that still holds a sigil.
 */
function selectionCandidates(root: string, selection: Selection): string[] {
  if (selection.files.length) return selection.files.map((f) => toRepoPath(root, f));
  if (selection.staged) return [...new Set([...stagedFiles(root), ...filesContaining(root, SIGILS)])];
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

/** An emptied sidecar is removed rather than left as a zero-byte file. */
export function writeSidecar(root: string, file: string, sidecar: Sidecar): void {
  const sidecarFile = path.join(root, sidecarPathFor(file));
  if (!sidecar.entries.length && !sidecar.preamble) removeWorkFile(sidecarFile);
  else writeWorkFile(sidecarFile, serializeSidecar(sidecar));
}

export interface SyncOptions {
  /** Provenance merged into the metadata of every entry whose body this run writes. */
  meta?: ReadonlyMap<string, string>;
}

interface RecordFileOptions extends SyncOptions {
  afterCheckout?: boolean;
  /** Where the seen record lives; undefined where git does not smudge. */
  gitDir: string | undefined;
  /** The file's blob in HEAD. */
  head: Buffer | undefined;
}

/** Records one working file into its sidecar, writing the sidecar when it changed. */
async function recordFile(root: string, file: string, original: string, options: RecordFileOptions): Promise<RecordResult> {
  // After a checkout, comments on disk may belong to the previous commit's sidecar.
  const seen = options.gitDir && !options.afterCheckout ? readSeen(options.gitDir, file) : undefined;
  const recorded = await recordComments(file, original, readSidecarSync(root, file), {
    meta: options.meta,
    seen,
    knownOnly: options.afterCheckout,
    baseline: options.head && decodeExact(options.head),
  });
  if (recorded.sidecarChanged) writeSidecar(root, file, recorded.sidecar);
  return recorded;
}

/** The recorded file as `then` leaves it, and the ids of the comments it then shows. */
async function finish(file: string, recorded: RecordResult, then: "sync" | "expand" | "collapse"): Promise<{ source: string; onDisk: string[] }> {
  if (then === "expand") {
    const placed = await placeComments(file, await stripComments(file, recorded.source), recorded.sidecar);
    return { source: placed.source, onDisk: placed.placed };
  }
  if (then === "collapse") return { source: await stripComments(file, recorded.source), onDisk: [] };
  return { source: recorded.source, onDisk: recorded.ids };
}

/**
 * Records every file into its sidecar, then leaves its comments as they are (`sync`),
 * places all of them (`expand`), or strips them (`collapse`), and finishes with the
 * guarded re-stat. Where git smudges, the seen record follows each write.
 */
async function rewriteFiles(
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
    const bytes = readWorkFile(absolute);
    const original = bytes && decodeExact(bytes);
    if (original === undefined) continue;
    const recorded = await recordFile(root, file, original, { ...options, gitDir, head: committed.get(file) });
    const { source, onDisk } = await finish(file, recorded, then);
    if (source !== original) writeWorkFile(absolute, source);
    if (gitDir) writeSeen(gitDir, file, onDisk);
    done.push(file);
  }
  if (!capturing()) restat(root, done);
  return done;
}

export async function syncFiles(root: string, files: string[], options: SyncOptions & { add: boolean }): Promise<void> {
  const done = await rewriteFiles(root, files, "sync", options);
  // A sidecar emptied by deleting its last comment is gone from disk but still in the index; staging it records the removal.
  if (options.add) stage(root, done.map((file) => sidecarPathFor(file)).filter((s) => existsSync(path.join(root, s)) || isTracked(root, s)));
}

/** Places every comment, bringing each `[stale?]` tag up to date. */
export async function expandFiles(root: string, files: string[]): Promise<void> {
  await rewriteFiles(root, files, "expand");
}

/**
 * Brings a smudged worktree in line with its sidecars after a git operation that changed
 * them without rewriting the sources: every file with a sidecar or a leftover sigil
 * comment is placed again from the sidecar it now has.
 */
export async function refreshFiles(root: string): Promise<void> {
  const files = new Set([...filesWithSidecars(root), ...managedFiles(root, filesContaining(root, SIGILS))]);
  await rewriteFiles(root, [...files].filter((f) => existsSync(path.join(root, f))), "expand", { afterCheckout: true });
}

export async function collapseFiles(root: string, files: string[], options: SyncOptions = {}): Promise<void> {
  await rewriteFiles(root, files, "collapse", options);
}

export interface StaleReport {
  file: string;
  /** 1-based line of the comment; where the file shows no comments, the line of the code it would be placed against. */
  line: number;
  id: string;
  body: string;
}

/** Possibly stale comments across `files` (design.md § Anchoring); reads only, so CI can run it. */
export async function staleIn(root: string, files: string[]): Promise<StaleReport[]> {
  const found: StaleReport[] = [];
  const lineOf = (source: string, offset: number) => source.slice(0, offset).split("\n").length;
  for (const file of files) {
    const source = decodeExact(readFileSync(path.join(root, file)));
    if (source === undefined) continue;
    const sidecar = readSidecarSync(root, file);
    if (!sidecar.entries.length) continue;
    const placed = await placeComments(file, await stripComments(file, source), sidecar);
    const shown = new Map((await findMarkers(languageForPath(file)!, source)).map((m) => [m.id, lineOf(source, m.start)]));
    const bodies = bodiesOf(sidecar);
    for (const s of placed.stale) found.push({ file, line: shown.get(s.id) ?? s.row + 1, id: s.id, body: bodies.get(s.id) ?? "" });
  }
  return found;
}

/**
 * Records the current placement of each id in `file`, clearing its stale flag. In an agent
 * worktree the file is expanded again so its `[stale?]` tags match. Returns ids not found.
 */
export async function confirmIds(root: string, file: string, ids: string[], expand: boolean): Promise<string[]> {
  const source = decodeExact(readFileSync(path.join(root, file)));
  if (source === undefined) return ids;
  const confirmed = await confirmPlaced(file, await stripComments(file, source), readSidecarSync(root, file), ids);
  if (confirmed.missing.length) return confirmed.missing;
  if (confirmed.changed) writeSidecar(root, file, confirmed.sidecar);
  if (expand) await expandFiles(root, [file]);
  return [];
}

/** Ids of the comments that place in a working file, and so can be promoted there. */
export async function promotableIds(root: string, file: string): Promise<string[]> {
  const source = decodeExact(readFileSync(path.join(root, file)));
  const sidecar = readSidecarSync(root, file);
  if (source === undefined || !sidecar.entries.length) return [];
  return (await placeComments(file, await stripComments(file, source), sidecar)).placed;
}

/**
 * Promotes each id in `file` to an ordinary comment where it places. The file is synced
 * first, so a comment's text as shown wins over the stored body; in an agent worktree
 * (`expand`) the other comments are placed again. Returns ids not found.
 */
export async function promoteIds(root: string, file: string, ids: string[], expand: boolean): Promise<string[]> {
  await syncFiles(root, [file], { add: false });
  const absolute = path.join(root, file);
  const bytes = readWorkFile(absolute);
  const original = bytes && decodeExact(bytes);
  if (original === undefined) return ids;
  const result = await promotePlaced(file, await stripComments(file, original), readSidecarSync(root, file), ids);
  if (result.missing.length) return result.missing;
  writeSidecar(root, file, result.sidecar);
  const placed = expand ? await placeComments(file, result.source, result.sidecar) : undefined;
  const source = placed?.source ?? result.source;
  if (source !== original) writeWorkFile(absolute, source);
  if (smudges(root)) writeSeen(worktreeGitDir(root), file, placed?.placed ?? []);
  if (!capturing()) restat(root, [file]);
  return [];
}
