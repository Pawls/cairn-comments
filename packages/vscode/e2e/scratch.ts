// Scratch git repositories for the test runners (e2e/run.ts, native/run.ts).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_HOME_ENV, PRIVATE_STORE, SIDECAR_ROOT } from "@cairn-comments/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../../../cli/bundle/main.js");

/** The extension package; this file sits two levels below it, in out/e2e. */
export const packageRoot = path.resolve(here, "../..");
/** The extension under test: this package, or an unpacked .vsix's `extension/` folder. */
export const extensionPath = process.env.CAIRN_E2E_EXTENSION
  ? path.resolve(process.env.CAIRN_E2E_EXTENSION)
  : packageRoot;
export const fixtureDir = path.join(packageRoot, "e2e/fixture");

export interface ScratchRepo {
  dir: string;
  repo: string;
  env: Record<string, string>;
}

/**
 * A committed, initialized repository filled by `populate`. Its own global git config keeps
 * `init` from writing a hook into the developer's `core.hooksPath`, its own CLI home keeps
 * `init` and the extension from installing into the developer's, and the extension host
 * inherits both.
 */
export function scratchRepo(populate: (repo: string) => void, options: { private?: boolean } = {}): ScratchRepo {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "cairn-e2e-")));
  const config = path.join(dir, "gitconfig");
  writeFileSync(
    config,
    "[user]\n\tname = e2e\n\temail = e2e@example.com\n[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n",
  );
  const env = {
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "1",
    XDG_CONFIG_HOME: path.join(dir, "xdg"),
    [CLI_HOME_ENV]: path.join(dir, "cli-home"),
  };
  const repo = path.join(dir, "repo");
  mkdirSync(repo);
  populate(repo);
  // GIT_DIR and its kin would send git to whatever repository launched the test.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const opts = { cwd: repo, env: { ...inherited, ...env }, stdio: "ignore" as const };
  execFileSync("git", ["init", "-q"], opts);
  execFileSync(process.execPath, [cli, "init", ...(options.private ? ["--private"] : [])], opts);
  // In private mode the populated sidecars belong in the store, off the branch.
  const sidecars = path.join(repo, SIDECAR_ROOT);
  if (options.private && existsSync(sidecars)) {
    cpSync(sidecars, path.join(repo, ".git", PRIVATE_STORE), { recursive: true });
    rmSync(path.join(repo, ".agents"), { recursive: true });
  }
  execFileSync("git", ["add", "-A"], opts);
  execFileSync("git", ["commit", "-qm", "base"], opts);
  // A private repository's comments are shared through a remote; a bare one stands in for it.
  if (options.private) {
    execFileSync("git", ["init", "-q", "--bare", path.join(dir, "remote.git")], opts);
    execFileSync("git", ["remote", "add", "origin", path.join(dir, "remote.git")], opts);
  }
  return { dir, repo, env };
}

/** A scratch repository holding a copy of e2e/fixture; `private` keeps its sidecar in the git dir. */
export const fixtureRepo = (options: { private?: boolean } = {}) =>
  scratchRepo((repo) => cpSync(fixtureDir, repo, { recursive: true }), options);
