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

export interface PreparedTask {
  taskId: string;
  /** Bytes the comments add to each file, `/`-separated path to size difference. */
  commentBytes: Record<string, number>;
  /** Python files that would not parse or tokenize, so they kept their comments in both arms. */
  unstripped: string[];
}

export function preparedBranch(taskId: string, arm: Arm): string {
  return `prepared/${taskId}/${arm}`;
}

/** The prepared tasks recorded in `file`; throws unless every one of `taskIds` is there. */
export function readPrepared(file: string, repo: string, taskIds: string[]): Record<string, PreparedTask> {
  if (!existsSync(file)) throw new Error(`no prepared commits for ${repo}; run prepare first`);
  const prepared = JSON.parse(readFileSync(file, "utf8")) as Record<string, PreparedTask>;
  const missing = taskIds.filter((id) => !prepared[id]);
  if (missing.length) {
    throw new Error(`no prepared commits for ${repo} task ${missing.join(", ")}; run prepare --only ${missing.join(",")}`);
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
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
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
  for (const line of git(repo, env, "ls-tree", "-r", "-l", commit).split("\n")) {
    const match = /^\d+ blob \w+\s+(\d+)\t(.+)$/.exec(line);
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

    const commitAs = (branch: string, message: string): string => {
      git(tree, env, "checkout", "--quiet", "--orphan", branch);
      git(tree, env, "add", "-A");
      git(tree, env, "commit", "--quiet", "-m", message);
      return git(tree, env, "rev-parse", "HEAD").trim();
    };
    const committed = commitAs("comments", `${taskId}: the code as committed`);
    const summary = JSON.parse(execFileSync(python, [STRIP_SCRIPT, tree], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })) as {
      skipped: Record<string, string>;
    };
    const stripped = commitAs("none", `${taskId}: the code without comments`);

    const refs = (arm: Arm) => `+refs/heads/${arm}:refs/heads/${preparedBranch(taskId, arm)}`;
    git(tree, env, "push", "--quiet", mirror, refs("comments"), refs("none"));
    return {
      taskId,
      commentBytes: commentBytesBetween(mirror, env, committed, stripped),
      unstripped: Object.keys(summary.skipped),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
