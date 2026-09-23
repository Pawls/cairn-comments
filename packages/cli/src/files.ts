import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  anchorsOf,
  bodiesOf,
  clean,
  confirm,
  parseSidecar,
  promote,
  serializeSidecar,
  sidecarPathFor,
  smudge,
  staleMarkers,
  sync,
  type Sidecar,
  type StaleMarker,
  type SyncOptions,
} from "@slopstash/core";
import { managedFiles, restat, stage, stagedFiles, toRepoPath, trackedFiles } from "./git.js";

/** Text of a buffer, or undefined when it is not UTF-8 that re-encodes to the same bytes. */
export function decodeExact(bytes: Buffer): string | undefined {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : undefined;
}

/** Async and a single open: on Windows each open costs ~0.45 ms, and the filter process overlaps them. */
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

/**
 * One file through a filter endpoint, for the one-shot commands and the filter process
 * alike. Returns `input` itself when nothing changes, so non-UTF-8 passes byte for byte.
 */
export async function filterContent(mode: "clean" | "smudge", root: string, file: string, input: Buffer): Promise<Buffer> {
  const text = decodeExact(input);
  if (text === undefined) return input;
  let result: string;
  if (mode === "clean") result = await clean(file, text);
  else {
    const sidecar = await readSidecar(root, file);
    result = await smudge(file, text, bodiesOf(sidecar), anchorsOf(sidecar));
  }
  return result === text ? input : Buffer.from(result, "utf8");
}

export interface Selection {
  files: string[];
  staged: boolean;
}

/** Named files, the staged set, or every tracked file; always narrowed to managed ones. */
export function selectFiles(root: string, selection: Selection): string[] {
  const candidates = selection.files.length
    ? selection.files.map((f) => toRepoPath(root, f))
    : selection.staged
      ? stagedFiles(root)
      : trackedFiles(root);
  return managedFiles(root, candidates).filter((f) => existsSync(path.join(root, f)));
}

/** A new source, or a new source and sidecar when the rewrite moves bodies itself. */
type Rewrite = (file: string, source: string, sidecar: Sidecar) => Promise<string | { source: string; sidecar: Sidecar }>;

/**
 * Syncs each working file into its sidecar, optionally rewrites the file, and finishes
 * with the guarded re-stat. Sync always runs first so a rewrite never drops a body that
 * exists only inline, and never meets a comment that still lacks an id.
 */
async function rewriteFiles(root: string, files: string[], rewrite?: Rewrite, options: SyncOptions = {}): Promise<string[]> {
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
function writeSidecar(root: string, file: string, sidecar: Sidecar): void {
  const sidecarFile = path.join(root, sidecarPathFor(file));
  if (!sidecar.entries.length && !sidecar.preamble) {
    rmSync(sidecarFile, { force: true });
    return;
  }
  mkdirSync(path.dirname(sidecarFile), { recursive: true });
  writeFileSync(sidecarFile, serializeSidecar(sidecar));
}

export async function syncFiles(root: string, files: string[], options: SyncOptions & { add: boolean }): Promise<void> {
  const done = await rewriteFiles(root, files, undefined, options);
  if (options.add) stage(root, done.map(sidecarPathFor).filter((s) => existsSync(path.join(root, s))));
}

/** Expands bare markers and brings every `[stale?]` tag up to date. */
export async function expandFiles(root: string, files: string[]): Promise<void> {
  await rewriteFiles(root, files, (file, source, sidecar) => smudge(file, source, bodiesOf(sidecar), anchorsOf(sidecar)));
}

export async function collapseFiles(root: string, files: string[], options: SyncOptions = {}): Promise<void> {
  await rewriteFiles(root, files, (file, source) => clean(file, source), options);
}

export interface StaleReport extends StaleMarker {
  file: string;
  /** 1-based line of the marker. */
  line: number;
}

/** Possibly stale comments across `files` (design.md § Staleness); reads only, so CI can run it. */
export async function staleIn(root: string, files: string[]): Promise<StaleReport[]> {
  const found: StaleReport[] = [];
  for (const file of files) {
    const source = decodeExact(readFileSync(path.join(root, file)));
    if (source === undefined) continue;
    for (const s of await staleMarkers(file, source, readSidecarSync(root, file))) {
      found.push({ ...s, file, line: source.slice(0, s.marker.start).split("\n").length });
    }
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
  const result = await confirm(file, source, readSidecarSync(root, file), ids);
  if (result.changed) writeSidecar(root, file, result.sidecar);
  if (expand) await expandFiles(root, [file]);
  return result.missing;
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
