// Sharing a private store (design.md § Private mode): `refs/<brand>/comments` holds commits of
// the store's files, made with plumbing so neither the index nor a branch is ever touched.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BRAND, hasConflictMarkers, mergeSidecars, parseSidecar, privateSidecarDir } from "@cairn-comments/core";
import { refreshFiles, sidecarSources, writeSidecar } from "./files.js";
import { git, gitQuiet, indexBlobs, smudges, worktreeRoots } from "./git.js";

export const COMMENTS_REF = `refs/${BRAND}/comments`;

/** Where `fetch` keeps what it last fetched from `remote`, the way git keeps remote-tracking branches. */
const remoteRef = (remote: string) => `refs/${BRAND}/remotes/${remote}/comments`;

export interface FetchReport {
  summary: string;
  /** `<source>:<id>` for each comment whose body both sides changed; the body holds conflict markers. */
  conflicts: string[];
}

function storeOf(root: string): string {
  const store = privateSidecarDir(root);
  if (!store) throw new Error(`push and fetch share a private store; run \`${BRAND} init --private\` first`);
  return store;
}

function refCommit(root: string, ref: string): string | undefined {
  return gitQuiet(["rev-parse", "--verify", "-q", `${ref}^{commit}`], root)?.trim() || undefined;
}

function isAncestor(root: string, older: string, newer: string): boolean {
  return gitQuiet(["merge-base", "--is-ancestor", older, newer], root) !== undefined;
}

/** File names in a commit's tree, relative to the store. */
function filesIn(root: string, commit: string): string[] {
  return git(["ls-tree", "-r", "-z", "--name-only", commit], { cwd: root })
    .split("\0")
    .filter(Boolean);
}

/** A tree of the store's files, built in a scratch index so the worktree's own index is never touched. */
function storeTree(root: string, store: string): string {
  const files = sidecarSources(root).map((source) => `${source}.md`);
  const index = path.join(path.dirname(store), "share-index");
  rmSync(index, { force: true });
  const env = { ...process.env, GIT_INDEX_FILE: index };
  if (files.length) {
    const input = files.map((f) => path.join(store, f)).join("\n") + "\n";
    const hashes = git(["hash-object", "-w", "--no-filters", "--stdin-paths"], { cwd: root, input }).trim().split("\n");
    const entries = files.map((f, i) => `100644 ${hashes[i]}\t${f}\0`).join("");
    git(["update-index", "--add", "-z", "--index-info"], { cwd: root, env, input: entries });
  }
  const tree = git(["write-tree"], { cwd: root, env }).trim();
  rmSync(index, { force: true });
  return tree;
}

/**
 * Commits the store onto the comments ref when it differs from the ref's tree, with `merged`
 * as a second parent after a merge. Returns the ref's commit afterwards; undefined while
 * there is neither a ref nor anything in the store.
 */
function recordStore(root: string, store: string, merged?: string): string | undefined {
  const head = refCommit(root, COMMENTS_REF);
  const tree = storeTree(root, store);
  if (!merged && head && git(["rev-parse", `${head}^{tree}`], { cwd: root }).trim() === tree) return head;
  if (!merged && !head && !sidecarSources(root).length) return undefined;
  const parents = [head, merged].filter((p): p is string => p !== undefined);
  const commit = git(["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", `${BRAND} comments`], {
    cwd: root,
  }).trim();
  // The old value guards against another worktree moving the ref meanwhile; "" means it must not exist.
  git(["update-ref", COMMENTS_REF, commit, head ?? ""], { cwd: root });
  return commit;
}

/**
 * `<source>:<id>` for each stored comment whose body still holds the conflict markers a fetch
 * left, and `<source>:(preamble)` for a sidecar whose preamble does, as fetch reports them.
 */
function unresolvedConflicts(root: string, store: string): string[] {
  const found: string[] = [];
  for (const source of sidecarSources(root)) {
    const sidecar = parseSidecar(readFileSync(path.join(store, `${source}.md`), "utf8"));
    if (hasConflictMarkers(sidecar.preamble)) found.push(`${source}:(preamble)`);
    for (const entry of sidecar.entries) {
      if (hasConflictMarkers(entry.body)) found.push(`${source}:${entry.id}`);
    }
  }
  return found;
}

/** What to do about each conflict: `sync` rewrites a comment's body, but a preamble is edited in its file. */
function conflictAdvice(conflicts: string[], store: string): string {
  const preamble = ":(preamble)";
  const advice = [`resolve the conflict markers in ${conflicts.join(", ")} first`];
  if (conflicts.some((c) => !c.endsWith(preamble))) advice.push("rewrite each comment as it should read, and sync");
  for (const conflict of conflicts.filter((c) => c.endsWith(preamble))) {
    const file = path.join(store, conflict.slice(0, -preamble.length) + ".md");
    advice.push(`edit the preamble in ${file}`);
  }
  return advice.join("; ");
}

/**
 * Commits the store and pushes the comments ref to `remote`. Returns the report line.
 * Refuses while a fetch's conflict markers remain, so they never reach anyone else.
 */
