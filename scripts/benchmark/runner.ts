/**
 * One benchmark run: the harness on one task in one arm, and its grade. A `fresh` run
 * starts an empty session in a new checkout; a `deep` run forks a warm-up chain's session
 * in the chain's checkout (warmup.ts).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { outputStem, ProviderError, readLog, runAgent, type AgentOptions } from "./agent.ts";
import { forkTotals, harnessTotals, type HarnessName, type HarnessTotals } from "./harnesses.ts";
import { gradeAnswer, providerFailed, runMetrics, type RunMetrics } from "./metrics.ts";
import type { PreparedTask } from "./prepare.ts";
import { startRecordingProxy } from "./proxy.ts";
import { expandCommand, type EditTask, type RepoSpec, type Task } from "./tasks.ts";
import { ensureWarmup, restoreWarmup, type WarmupChain } from "./warmup.ts";
import { isolatedEnv, removeCheckouts, setUpCheckout, type Arm } from "./workspace.ts";

export type Depth = "fresh" | "deep";

export interface RunSpec extends AgentOptions {
  task: Task;
  repo: RepoSpec;
  mirror: string;
  arm: Arm;
  rep: number;
  workDir: string;
  /** Frozen sidecars for the comments arm. */
  comments: string;
  /** Keep the checkouts after grading, for inspection. A deep run always keeps its warm-up's. */
  keep: boolean;
  /** The task's arm commits, for a repository whose arms differ in its own comments. */
  prepared?: PreparedTask;
  /** For a deep run, the chain the probe forks from, and the chain's arm commits. */
  warmup?: { chain: WarmupChain; prepared?: PreparedTask };
}

export interface Grade {
  passed: boolean;
  /** Exit code of the task's test command, for an edit task. */
  testExit?: number | null;
  /** Answer-key patterns the answer missed, for a question. */
  missing?: string[];
}

export interface RunResult {
  harness: HarnessName;
  task: string;
  repo: string;
  kind: Task["kind"];
  arm: Arm;
  rep: number;
  /** Absent in results written before deep runs existed, which were all fresh. */
  depth?: Depth;
  /** The warm-up chain a deep run forked from. */
  chain?: string;
  model: string;
  startedAt: string;
  wallMs: number;
  exitCode: number | null;
  timedOut: boolean;
  grade: Grade;
  metrics: RunMetrics;
  /** The harness's own report of what it spent; compared against the proxy's counts. */
  harnessTotals?: HarnessTotals;
  /** Bytes the placed comments add to each file, against the committed file. */
  commentBytes: Record<string, number>;
  /** Of those bytes, the ones in files the agent read. A ranged read counts the whole file. */
  commentBytesRead: number;
}

export function depthOf(result: RunResult): Depth {
  return result.depth ?? "fresh";
}

/** A fresh run's directory is `<arm>-<rep>`, as before deep runs existed; a deep one names its chain. */
export function runDirFor(spec: { workDir: string; harness: HarnessName; task: Task; arm: Arm; rep: number; chain?: string }): string {
  const name = spec.chain ? `deep-${spec.chain}-${spec.arm}-${spec.rep}` : `${spec.arm}-${spec.rep}`;
  return path.join(spec.workDir, "runs", spec.harness, spec.task.id, name);
}

/** Puts the solution's tests, read from the mirror, over the agent's work. */
function placeSolutionTests(task: EditTask, mirror: string, agentDir: string, env: Record<string, string>): void {
  for (const file of task.testFiles) {
    const content = execFileSync("git", ["--git-dir", mirror, "show", `${task.solution}:${file}`], { env, maxBuffer: 64 * 1024 * 1024 });
    mkdirSync(path.dirname(path.join(agentDir, file)), { recursive: true });
    writeFileSync(path.join(agentDir, file), content);
  }
}

