/**
 * Warm-up chains for deep runs. A chain runs once per harness and arm, in one session;
 * each probe then forks that session and works in the chain's own checkout, put back to how
 * the chain left it. The checkout cannot move: the session's tool calls name its files by
 * absolute path, so a probe in a copy elsewhere would read and edit the warm-up's files.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HOME_DIRS, readLog, refuseFailedSession, runAgent, type AgentOptions, type Exit } from "./agent.ts";
import type { HarnessName } from "./harnesses.ts";
import { lastAgentContext } from "./metrics.ts";
import type { PreparedTask } from "./prepare.ts";
import { requestRewrite, startRecordingProxy } from "./proxy.ts";
import type { RepoSpec, WarmupChain } from "./tasks.ts";
import { CHECKOUTS, git, isolatedEnv, neutralName, setUpCheckout, type Arm } from "./workspace.ts";

/**
 * What a finished warm-up leaves for the probes forked from it, as `warmup.json`. It sits
 * beside the probe's checkout, so it says nothing that tells the arm: no arm, and no
 * comment bytes, which are empty in one arm only.
 */
export interface Warmup {
  chain: string;
  harness: HarnessName;
  sessionId: string;
  /**
   * What the chain ran with. The directory is named for the harness, chain and arm only, so these
   * tell a record from before an edit to the chain or a change of model (`sameRun`).
   */
  prompts: string[];
  start: string;
  model: string;
  /** One per prompt. */
  exits: Exit[];
  wallMs: number;
  /** The context the chain's last agent call carried: about where a probe starts. */
  finalContext: number;
}

/**
 * Throws when a prompt of the warm-up failed or timed out: its session stops short of the
 * chain, so a probe forked from it would start shallower than the other arm's. The record
 * stays, so a batch does not run a failing chain again for every probe.
 */
export function refuseUnfinished(ready: ReadyWarmup): void {
  const failed = ready.warmup.exits.findIndex((exit) => exit.timedOut || exit.code !== 0);
  if (failed === -1) return;
  const exit = ready.warmup.exits[failed]!;
  const how = exit.timedOut ? "timed out" : `exited ${exit.code}`;
  throw new Error(`warm-up ${ready.warmup.chain} did not finish: prompt ${failed + 1} ${how}; delete ${ready.dir} to run it again`);
}

/** What names one warm-up: its runs share a checkout, so sharding keeps them together by it. */
export function warmupKey(chain: string, arm: Arm): string {
  return neutralName(chain, arm);
}

/** A warm-up's directory; its name hides the arm (`neutralName`). */
export function warmupDirFor(workDir: string, harness: HarnessName, chain: string, arm: Arm): string {
  return path.join(workDir, "warmups", harness, warmupKey(chain, arm));
}

export interface WarmupSpec extends AgentOptions {
  chain: WarmupChain;
  repo: RepoSpec;
  mirror: string;
  arm: Arm;
  workDir: string;
  /** Frozen sidecars for the comments arm. */
  comments: string;
  /** The chain's arm commits, for a repository whose arms differ in its own comments. */
  prepared?: PreparedTask;
}

/**
 * What a probe can change and the next probe must not see: the checkouts, and the harness's
 * configuration and sessions (Claude Code keeps memory and todos in its configuration).
 */
const RESTORED = [...CHECKOUTS, ...Object.values(HOME_DIRS)];

/** Where a copy of `RESTORED` keeps it as the chain left it. */
const SNAPSHOT = "snapshot";

/** Written last, so its presence means the warm-up finished. */
const RECORD = "warmup.json";

export interface ReadyWarmup {
  dir: string;
  warmup: Warmup;
  /** The chain ran just now, so its checkouts are still as it left them. */
  ranNow: boolean;
}

/**
 * Whether a finished warm-up ran the chain the spec names, on its model. A record written before
 * these fields were kept has none of them and fails, since nothing shows what it ran.
 * Changes to how the harness is launched are not recorded; a rerun after one starts from a new work dir.
 */
function sameRun(warmup: Warmup, spec: WarmupSpec): boolean {
  return (
    JSON.stringify(warmup.prompts) === JSON.stringify(spec.chain.prompts) &&
    warmup.start === spec.chain.start &&
    warmup.model === spec.model
  );
}

/** The warm-up the spec names, run now unless an earlier batch finished it. */
export async function ensureWarmup(spec: WarmupSpec): Promise<ReadyWarmup> {
  const dir = warmupDirFor(spec.workDir, spec.harness, spec.chain.id, spec.arm);
  const record = path.join(dir, RECORD);
  if (existsSync(record)) {
    const warmup = JSON.parse(readFileSync(record, "utf8")) as Warmup;
    if (!sameRun(warmup, spec)) {
      throw new Error(`warm-up ${spec.chain.id} ran with other prompts, start or model; delete ${dir} to run it again`);
    }
    return { dir, warmup, ranNow: false };
  }

  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  mkdirSync(dir, { recursive: true });
  const env = isolatedEnv(path.join(dir, "state"), path.join(spec.workDir, "cli-home"));
  const checkout = setUpCheckout({ ...spec, dir, start: spec.chain.start, setup: spec.repo.setup, env });

  const logFile = path.join(dir, "calls.jsonl");
  const proxy = await startRecordingProxy(spec.provider, logFile, "warmup", requestRewrite(spec.local));
  const startedAt = Date.now();
  const dirs = { agentDir: checkout.agentDir, homeDir: dir, outputDir: dir };
  const session = await runAgent(spec, spec.chain.prompts, dirs, env, proxy.url).finally(() => proxy.close());
  const log = readLog(logFile);
  // On a failure there is no warmup.json, so the next batch runs the chain again.
  refuseFailedSession(log, `warm-up ${spec.chain.id}`);
  const warmup: Warmup = {
    chain: spec.chain.id,
    harness: spec.harness,
    sessionId: session.sessionId,
    prompts: spec.chain.prompts,
    start: spec.chain.start,
    model: spec.model,
    exits: session.exits,
    wallMs: Date.now() - startedAt,
    finalContext: lastAgentContext(log),
  };
  for (const name of RESTORED.filter((n) => existsSync(path.join(dir, n)))) {
    cpSync(path.join(dir, name), path.join(dir, SNAPSHOT, name), { recursive: true });
  }
  writeFileSync(record, JSON.stringify(warmup, null, 2));
  return { dir, warmup, ranNow: true };
}

/**
 * Readies the warm-up for a probe: puts back what the chain left (`RESTORED`) unless the
 * chain ran just now, and starts `logFile` with the chain's calls so one log holds the
 * whole session.
 */
export function restoreWarmup(ready: ReadyWarmup, logFile: string, env: Record<string, string>): void {
  if (!ready.ranNow) {
    for (const name of RESTORED) {
      rmSync(path.join(ready.dir, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      const saved = path.join(ready.dir, SNAPSHOT, name);
      if (existsSync(saved)) cpSync(saved, path.join(ready.dir, name), { recursive: true });
    }
    // A copy can reset modification times, which leaves every file stat-dirty to git; refresh
    // the index now, outside the probe's timed run, instead of in its first git command.
    git(path.join(ready.dir, "agent"), env, "update-index", "-q", "--refresh");
  }
  copyFileSync(path.join(ready.dir, "calls.jsonl"), logFile);
}