export function pushComments(root: string, remote: string): string {
  const store = storeOf(root);
  const conflicts = unresolvedConflicts(root, store);
  if (conflicts.length) throw new Error(conflictAdvice(conflicts, store));
  const commit = recordStore(root, store);
  if (!commit) return "nothing to push: there are no comments yet\n";
  const pushed = spawnSync("git", ["push", "-q", remote, `${COMMENTS_REF}:${COMMENTS_REF}`], {
    cwd: root,
    encoding: "utf8",
  });
  if (pushed.status !== 0) {
    if (pushed.stderr.includes("[rejected]"))
      throw new Error(`${remote} has comments this clone does not; run \`${BRAND} fetch ${remote}\`, then push again`);
    throw new Error(pushed.stderr.trim() || `git push to ${remote} failed`);
  }
  git(["update-ref", remoteRef(remote), commit], { cwd: root });
  return `pushed the comments to ${remote}\n`;
}

/**
 * Fetches `remote`'s comments ref and brings the store up to date with it: a fast-forward
 * when only one side moved, else a merge by entry with the sidecar merge driver's rules,
 * committed with both sides as parents so the next push is a fast-forward. Every smudged
 * worktree then places the comments again.
 */
export async function fetchComments(root: string, remote: string): Promise<FetchReport> {
  const store = storeOf(root);
  const fetched = spawnSync("git", ["fetch", "-q", remote, `+${COMMENTS_REF}:${remoteRef(remote)}`], {
    cwd: root,
    encoding: "utf8",
  });
  if (fetched.status !== 0) {
    if (/couldn't find remote ref/i.test(fetched.stderr))
      return { summary: `${remote} has no comments yet\n`, conflicts: [] };
    throw new Error(fetched.stderr.trim() || `git fetch from ${remote} failed`);
  }
  const theirs = refCommit(root, remoteRef(remote));
  const ours = recordStore(root, store);
  if (!theirs || (ours && isAncestor(root, theirs, ours)))
    return { summary: `the comments are up to date with ${remote}\n`, conflicts: [] };
  let report: FetchReport;
  if (!ours || isAncestor(root, ours, theirs)) {
    replaceStore(root, store, theirs);
    git(["update-ref", COMMENTS_REF, theirs, ours ?? ""], { cwd: root });
    report = { summary: `updated the comments from ${remote}\n`, conflicts: [] };
  } else {
    const conflicts = mergeIntoStore(root, store, ours, theirs);
    recordStore(root, store, theirs);
    report = { summary: `merged the comments from ${remote}\n`, conflicts };
  }
  for (const worktree of worktreeRoots(root).filter((worktree) => smudges(worktree))) await refreshFiles(worktree);
  return report;
}

/** Makes the store hold exactly the files of `commit`, byte for byte, so its tree matches the commit's. */
function replaceStore(root: string, store: string, commit: string): void {
  const files = filesIn(root, commit);
  const wanted = new Set(files);
  for (const source of sidecarSources(root)) {
    if (!wanted.has(`${source}.md`)) rmSync(path.join(store, `${source}.md`), { force: true });
  }
  for (const [file, bytes] of indexBlobs(root, files, commit)) writeFileOrRemove(path.join(store, file), bytes);
}

/** Three-way merges each sidecar the two commits disagree on into the store; returns the conflicts. */
function mergeIntoStore(root: string, store: string, ours: string, theirs: string): string[] {
  const base = gitQuiet(["merge-base", ours, theirs], root)?.trim();
  const files = [...new Set([...filesIn(root, ours), ...filesIn(root, theirs)])];
  const baseBlobs = base ? indexBlobs(root, files, base) : new Map<string, Buffer>();
  const ourBlobs = indexBlobs(root, files, ours);
  const theirBlobs = indexBlobs(root, files, theirs);
  const conflicts: string[] = [];
  for (const file of files) {
    const baseText = baseBlobs.get(file)?.toString("utf8");
    const ourText = ourBlobs.get(file)?.toString("utf8");
    const theirText = theirBlobs.get(file)?.toString("utf8");
    // The store already holds ours: nothing to do when both sides agree or only ours changed.
    if (ourText === theirText || theirText === baseText) continue;
    const target = path.join(store, file);
    if (ourText === baseText) {
      writeFileOrRemove(target, theirBlobs.get(file));
      continue;
    }
    const source = file.slice(0, -".md".length);
    const merged = mergeSidecars(
      parseSidecar(baseText ?? ""),
      parseSidecar(ourText ?? ""),
      parseSidecar(theirText ?? ""),
    );
    writeSidecar(root, source, merged.sidecar);
    conflicts.push(...merged.conflicts.map((id) => `${source}:${id}`));
  }
  return conflicts;
}

/** Writes `bytes` to `file`, creating its folder; undefined removes the file. */
function writeFileOrRemove(file: string, bytes: Buffer | undefined): void {
  if (!bytes) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}