/** Puts the solution's tests over the agent's work and runs the task's test command. */
function gradeEdit(task: EditTask, spec: RunSpec, agentDir: string, env: Record<string, string>, runDir: string): Grade {
  placeSolutionTests(task, spec.mirror, agentDir, env);
  const test = spawnSync(expandCommand(task.testCommand), {
    cwd: agentDir,
    env,
    shell: true,
    encoding: "utf8",
    timeout: 20 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  writeFileSync(path.join(runDir, "test.log"), `${test.stdout}\n${test.stderr}`);
  return { passed: test.status === 0, testExit: test.status };
}

function grade(spec: RunSpec, metrics: RunMetrics, agentDir: string, env: Record<string, string>, runDir: string): Grade {
  if (spec.task.kind === "question") {
    const { passed, missing } = gradeAnswer(metrics.finalText, spec.task.answerKey);
    return { passed, missing };
  }
  return gradeEdit(spec.task, spec, agentDir, env, runDir);
}

/** Where the probe runs, and the session it forks from, if any. */
interface Start {
  agentDir: string;
  homeDir: string;
  from?: string;
  /** The output of the last prompt before the fork, whose totals a Claude Code fork carries. */
  parentOutput?: string;
  commentBytes: Record<string, number>;
}

/** A new checkout in the run's own directory, and a new session. */
function freshStart(spec: RunSpec, runDir: string, env: Record<string, string>): Start {
  const checkout = setUpCheckout({ ...spec, dir: runDir, start: spec.task.start, setup: spec.repo.setup, env });
  return { ...checkout, homeDir: runDir };
}

/** The warm-up's checkout as the chain left it, and a fork of its session. */
async function deepStart(spec: RunSpec, warmupSpec: NonNullable<RunSpec["warmup"]>, logFile: string): Promise<Start> {
  const { chain, prepared } = warmupSpec;
  if (chain.repo !== spec.task.repo || chain.start !== spec.task.start) {
    throw new Error(`task ${spec.task.id} does not start where warm-up ${chain.id} does (${chain.repo} at ${chain.start})`);
  }
  const { dir, warmup } = await ensureWarmup({ ...spec, chain, prepared });
  restoreWarmup(dir, logFile);
  return {
    agentDir: path.join(dir, "agent"),
    homeDir: dir,
    from: warmup.sessionId,
    parentOutput: `${outputStem(dir, chain.prompts.length)}.jsonl`,
    commentBytes: warmup.commentBytes,
  };
}

/** What the harness reports the probe's prompt spent, without a warm-up's share. */
function probeTotals(harness: HarnessName, start: Start, runDir: string): HarnessTotals | undefined {
  const output = readFileSync(`${outputStem(runDir, 1)}.jsonl`, "utf8");
  if (!start.parentOutput) return harnessTotals(harness, output);
  return forkTotals(harness, output, readFileSync(start.parentOutput, "utf8"));
}

export async function runOne(spec: RunSpec): Promise<RunResult> {
  const chain = spec.warmup?.chain.id;
  const runDir = runDirFor({ ...spec, chain });
  mkdirSync(runDir, { recursive: true });
  const env = isolatedEnv(path.join(runDir, "state"), path.join(spec.workDir, "cli-home"));
  const logFile = path.join(runDir, "calls.jsonl");
  const start = spec.warmup ? await deepStart(spec, spec.warmup, logFile) : freshStart(spec, runDir, env);

  const proxy = await startRecordingProxy(spec.provider, logFile, "probe");
  const startedAt = new Date();
  const dirs = { agentDir: start.agentDir, homeDir: start.homeDir, outputDir: runDir };
  const session = await runAgent(spec, [spec.task.prompt], dirs, env, proxy.url, start.from).finally(() => proxy.close());
  const wallMs = Date.now() - startedAt.getTime();
  const exit = session.exits[0];
  if (!exit) throw new Error("the probe's prompt never ran");

  const log = readLog(logFile);
  const probeCalls = log.filter((call) => call.phase === "probe");
  if (providerFailed(probeCalls)) {
    // No result.json, so the next batch runs this one again; the checkouts stay for a look.
    throw new ProviderError(`the model server failed this run (${probeCalls.length} calls); see calls.jsonl and harness-1.err`);
  }
  const metrics = runMetrics(log, { model: spec.model, agentDir: start.agentDir });
  const result: RunResult = {
    harness: spec.harness,
    task: spec.task.id,
    repo: spec.task.repo,
    kind: spec.task.kind,
    arm: spec.arm,
    rep: spec.rep,
    depth: chain ? "deep" : "fresh",
    chain,
    model: spec.model,
    startedAt: startedAt.toISOString(),
    wallMs,
    exitCode: exit.code,
    timedOut: exit.timedOut,
    grade: grade(spec, metrics, start.agentDir, env, runDir),
    metrics,
    harnessTotals: probeTotals(spec.harness, start, runDir),
    commentBytes: start.commentBytes,
    commentBytesRead: metrics.filesRead.reduce((sum, file) => sum + (start.commentBytes[file] ?? 0), 0),
  };
  writeFileSync(path.join(runDir, "result.json"), JSON.stringify(result, null, 2));
  if (!spec.keep && !chain) removeCheckouts(runDir);
  return result;
}
