import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { bodiesOf, clean, parseSidecar, serializeSidecar, sidecarPathFor, smudge, sync } from "@slopstash/core";
import { managedFiles, restat, stage, stagedFiles, toRepoPath, trackedFiles } from "./git.js";

/** Text of a buffer, or undefined when it is not UTF-8 that re-encodes to the same bytes. */
export function decodeExact(bytes: Buffer): string | undefined {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : undefined;
}

/** Async and a single open: on Windows each open costs ~0.45 ms, and the filter process overlaps them. */
export async function readBodies(root: string, file: string): Promise<Map<string, string>> {
  try {
    return bodiesOf(parseSidecar(await readFile(path.join(root, sidecarPathFor(file)), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
}

/**
 * One file through a filter endpoint, for the one-shot commands and the filter process
 * alike. Returns `input` itself when nothing changes, so non-UTF-8 passes byte for byte.
 */
export async function filterContent(mode: "clean" | "smudge", root: string, file: string, input: Buffer): Promise<Buffer> {
  const text = decodeExact(input);
  if (text === undefined) return input;
  const result = mode === "clean" ? await clean(file, text) : await smudge(file, text, await readBodies(root, file));
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

type Rewrite = (file: string, source: string, bodies: Map<string, string>) => Promise<string>;

/**
 * Syncs each working file into its sidecar, optionally rewrites the file, and finishes
 * with the guarded re-stat. Sync always runs first so a rewrite never drops a body that
 * exists only inline, and never meets a comment that still lacks an id.
 */
async function rewriteFiles(root: string, files: string[], rewrite?: Rewrite): Promise<string[]> {
  const done: string[] = [];
  for (const file of files) {
    const absolute = path.join(root, file);
    const original = decodeExact(readFileSync(absolute));
    if (original === undefined) continue;
    const sidecarFile = path.join(root, sidecarPathFor(file));
    const stored = parseSidecar(existsSync(sidecarFile) ? readFileSync(sidecarFile, "utf8") : "");
    const synced = await sync(file, original, stored);
    if (synced.sidecarChanged) {
      mkdirSync(path.dirname(sidecarFile), { recursive: true });
      writeFileSync(sidecarFile, serializeSidecar(synced.sidecar));
    }
    const source = rewrite ? await rewrite(file, synced.source, bodiesOf(synced.sidecar)) : synced.source;
    if (source !== original) writeFileSync(absolute, source);
    done.push(file);
  }
  restat(root, done);
  return done;
}

export async function syncFiles(root: string, files: string[], options: { add: boolean }): Promise<void> {
  const done = await rewriteFiles(root, files);
  if (options.add) stage(root, done.map(sidecarPathFor).filter((s) => existsSync(path.join(root, s))));
}

export async function expandFiles(root: string, files: string[]): Promise<void> {
  await rewriteFiles(root, files, smudge);
}

export async function collapseFiles(root: string, files: string[]): Promise<void> {
  await rewriteFiles(root, files, (file, source) => clean(file, source));
}
