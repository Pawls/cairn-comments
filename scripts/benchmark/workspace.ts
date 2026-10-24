/**
 * Fresh checkouts for each run. Every git and Cairn command here runs with its own global
 * config, ignore file, and CLI home (see `isolatedEnv`), never the machine owner's.
 */
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessName } from "./harnesses.ts";
import { COMMIT_MESSAGE, preparedBranch, type PreparedTask } from "./prepare.ts";
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

/**
 * A directory name that tells runs apart without saying which arm each is in. Agents see the
 * path they work in, and a name like `none-3` would tell them their arm.
 */
export function neutralName(...parts: Array<string | number | undefined>): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 12);
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
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); // NOSONAR: git comes from PATH, as for any tool that drives git
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
 * The fetch never prunes: the prepared branches (prepare.ts) exist only in the mirror.
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
    git(mirror, env, "fetch", "origin");
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
  /** The task's arm commits (prepare.ts); both arms are then plain worktrees, with no Cairn. */
  prepared?: PreparedTask;
  /** For a prepared checkout in the notes loop (notes.ts): its own AGENTS.md, and Cairn. */
  notes?: NotesCheckout;
}

/** How a notes-loop run's prepared checkout differs from the plain one. */
export interface NotesCheckout {
  /** Replaces AGENTS.md in the clone's one commit. */
  agentsMd: string;
  /** Cairn in private mode, with these frozen sidecars placed (none for a writer's empty store). */
  cairn?: { sidecars?: string; hooks: string[] };
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
  if (options.prepared) {
    // One branch, no remote: the original commits and the solution are not in the clone.
    // A clone by local path copies every object and follows every tag; --no-local fetches
    // only what the branch reaches.
    const branch = preparedBranch(options.prepared.taskId, options.arm);
    const cloneArgs = ["clone", "--quiet", "--no-local", "--no-checkout", "--single-branch", "--branch", branch];
    git(options.runDir, options.env, ...cloneArgs, options.mirror, repo);
    git(repo, options.env, "remote", "remove", "origin");
    // The cloned branch's name says which arm this is; leave only the agent's `bench`.
    const head = git(repo, options.env, "rev-parse", "HEAD").trim();
    git(repo, options.env, "update-ref", "--no-deref", "HEAD", head);
    git(repo, options.env, "branch", "--quiet", "--delete", "--force", branch);
    if (options.notes) return notesWorktree(repo, agent, options.notes, options.env);
    git(repo, options.env, "worktree", "add", "--quiet", "-b", "bench", agent);
    return agent;
  }
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

/**
 * A parentless commit of `tree` with the message and dates of HEAD in `cwd`. The author is
 * isolatedEnv's, as it was when prepare.ts made the commit HEAD is.
 */
function commitLikeHead(cwd: string, env: Record<string, string>, tree: string): string {
  const [authorDate, committerDate] = git(cwd, env, "show", "-s", "--format=%aI%n%cI", "HEAD").trim().split("\n");
  const commitEnv = { ...env, GIT_AUTHOR_DATE: authorDate!, GIT_COMMITTER_DATE: committerDate! };
  return git(cwd, commitEnv, "commit-tree", tree, "-m", COMMIT_MESSAGE).trim();
}

function gitWithInput(cwd: string, env: Record<string, string>, input: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }); // NOSONAR: git comes from PATH, as for any tool that drives git
}

/**
 * Swaps AGENTS.md in the clone's one commit for `text`, keeping the commit parentless with the
 * same message, author and dates, so the agent sees an AGENTS.md that was always there.
 */
function recommitAgentsMd(repo: string, env: Record<string, string>, text: string): void {
  const blob = gitWithInput(repo, env, text, "hash-object", "-w", "--stdin").trim();
  const entries = git(repo, env, "ls-tree", "-z", "HEAD").split("\0").filter(Boolean);
  const replaced = entries.map((entry) => (entry.endsWith("\tAGENTS.md") ? `100644 blob ${blob}\tAGENTS.md` : entry));
  if (!entries.some((entry) => entry.endsWith("\tAGENTS.md"))) replaced.push(`100644 blob ${blob}\tAGENTS.md`);
  const tree = gitWithInput(repo, env, replaced.map((entry) => `${entry}\0`).join(""), "mktree", "-z").trim();
  const commit = commitLikeHead(repo, env, tree);
  git(repo, env, "update-ref", "--no-deref", "HEAD", commit);
}

/**
 * Commits everything in the worktree, through its filters (Cairn's clean filter strips the
 * notes), as one parentless commit with the clone's message and dates, onto `branch` in
 * `mirror`, where `checkoutArm` can clone it as a prepared branch.
 */
