import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { FILTER_DRIVER } from "@cairn-comments/core";

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

/** Output of a git command, or undefined when it fails; git's stderr is dropped. */
export function gitQuiet(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

export function repoRoot(cwd = process.cwd()): string {
  return realpathSync.native(git(["rev-parse", "--show-toplevel"], { cwd }).trim());
}

/** Every worktree of the repository that still exists on disk, main first, in `repoRoot` form. */
export function worktreeRoots(root: string): string[] {
  return git(["worktree", "list", "--porcelain"], { cwd: root })
    .split(/\r?\n/)
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
    .filter((p) => existsSync(p))
    .map((p) => realpathSync.native(p));
}

/** Whether `file` (repo-relative) is tracked in the worktree at `root`. */
export function isTracked(root: string, file: string): boolean {
  return gitQuiet(["ls-files", "--error-unmatch", "--", file], root) !== undefined;
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

/** --no-renames: a staged `git mv` must list its new path, which rename detection reports as `R`. */
export function stagedFiles(root: string, filter = "ACM"): string[] {
  return nulSeparated(
    git(["diff", "--cached", "--name-only", "--no-renames", `--diff-filter=${filter}`, "-z"], { cwd: root }),
  );
}

/** Staged renames as old path → new path, by git's own rename detection. */
export function stagedRenames(root: string): Map<string, string> {
  const fields = nulSeparated(git(["diff", "--cached", "--name-status", "-M", "--diff-filter=R", "-z"], { cwd: root }));
  const renames = new Map<string, string>();
  for (let i = 0; i + 2 < fields.length; i += 3) renames.set(fields[i + 1]!, fields[i + 2]!);
  return renames;
}

/**
 * Blobs by path, read in one `git cat-file --batch`: staged ones, or those of `rev`. Paths
 * the index or `rev` lacks are absent, as are paths with a newline, which the batch input
 * cannot carry.
 */
export function indexBlobs(root: string, files: Iterable<string>, rev = ""): Map<string, Buffer> {
  const paths = [...new Set(files)].filter((f) => !f.includes("\n"));
  const blobs = new Map<string, Buffer>();
  if (!paths.length) return blobs;
  const out = execFileSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: paths.map((p) => `${rev}:${p}\n`).join(""),
    stdio: ["pipe", "pipe", "inherit"],
    maxBuffer: 1 << 30,
  });
  let at = 0;
  for (const file of paths) {
    const eol = out.indexOf(10, at);
    const header = out.subarray(at, eol).toString("utf8");
    at = eol + 1;
    if (header.endsWith(" missing")) continue;
    const size = Number(header.split(" ")[2]);
    blobs.set(file, out.subarray(at, at + size));
    at += size + 1;
  }
  return blobs;
}

/** The subset of `files` whose `filter` attribute names this tool's driver. */
export function managedFiles(root: string, files: string[]): string[] {
  if (!files.length) return [];
  const input = files.join("\0") + "\0";
  // NUL-separated triples: path, attribute name, value.
  const fields = nulSeparated(git(["check-attr", "-z", "--stdin", "filter"], { cwd: root, input }));
  const managed: string[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i + 2] === FILTER_DRIVER) managed.push(fields[i]!);
  }
  return managed;
}

/**
 * Re-stats index entries after a tool rewrite (design.md § Git behavior, item 5). Guarded: an
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
  const hashes = git(["hash-object", "--stdin-paths"], { cwd: root, input: tracked.join("\n") + "\n" })
    .trim()
    .split("\n");
  const identical = tracked.filter((f, i) => hashes[i] === indexed.get(f));
  if (identical.length) git(["update-index", "-z", "--stdin"], { cwd: root, input: identical.join("\0") + "\0" });
}

/** An agent worktree shows every comment; everywhere else a working file holds only the code. */
export function smudges(root: string): boolean {
  try {
    return git(["config", "--get", `filter.${FILTER_DRIVER}.smudge`], { cwd: root }).trim() !== "";
  } catch {
    return false;
  }
}

/** This worktree's own git directory (`.git/worktrees/<name>` for a linked one), absolute. */
export function worktreeGitDir(root: string): string {
  return path.resolve(root, git(["rev-parse", "--git-dir"], { cwd: root }).trim());
}

/** Tracked working files containing any of `tokens` as text, strings and all. */
export function filesContaining(root: string, tokens: string[]): string[] {
  const args = ["-c", "core.quotePath=false", "grep", "-l", "-z", "-F", ...tokens.flatMap((t) => ["-e", t])];
  return nulSeparated(gitQuiet(args, root) ?? "");
}

/** Working-tree edits against the index, plus untracked files git does not ignore. */
export function changedFiles(root: string): string[] {
  return [
    ...nulSeparated(git(["diff", "--name-only", "--diff-filter=AM", "-z"], { cwd: root })),
    ...nulSeparated(git(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root })),
  ];
}

/** The staged blob of `file`, or undefined when the index has no stage-0 entry for it. */
export function indexBlob(root: string, file: string): Buffer | undefined {
  try {
    return execFileSync("git", ["cat-file", "blob", `:${file}`], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1 << 28,
    });
  } catch {
    return undefined;
  }
}

export function stage(root: string, files: string[]): void {
  if (!files.length) return;
  git(["--literal-pathspecs", "add", "--pathspec-from-file=-", "--pathspec-file-nul"], {
    cwd: root,
    input: files.join("\0") + "\0",
  });
}
