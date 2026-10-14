/**
 * Warm-up chains for deep runs. A chain runs once per harness and arm, in one session;
 * each probe then forks that session and works in the chain's own checkout, put back to how
 * the chain left it. The checkout cannot move: the session's tool calls name its files by
 * absolute path, so a probe in a copy elsewhere would read and edit the warm-up's files.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ProviderError, readLog, runAgent, type AgentOptions, type Exit } from "./agent.ts";
import type { HarnessName } from "./harnesses.ts";
import { contextOf, providerFailed } from "./metrics.ts";
import type { PreparedTask } from "./prepare.ts";
import { startRecordingProxy } from "./proxy.ts";
import type { RepoSpec } from "./tasks.ts";
import { checkoutArm, commentBytes, isolatedEnv, runSetup, type Arm } from "./workspace.ts";

/** Prompts run in one session before a probe forks from its end. */
export interface WarmupChain {
  /** The file name without `.json`. */
  id: string;
  repo: string;
  /** The commit the chain starts from; a probe forked from it must start there too. */
  start: string;
  prompts: string[];
}

/** What a finished warm-up leaves for the probes forked from it, as `warmup.json`. */
export interface Warmup {
  chain: string;
  harness: HarnessName;
  arm: Arm;
  sessionId: string;
  /** One per prompt. */
  exits: Exit[];
  wallMs: number;
  /** The context the chain's last model call carried: about where a probe starts. */
  finalContext: number;
  commentBytes: Record<string, number>;
}

/** Every chain in `dir`, one `<id>.json` file each holding `repo`, `start`, and `prompts`. */
export function loadChains(dir: string): Map<string, WarmupChain> {
  const chains = new Map<string, WarmupChain>();
  if (!existsSync(dir)) return chains;
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    const id = path.basename(file, ".json");
    const chain = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as Omit<WarmupChain, "id">;
    chains.set(id, { ...chain, id });
  }
  return chains;
}

export function warmupDirFor(workDir: string, harness: HarnessName, chain: string, arm: Arm): string {
  return path.join(workDir, "warmups", harness, `${chain}-${arm}`);
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

/** The checkouts a probe changes, and the copy of them as the chain left them. */
const CHECKOUTS = ["agent", "repo"];
const SNAPSHOT = "snapshot";
const RECORD = "warmup.json";

/** The warm-up the spec names, run now unless an earlier batch finished it. */
export async function ensureWarmup(spec: WarmupSpec): Promise<{ dir: string; warmup: Warmup }> {
  const dir = warmupDirFor(spec.workDir, spec.harness, spec.chain.id, spec.arm);
  const record = path.join(dir, RECORD);
  if (existsSync(record)) return { dir, warmup: JSON.parse(readFileSync(record, "utf8")) as Warmup };

  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  mkdirSync(dir, { recursive: true });
  const env = isolatedEnv(path.join(dir, "state"), path.join(spec.workDir, "cli-home"));
  const agentDir = checkoutArm({
    mirror: spec.mirror,
    runDir: dir,
    start: spec.chain.start,
    arm: spec.arm,
    comments: spec.comments,
    hooks: spec.harness === "claude" && !spec.prepared ? ["claude-code"] : [],
    env,
    prepared: spec.prepared,
  });
  runSetup(spec.repo.setup, agentDir, env, path.join(dir, "setup.log"));
  const placed = spec.arm === "comments" ? (spec.prepared?.commentBytes ?? commentBytes(dir, env)) : {};

  const logFile = path.join(dir, "calls.jsonl");
  const proxy = await startRecordingProxy(spec.provider, logFile, "warmup");
  const startedAt = Date.now();
  const session = await runAgent(spec, spec.chain.prompts, { agentDir, homeDir: dir, outputDir: dir }, env, proxy.url).finally(
    () => proxy.close(),
  );
  const log = readLog(logFile);
  if (providerFailed(log)) {
    // No warmup.json, so the next batch runs the chain again.
    throw new ProviderError(`the model server failed warm-up ${spec.chain.id} (${log.length} calls); see ${logFile}`);
  }
  const last = log.findLast((call) => call.response)?.response;
  const warmup: Warmup = {
    chain: spec.chain.id,
    harness: spec.harness,
    arm: spec.arm,
    sessionId: session.sessionId,
    exits: session.exits,
    wallMs: Date.now() - startedAt,
    finalContext: last ? contextOf(last) : 0,
    commentBytes: placed,
  };
  for (const checkout of CHECKOUTS) cpSync(path.join(dir, checkout), path.join(dir, SNAPSHOT, checkout), { recursive: true });
  writeFileSync(record, JSON.stringify(warmup, null, 2));
  return { dir, warmup };
}

/**
 * Puts the warm-up's checkouts back as the chain left them, undoing an earlier probe, and
 * starts `logFile` with the chain's calls so one log holds the whole session.
 */
export function restoreWarmup(dir: string, logFile: string): void {
  for (const checkout of CHECKOUTS) {
    rmSync(path.join(dir, checkout), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    cpSync(path.join(dir, SNAPSHOT, checkout), path.join(dir, checkout), { recursive: true });
  }
  copyFileSync(path.join(dir, "calls.jsonl"), logFile);
}
