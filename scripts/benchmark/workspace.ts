/**
 * Fresh checkouts for each run. Every git and Cairn command here runs with its own global
 * config, ignore file, and CLI home (see `isolatedEnv`), never the machine owner's.
 */
import { execFileSync, execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandCommand, type RepoSpec } from "./tasks.ts";

export type Arm = "none" | "comments";
export const ARMS: Arm[] = ["none", "comments"];

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The built CLI; `npm run build` makes it. */
export const CAIRN_CLI = path.join(REPO_ROOT, "packages", "cli", "bundle", "main.js");
/** Frozen comments per repository, as `.git/cairn/comments/` holds them in private mode. */
export const FROZEN_COMMENTS = path.join(REPO_ROOT, "benchmark", "comments");
const PRIVATE_STORE = path.join(".git", "cairn", "comments");

/** Files that would give an agent instructions from outside the repository under test. */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".claude", ".pi"];

/**
 * Harnesses read AGENTS.md and CLAUDE.md from every parent of their directory, so a work
 * directory below one of those would leak it into every run.
 */
export function refuseInheritedInstructions(workDir: string): void {
  let dir = path.resolve(workDir);
  for (;;) {
    const found = INSTRUCTION_FILES.map((name) => path.join(dir, name)).filter((file) => existsSync(file));
    if (found.length) throw new Error(`instruction files above the work directory would reach every run: ${found.join(", ")}`);
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/** The process environment without git variables, with git and the CLI pointed into `stateDir`. */
export function isolatedEnv(stateDir: string, cliHome: string): Record<string, string> {
  mkdirSync(stateDir, { recursive: true });
  const config = path.join(stateDir, "gitconfig");
  writeFileSync(
    config,
    [
      "[user]\n\tname = bench\n\temail = bench@example.invalid",
      "[core]\n\tlongpaths = true",
      "[commit]\n\tgpgsign = false",
      "[advice]\n\tdetachedHead = false",
    ].join("\n"),
  );
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("GIT_")) env[name] = value;
  }
  // XDG_CONFIG_HOME: git also reads $XDG_CONFIG_HOME/git/ignore, which GIT_CONFIG_GLOBAL does not cover.
  return {
    ...env,
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    XDG_CONFIG_HOME: path.join(stateDir, "xdg"),
    CAIRN_CLI_HOME: cliHome,
  };
}

function git(cwd: string, env: Record<string, string>, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function cairn(cwd: string, env: Record<string, string>, ...args: string[]): string {
  if (!existsSync(CAIRN_CLI)) throw new Error(`${CAIRN_CLI} is missing; run npm run build`);
  return execFileSync(process.execPath, [CAIRN_CLI, ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function hasCommit(repo: string, env: Record<string, string>, sha: string): boolean {
  try {
    git(repo, env, "cat-file", "-e", `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * A bare mirror of `spec.url` under `workDir` holding every commit in `commits`. It is
 * fetched only when one is missing, so shards started together do not fetch into it at once.
 */
export function ensureMirror(
  workDir: string,
  name: string,
  spec: RepoSpec,
  env: Record<string, string>,
  commits: string[],
): string {
  const mirror = path.join(workDir, "mirrors", `${name}.git`);
  if (!existsSync(mirror)) {
    mkdirSync(path.dirname(mirror), { recursive: true });
    git(workDir, env, "clone", "--mirror", spec.url, mirror);
  } else if (!commits.every((sha) => hasCommit(mirror, env, sha))) {
    git(mirror, env, "fetch", "--prune", "origin");
  }
  return mirror;
}

export interface CheckoutOptions {
  mirror: string;
  runDir: string;
  start: string;
  arm: Arm;
  /** Frozen sidecars to place in the comments arm; absent for the annotating session. */
  comments?: string;
  /** Adapters for `cairn init --hooks`, comments arm only. */
  hooks: string[];
  env: Record<string, string>;
}

/**
 * Clones `start` into `runDir/repo` and adds the worktree the agent works in,
 * `runDir/agent`. In the comments arm the clone is set up in private mode with the frozen
 * sidecars, so the agent worktree's checkout places them; the branch stays byte for byte
 * the same in both arms.
 */
export function checkoutArm(options: CheckoutOptions): string {
  const repo = path.join(options.runDir, "repo");
  const agent = path.join(options.runDir, "agent");
  git(options.runDir, options.env, "clone", "--quiet", "--no-checkout", options.mirror, repo);
  git(repo, options.env, "checkout", "--quiet", "--detach", options.start);
  if (options.arm === "none") {
    git(repo, options.env, "worktree", "add", "--quiet", "-b", "bench", agent);
    return agent;
  }
  const hookArgs = options.hooks.length ? ["--hooks", options.hooks.join(",")] : [];
  cairn(repo, options.env, "init", "--private", ...hookArgs);
  if (options.comments) cpSync(options.comments, path.join(repo, PRIVATE_STORE), { recursive: true });
  cairn(repo, options.env, "worktree", "add", "-b", "bench", agent);
  return agent;
}

/** Every file with a sidecar in `store`, as a repository-relative path with `/` separators. */
function sidecarSources(store: string, prefix = ""): string[] {
  if (!existsSync(store)) return [];
  const sources: string[] = [];
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) sources.push(...sidecarSources(path.join(store, entry.name), relative + "/"));
    else if (entry.name.endsWith(".md")) sources.push(relative.slice(0, -".md".length));
  }
  return sources;
}

/**
 * Bytes the placed comments add to each file of the agent worktree, against the committed
 * file. Files whose comments all failed to place are left out.
 */
export function commentBytes(runDir: string, env: Record<string, string>): Record<string, number> {
  const repo = path.join(runDir, "repo");
  const agent = path.join(runDir, "agent");
  const added: Record<string, number> = {};
  for (const source of sidecarSources(path.join(repo, PRIVATE_STORE))) {
    const working = path.join(agent, source);
    if (!existsSync(working)) continue;
    const committed = Number(git(agent, env, "cat-file", "-s", `HEAD:${source}`).trim());
    const extra = statSync(working).size - committed;
    if (extra > 0) added[source] = extra;
  }
  return added;
}

/** Copies the clone's private sidecars to `destination`, replacing what was there. */
export function freezeComments(runDir: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true });
  cpSync(path.join(runDir, "repo", PRIVATE_STORE), destination, { recursive: true });
}

/** Runs each shell command in `cwd`, stopping at the first failure. */
export function runSetup(commands: string[], cwd: string, env: Record<string, string>, logFile: string): void {
  for (const command of commands.map((c) => expandCommand(c))) {
    const output = execSync(command, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    writeFileSync(logFile, `$ ${command}\n${output}\n`, { flag: "a" });
  }
}

/** Removes the checkouts, which hold dependencies, and keeps the run's logs. */
export function removeCheckouts(runDir: string): void {
  for (const dir of ["agent", "repo"]) {
    rmSync(path.join(runDir, dir), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

export { cairn, git };
