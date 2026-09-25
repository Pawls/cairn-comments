import { FILTER_DRIVER } from "@cairn-comments/core";
import { ADAPTERS, adapterFor, adapterInstalled, applySettingsChange, planAdapterInstall } from "./adapters.js";
import { git, isTracked, worktreeRoots } from "./git.js";
import { configuredCommand, configuredProcess } from "./init.js";

/**
 * `git worktree add` checks out before per-worktree config can exist, so: add with
 * `--no-checkout`, enable smudge for that worktree only, then populate it. Hook adapters
 * installed in `root` are installed in the new worktree too, unless their settings file is
 * tracked and so arrived with the checkout.
 */
export function addWorktree(root: string, args: string[], cwd = process.cwd()): string {
  const command = configuredCommand(root);
  const before = new Set(worktreeRoots(root));
  // From the caller's directory, so a relative worktree path means what they typed.
  git(["worktree", "add", "--no-checkout", ...args], { cwd });
  const created = worktreeRoots(root).find((p) => !before.has(p));
  if (!created) throw new Error("git worktree add reported success but no new worktree is listed");
  git(["config", "--worktree", `filter.${FILTER_DRIVER}.smudge`, `${command} smudge %f`], { cwd: created });
  if (configuredProcess(root)) {
    git(["config", "--worktree", `filter.${FILTER_DRIVER}.process`, `${command} filter-process --smudge`], { cwd: created });
  }
  git(["reset", "--hard", "--quiet"], { cwd: created });
  for (const harness of Object.keys(ADAPTERS)) {
    if (!adapterInstalled(root, harness) || isTracked(created, adapterFor(harness).settingsFile)) continue;
    const change = planAdapterInstall(created, harness, command);
    if (change) applySettingsChange(change);
  }
  return created;
}
