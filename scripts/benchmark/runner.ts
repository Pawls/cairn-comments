/** One benchmark run: a fresh checkout, the harness on one task in one arm, and its grade. */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { harnessTotals, launchFor, withoutHarnessVariables, type HarnessName, type HarnessTotals } from "./harnesses.ts";
import { gradeAnswer, providerFailed, runMetrics, type LoggedCall, type RunMetrics } from "./metrics.ts";
import { startRecordingProxy } from "./proxy.ts";
import { expandCommand, type RepoSpec, type Task } from "./tasks.ts";
import { checkoutArm, commentBytes, git, isolatedEnv, removeCheckouts, runSetup, type Arm } from "./workspace.ts";

/** What starts an agent, whatever it is asked. */
export interface AgentOptions {
  harness: HarnessName;
  /** The API the proxy forwards to: the Anthropic API, a local model server, or a stand-in. */
  provider: string;
  /** `provider` serves `model` under its own name rather than being the Anthropic API. */
  local: boolean;
  model: string;
  apiKey: string;
  piCli: string;
  timeoutMs: number;
}

export interface RunSpec extends AgentOptions {
  task: Task;
  repo: RepoSpec;
  mirror: string;
  arm: Arm;
  rep: number;
  workDir: string;
  /** Frozen sidecars for the comments arm. */
  comments: string;
  /** Keep the checkouts after grading, for inspection. */
  keep: boolean;
}

/** A run lost to the model server rather than to the agent; it is retried, not recorded. */
export class ProviderError extends Error {}

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

export function runDirFor(spec: Pick<RunSpec, "workDir" | "harness" | "task" | "arm" | "rep">): string {
  return path.join(spec.workDir, "runs", spec.harness, spec.task.id, `${spec.arm}-${spec.rep}`);
}

export interface Exit {
  code: number | null;
  timedOut: boolean;
}

/** Ends `pid` and every process it started; a harness runs tools as child processes. */
function killTree(pid: number): void {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
  else process.kill(-pid, "SIGKILL");
}

/**
 * Runs the agent on `prompt` in `agentDir` through the proxy at `proxyUrl`, writing its
 * output to `harness.jsonl` and `harness.err` in `runDir`.
 */
export async function runAgent(
  spec: AgentOptions,
  prompt: string,
  dirs: { runDir: string; agentDir: string },
  env: Record<string, string>,
  proxyUrl: string,
): Promise<Exit> {
  const { runDir, agentDir } = dirs;
  const launch = launchFor(spec.harness, {
    prompt,
    model: spec.model,
    configDir: path.join(runDir, "config"),
    proxyUrl,
    sessionDir: path.join(runDir, "sessions"),
    piCli: spec.piCli,
    local: spec.local,
  });
  const child = spawn(launch.command, launch.args, {
    cwd: agentDir,
    env: { ...withoutHarnessVariables(env, spec.apiKey), ...launch.env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdout.pipe(createWriteStream(path.join(runDir, "harness.jsonl")));
  child.stderr.pipe(createWriteStream(path.join(runDir, "harness.err")));
  child.stdin.end(launch.stdin);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid !== undefined) killTree(child.pid);
  }, spec.timeoutMs);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  clearTimeout(timer);
  return { code, timedOut };
}

/** Puts the solution's tests over the agent's work and runs the task's test command. */
function gradeEdit(task: Task & { kind: "fix" | "feature" }, agentDir: string, env: Record<string, string>, runDir: string): Grade {
  git(agentDir, env, "checkout", task.solution, "--", ...task.testFiles);
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
  return gradeEdit(spec.task, agentDir, env, runDir);
}

/** The proxy's log; empty when the harness made no call. */
export function readLog(logFile: string): LoggedCall[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as LoggedCall);
}

export async function runOne(spec: RunSpec): Promise<RunResult> {
  const runDir = runDirFor(spec);
  mkdirSync(runDir, { recursive: true });
  const env = isolatedEnv(path.join(runDir, "state"), path.join(spec.workDir, "cli-home"));
  const agentDir = checkoutArm({
    mirror: spec.mirror,
    runDir,
    start: spec.task.start,
    arm: spec.arm,
    comments: spec.comments,
    hooks: spec.harness === "claude" ? ["claude-code"] : [],
    env,
  });
  runSetup(spec.repo.setup, agentDir, env, path.join(runDir, "setup.log"));
  const placed = spec.arm === "comments" ? commentBytes(runDir, env) : {};

  const logFile = path.join(runDir, "calls.jsonl");
  const proxy = await startRecordingProxy(spec.provider, logFile);
  const startedAt = new Date();
  const exit = await runAgent(spec, spec.task.prompt, { runDir, agentDir }, env, proxy.url).finally(() => proxy.close());
  const wallMs = Date.now() - startedAt.getTime();

  const log = readLog(logFile);
  if (providerFailed(log)) {
    // No result.json, so the next batch runs this one again; the checkouts stay for a look.
    throw new ProviderError(`the model server failed this run (${log.length} calls); see calls.jsonl and harness.err`);
  }
  const metrics = runMetrics(log, { model: spec.model, agentDir });
  const result: RunResult = {
    harness: spec.harness,
    task: spec.task.id,
    repo: spec.task.repo,
    kind: spec.task.kind,
    arm: spec.arm,
    rep: spec.rep,
    model: spec.model,
    startedAt: startedAt.toISOString(),
    wallMs,
    exitCode: exit.code,
    timedOut: exit.timedOut,
    grade: grade(spec, metrics, agentDir, env, runDir),
    metrics,
    harnessTotals: harnessTotals(spec.harness, readFileSync(path.join(runDir, "harness.jsonl"), "utf8")),
    commentBytes: placed,
    commentBytesRead: metrics.filesRead.reduce((sum, file) => sum + (placed[file] ?? 0), 0),
  };
  writeFileSync(path.join(runDir, "result.json"), JSON.stringify(result, null, 2));
  if (!spec.keep) removeCheckouts(runDir);
  return result;
}
