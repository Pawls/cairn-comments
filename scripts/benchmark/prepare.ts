/**
 * The own-comments benchmark: both arms run a repository's own code, and they differ only
 * in whether its comments are there. `prepareTask` builds one parentless commit per arm
 * from a task's start commit and stores them in the mirror as `prepared/<task>/<arm>` branches.
 * No history means an agent cannot read the original comments back out of it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Arm } from "./workspace.ts";

export const STRIP_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "strip_comments.py");

/** Folders and files that carry agent instructions or plans outside the markdown. */
const AGENT_PATHS = [".claude", ".agents", ".serena", ".pawl", ".mcp.json", ".coderabbit.yaml"];

/** The one message of both arm commits, so the commit does not say which arm it is. */
const COMMIT_MESSAGE = "Initial commit";

export interface PreparedTask {
  taskId: string;
  /** What the arm commits were built from; a task file that names others makes them stale. */
  start: string;
  agentNotes: string[];
  /** Bytes the comments add to each file, `/`-separated path to size difference. */
  commentBytes: Record<string, number>;
  /** Python files that would not parse or tokenize, so they kept their comments in both arms. */
  unstripped: string[];
}

export function preparedBranch(taskId: string, arm: Arm): string {
  return `prepared/${taskId}/${arm}`;
}

function builtFrom(entry: PreparedTask, start: string, agentNotes: string[]): boolean {
  // An entry written before the start and notes were recorded has neither, and is stale.
  return entry.start === start && JSON.stringify(entry.agentNotes) === JSON.stringify(agentNotes);
}

/**
 * The prepared tasks recorded in `file`. Throws unless each of `tasks` is there and was built
 * from its start commit and from `agentNotes`.
 */
export function readPrepared(
  file: string,
  repo: string,
  tasks: Array<{ id: string; start: string }>,
  agentNotes: string[],
): Record<string, PreparedTask> {
  if (!existsSync(file)) throw new Error(`no prepared commits for ${repo}; run prepare first`);
  const prepared = JSON.parse(readFileSync(file, "utf8")) as Record<string, PreparedTask>;
  const missing = tasks.filter((task) => !prepared[task.id]).map((task) => task.id);
  if (missing.length) {
    throw new Error(`no prepared commits for ${repo} task ${missing.join(", ")}; run prepare --only ${missing.join(",")}`);
  }
  const stale = tasks.filter((task) => !builtFrom(prepared[task.id]!, task.start, agentNotes)).map((task) => task.id);
  if (stale.length) {
    throw new Error(`prepared commits for ${repo} task ${stale.join(", ")} are stale; run prepare --only ${stale.join(",")}`);
  }
  return prepared;
}

/** A Python 3 interpreter for the stripper, or undefined when the machine has none. */
export function findPython(): string | undefined {
  const candidates: Array<[string, string[]]> = [
    ["uv", ["python", "find", "3.13"]],
    ["python3", ["-c", "import sys; print(sys.executable)"]],
    ["python", ["-c", "import sys; print(sys.executable)"]],
  ];
  for (const [command, args] of candidates) {
    try {
      const found = execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (found) return found;
    } catch {
      continue;
    }
  }
  return undefined;
}

function git(cwd: string, env: Record<string, string>, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 }); // NOSONAR: git comes from PATH, as for any tool that drives git
}

function removeAgentFiles(tree: string, env: Record<string, string>): void {
  for (const file of git(tree, env, "ls-files", "-z", "*.md").split("\0").filter(Boolean)) {
    rmSync(path.join(tree, file), { force: true });
  }
  for (const name of AGENT_PATHS) rmSync(path.join(tree, name), { recursive: true, force: true });
}

/** `path -> size` of every file in `commit`. */
function fileSizes(repo: string, env: Record<string, string>, commit: string): Map<string, number> {
  const sizes = new Map<string, number>();
  // -z: without it, git quotes a path with non-ASCII characters.
  for (const entry of git(repo, env, "ls-tree", "-r", "-l", "-z", commit).split("\0")) {
    const match = /^\d+ blob \w+\s+(\d+)\t(.+)$/s.exec(entry);
    if (match) sizes.set(match[2]!, Number(match[1]));
  }
  return sizes;
}

function commentBytesBetween(repo: string, env: Record<string, string>, committed: string, stripped: string): Record<string, number> {
  const after = fileSizes(repo, env, stripped);
  const added: Record<string, number> = {};
  for (const [file, size] of fileSizes(repo, env, committed)) {
    const extra = size - (after.get(file) ?? size);
    if (extra > 0) added[file] = extra;
  }
  return added;
}

export interface PrepareOptions {
  mirror: string;
  taskId: string;
  start: string;
  python: string;
  env: Record<string, string>;
  /** The lines of the AGENTS.md both arms get in place of the repository's own instructions. */
  agentNotes: string[];
}

/** Builds the task's two arm commits in the mirror, replacing any earlier ones. */
export function prepareTask(options: PrepareOptions): PreparedTask {
  const { mirror, taskId, start, python } = options;
  const scratch = mkdtempSync(path.join(os.tmpdir(), "prepare-"));
  const tree = path.join(scratch, "tree");
  try {
    const when = git(mirror, options.env, "show", "-s", "--format=%cI", start).trim();
    const env = { ...options.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
    git(scratch, env, "clone", "--quiet", "--no-checkout", mirror, tree);
    git(tree, env, "checkout", "--quiet", "--detach", start);
    const hadReadme = existsSync(path.join(tree, "README.md"));
    removeAgentFiles(tree, env);
    // A packaging file may name the README as the project's long description.
    if (hadReadme) writeFileSync(path.join(tree, "README.md"), "# Project\n");
    writeFileSync(path.join(tree, "AGENTS.md"), options.agentNotes.map((line) => `${line}\n`).join(""));
    writeFileSync(path.join(tree, "CLAUDE.md"), "@AGENTS.md\n");

    const commitAs = (branch: string): string => {
      git(tree, env, "checkout", "--quiet", "--orphan", branch);
      git(tree, env, "add", "-A");
      git(tree, env, "commit", "--quiet", "-m", COMMIT_MESSAGE);
      return git(tree, env, "rev-parse", "HEAD").trim();
    };
    const committed = commitAs("comments");
    const summary = JSON.parse(execFileSync(python, [STRIP_SCRIPT, tree], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })) as {
      skipped: Record<string, string>;
    };
    const stripped = commitAs("none");

    const refs = (arm: Arm) => `+refs/heads/${arm}:refs/heads/${preparedBranch(taskId, arm)}`;
    git(tree, env, "push", "--quiet", mirror, refs("comments"), refs("none"));
    return {
      taskId,
      start,
      agentNotes: options.agentNotes,
      commentBytes: commentBytesBetween(mirror, env, committed, stripped),
      unstripped: Object.keys(summary.skipped),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
