// Scratch git repositories for the test runners (e2e/run.ts, native/run.ts).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../cli/bundle/main.js");

export interface ScratchRepo {
  dir: string;
  repo: string;
  env: Record<string, string>;
}

/**
 * A committed, initialized repository filled by `populate`. Its own global git config keeps
 * `init` from writing a hook into the developer's `core.hooksPath`, and the extension host
 * inherits it.
 */
export function scratchRepo(populate: (repo: string) => void): ScratchRepo {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "cairn-e2e-")));
  const config = path.join(dir, "gitconfig");
  writeFileSync(config, "[user]\n\tname = e2e\n\temail = e2e@example.com\n[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n");
  const env = { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };
  const repo = path.join(dir, "repo");
  mkdirSync(repo);
  populate(repo);
  const opts = { cwd: repo, env: { ...process.env, ...env }, stdio: "ignore" as const };
  execFileSync("git", ["init", "-q"], opts);
  execFileSync(process.execPath, [cli, "init"], opts);
  execFileSync("git", ["add", "-A"], opts);
  execFileSync("git", ["commit", "-qm", "base"], opts);
  return { dir, repo, env };
}
