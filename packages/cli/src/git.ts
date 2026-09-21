import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { FILTER_DRIVER } from "@tildenote/core";

export function git(args: string[], options: { cwd?: string; input?: string } = {}): string {
  return execFileSync("git", args, {
    cwd: options.cwd,
    input: options.input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
    maxBuffer: 1 << 28,
  });
}

function nulSeparated(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

export function repoRoot(cwd = process.cwd()): string {
  return realpathSync.native(git(["rev-parse", "--show-toplevel"], { cwd }).trim());
}

/** Repo-relative, forward-slash form of a path given relative to `cwd`. */
export function toRepoPath(root: string, file: string, cwd = process.cwd()): string {
  const absolute = path.resolve(cwd, file);
  const dir = realpathSync.native(path.dirname(absolute));
  const relative = path.relative(root, path.join(dir, path.basename(absolute)));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${file} is outside the repository`);
  return relative.split(path.sep).join("/");
}

export function trackedFiles(root: string): string[] {
  return nulSeparated(git(["ls-files", "-z"], { cwd: root }));
}

export function stagedFiles(root: string): string[] {
  return nulSeparated(git(["diff", "--cached", "--name-only", "--diff-filter=ACM", "-z"], { cwd: root }));
}

/** The subset of `files` whose `filter` attribute names this tool's driver. */
export function managedFiles(root: string, files: string[]): string[] {
  if (!files.length) return [];
  const fields = nulSeparated(git(["check-attr", "-z", "--stdin", "filter"], { cwd: root, input: files.join("\0") + "\0" }));
  const managed: string[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) if (fields[i + 2] === FILTER_DRIVER) managed.push(fields[i]!);
  return managed;
}

/**
 * Re-stats index entries after a tool rewrite (design.md, spike finding 5). Guarded: an
 * entry is touched only when the file cleans to the blob already in the index, so this
 * can never stage a real change.
 */
export function restat(root: string, files: string[]): void {
  if (!files.length) return;
  const indexed = new Map<string, string>();
  for (const record of nulSeparated(git(["ls-files", "-s", "-z"], { cwd: root }))) {
    const tab = record.indexOf("\t");
    const [, hash, stage] = record.slice(0, tab).split(" ");
    if (stage === "0") indexed.set(record.slice(tab + 1), hash!);
  }
  const tracked = files.filter((f) => indexed.has(f));
  if (!tracked.length) return;
  const hashes = git(["hash-object", "--stdin-paths"], { cwd: root, input: tracked.join("\n") + "\n" }).trim().split("\n");
  const identical = tracked.filter((f, i) => hashes[i] === indexed.get(f));
  if (identical.length) git(["update-index", "-z", "--stdin"], { cwd: root, input: identical.join("\0") + "\0" });
}

export function stage(root: string, files: string[]): void {
  if (!files.length) return;
  git(["--literal-pathspecs", "add", "--pathspec-from-file=-", "--pathspec-file-nul"], { cwd: root, input: files.join("\0") + "\0" });
}
