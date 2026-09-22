import { FILTER_DRIVER } from "@slopstash/core";
import { git } from "./git.js";
import { configuredCommand, configuredProcess } from "./init.js";

function worktreePaths(root: string): string[] {
  return git(["worktree", "list", "--porcelain"], { cwd: root })
    .split(/\r?\n/)
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
}

/**
 * `git worktree add` checks out before per-worktree config can exist, so: add with
 * `--no-checkout`, enable smudge for that worktree only, then populate it.
 */
export function addWorktree(root: string, args: string[], cwd = process.cwd()): string {
  const command = configuredCommand(root);
  const before = new Set(worktreePaths(root));
  // From the caller's directory, so a relative worktree path means what they typed.
  git(["worktree", "add", "--no-checkout", ...args], { cwd });
  const created = worktreePaths(root).find((p) => !before.has(p));
  if (!created) throw new Error("git worktree add reported success but no new worktree is listed");
  git(["config", "--worktree", `filter.${FILTER_DRIVER}.smudge`, `${command} smudge %f`], { cwd: created });
  if (configuredProcess(root)) {
    git(["config", "--worktree", `filter.${FILTER_DRIVER}.process`, `${command} filter-process --smudge`], { cwd: created });
  }
  git(["reset", "--hard", "--quiet"], { cwd: created });
  return created;
}