export function commitWork(agentDir: string, env: Record<string, string>, mirror: string, branch: string): string {
  git(agentDir, env, "add", "-A");
  const tree = git(agentDir, env, "write-tree").trim();
  const commit = commitLikeHead(agentDir, env, tree);
  git(agentDir, env, "push", "--quiet", "--force", mirror, `${commit}:refs/heads/${branch}`);
  return commit;
}

/** The agent's worktree for a notes-loop run, with its AGENTS.md and, in the notes arm, Cairn. */
function notesWorktree(repo: string, agent: string, notes: NotesCheckout, env: Record<string, string>): string {
  recommitAgentsMd(repo, env, notes.agentsMd);
  if (!notes.cairn) {
    git(repo, env, "worktree", "add", "--quiet", "-b", "bench", agent);
    return agent;
  }
  const hookArgs = notes.cairn.hooks.length ? ["--hooks", notes.cairn.hooks.join(",")] : [];
  cairn(repo, env, "init", "--private", ...hookArgs);
  if (notes.cairn.sidecars) cpSync(notes.cairn.sidecars, path.join(repo, PRIVATE_STORE), { recursive: true });
  cairn(repo, env, "worktree", "add", "-b", "bench", agent);
  return agent;
}

export interface SetUpOptions {
  harness: HarnessName;
  mirror: string;
  /** The directory that gets `repo` and `agent`. */
  dir: string;
  start: string;
  arm: Arm;
  /** Frozen sidecars for the comments arm. */
  comments: string;
  prepared?: PreparedTask;
  notes?: NotesCheckout;
  setup: string[];
  env: Record<string, string>;
}

/**
 * The agent's checkout of `start` in `dir`, with the repository's setup run, and the
 * bytes its comments add to each file.
 */
export function setUpCheckout(options: SetUpOptions): { agentDir: string; commentBytes: Record<string, number> } {
  const { dir, env, prepared } = options;
  const agentDir = checkoutArm({
    mirror: options.mirror,
    runDir: dir,
    start: options.start,
    arm: options.arm,
    comments: options.comments,
    // Cairn's Claude Code hooks matter only where Cairn places the comments.
    hooks: options.harness === "claude" && !prepared ? ["claude-code"] : [],
    env,
    prepared,
    notes: options.notes,
  });
  runSetup(options.setup, agentDir, env, path.join(dir, "setup.log"));
  const bytes = options.notes?.cairn ? commentBytes(dir, env) : placedCommentBytes(options.arm, dir, env, prepared);
  return { agentDir, commentBytes: bytes };
}

/** The bytes the comments add to each file of the checkout in `dir`; none in the `none` arm. */
export function placedCommentBytes(arm: Arm, dir: string, env: Record<string, string>, prepared?: PreparedTask): Record<string, number> {
  if (arm !== "comments") return {};
  return prepared?.commentBytes ?? commentBytes(dir, env);
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

/** Entries per source file in the sidecars under `store`: each entry is one `## <id>` heading. */
export function entriesBySource(store: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const source of sidecarSources(store)) {
    counts[source] = readFileSync(path.join(store, `${source}.md`), "utf8").match(/^## /gm)?.length ?? 0;
  }
  return counts;
}

/** A placed Python comment with its id, and one placed behind the stale tag (design.md § Staleness). */
const PLACED_ID = /#~[0-9a-z]{4}(?= |$)/gm;
const PLACED_STALE = /#~[0-9a-z]{4} \[stale\?\]/g;

/**
 * Per file with a sidecar in the clone's private store, the comments the agent worktree in
 * `runDir` shows, and how many in all were placed stale. Python's `#~` sigil only.
 */
export function placedComments(runDir: string): { placed: Record<string, number>; stale: number } {
  const placed: Record<string, number> = {};
  let stale = 0;
  for (const source of sidecarSources(path.join(runDir, "repo", PRIVATE_STORE))) {
    const working = path.join(runDir, "agent", source);
    if (!existsSync(working)) continue;
    const text = readFileSync(working, "utf8");
    const count = text.match(PLACED_ID)?.length ?? 0;
    if (count) placed[source] = count;
    stale += text.match(PLACED_STALE)?.length ?? 0;
  }
  return { placed, stale };
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

/** What `checkoutArm` makes in a run's directory: the agent's worktree and the clone that holds its git data. */
export const CHECKOUTS = ["agent", "repo"];

/** Removes the checkouts, which hold dependencies, and keeps the run's logs. */
export function removeCheckouts(runDir: string): void {
  for (const dir of CHECKOUTS) {
    rmSync(path.join(runDir, dir), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

export { cairn, git };
