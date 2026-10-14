/**
 * One benchmark run: the harness on one task in one arm, and its grade. A `fresh` run
 * starts an empty session in a new checkout; a `deep` run forks a warm-up chain's session
 * in the chain's checkout (warmup.ts).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { outputStem, readLog, refuseFailedSession, runAgent, type AgentOptions } from "./agent.ts";
import { forkTotals, harnessTotals, type HarnessName, type HarnessTotals } from "./harnesses.ts";
import {
  gradeAnswer,
  gradeChangeProbe,
  gradePrediction,
  probeCalls,
  runMetrics,
  runShellTest,
  type AnswerGrade,
  type RunMetrics,
} from "./metrics.ts";
import type { PreparedTask } from "./prepare.ts";
import { startRecordingProxy } from "./proxy.ts";
import { answersByReading, OUTPUT_LIMIT, type EditTask, type RepoSpec, type Task, type WarmupChain } from "./tasks.ts";
import { ensureWarmup, refuseUnfinished, restoreWarmup } from "./warmup.ts";
import { ARMS, git, isolatedEnv, neutralName, placedCommentBytes, removeCheckouts, setUpCheckout, type Arm } from "./workspace.ts";

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
  /** Exit code of the test command, for an edit task or a change probe. */
  testExit?: number | null;
  /** What the answer lacked, for a question, a location, or a prediction (`AnswerGrade`). */
  missing?: string[];
  /** The probe's rubric against the final answer: a secondary score, never part of `passed`. */
  rubric?: AnswerGrade;
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

/** A run's directory; its name hides the arm (`neutralName`), which result.json records. */
export function runDirFor(spec: { workDir: string; harness: HarnessName; task: Task; arm: Arm; rep: number; chain?: WarmupChain }): string {
  return path.join(spec.workDir, "runs", spec.harness, spec.task.id, neutralName(spec.arm, spec.chain?.id, spec.rep));
}

/**
 * Run directories under the `<arm>-<rep>` names used before they were hashed. `run` and
 * `status` cannot find those results, and `report` would count them beside new ones.
 */
export function legacyRunDirs(workDir: string): string[] {
  const runs = path.join(workDir, "runs");
  if (!existsSync(runs)) return [];
  const legacyName = new RegExp(String.raw`^(${ARMS.join("|")})-\d+$`);
  return readdirSync(runs, { recursive: true, encoding: "utf8" })
    .filter((file) => path.basename(file) === "result.json" && legacyName.test(path.basename(path.dirname(file))))
    .map((file) => path.join(runs, path.dirname(file)));
}

/** Puts the solution's tests, read from the mirror, over the agent's work. */
function placeSolutionTests(task: EditTask, mirror: string, agentDir: string, env: Record<string, string>): void {
  for (const file of task.testFiles) {
    const content = execFileSync("git", ["--git-dir", mirror, "show", `${task.solution}:${file}`], { env, maxBuffer: OUTPUT_LIMIT }); // NOSONAR: git comes from PATH, as for any tool that drives git
    mkdirSync(path.dirname(path.join(agentDir, file)), { recursive: true });
    writeFileSync(path.join(agentDir, file), content);
  }
}

/** Puts the solution's tests over the agent's work and runs the task's test command. */
function gradeEdit(task: EditTask, spec: RunSpec, agentDir: string, env: Record<string, string>, runDir: string): Grade {
  // A Cairn checkout has the solution and checks it out through its filters, as the recorded
  // rounds did; a prepared clone lacks it.
  if (spec.prepared) placeSolutionTests(task, spec.mirror, agentDir, env);
  else git(agentDir, env, "checkout", task.solution, "--", ...task.testFiles);
  const test = runShellTest(task.testCommand, agentDir, env);
  writeFileSync(path.join(runDir, "test.log"), test.output);
  return { passed: test.passed, testExit: test.testExit };
}

/** The rubric's score beside a probe's grade, when the probe has a rubric. */
function rubricOf(rubric: string[] | undefined, finalText: string): Pick<Grade, "rubric"> {
  return rubric ? { rubric: gradeAnswer(finalText, rubric) } : {};
}

function grade(spec: RunSpec, finalText: string, start: Start, env: Record<string, string>, runDir: string): Grade {
  const { task } = spec;
  switch (task.kind) {
    case "question":
    case "locate":
      return gradeAnswer(finalText, task.answerKey);
    case "predict":
      return { ...gradePrediction(finalText, task.expected), ...rubricOf(task.rubric, finalText) };
    case "change": {
      const test = gradeChangeProbe(task, start.agentDir, env, start.committed);
      writeFileSync(path.join(runDir, "test.log"), test.output);
      return { passed: test.passed, testExit: test.testExit, ...rubricOf(task.rubric, finalText) };
    }
    default:
      return gradeEdit(task, spec, start.agentDir, env, runDir);
  }
}

/** Where the probe runs, and the session it forks from, if any. */
interface Start {
  agentDir: string;
  homeDir: string;
  /**
   * The arm's commit, read from the `repo` worktree beside the agent's before the probe runs.
   * A warm-up or the probe may commit on the agent's branch, which moves only the agent's HEAD.
   */
  committed: string;
  from?: string;
  /** The output of the last prompt before the fork, whose totals a Claude Code fork carries. */
  parentOutput?: string;
  commentBytes: Record<string, number>;
}

/** The commit the checkout in `dir` started from (see `Start.committed`). */
function committedIn(dir: string, env: Record<string, string>): string {
  return git(path.join(dir, "repo"), env, "rev-parse", "HEAD").trim();
}

/** A new checkout in the run's own directory, and a new session. */
function freshStart(spec: RunSpec, runDir: string, env: Record<string, string>): Start {
  const checkout = setUpCheckout({ ...spec, dir: runDir, start: spec.task.start, setup: spec.repo.setup, env });
  return { ...checkout, homeDir: runDir, committed: committedIn(runDir, env) };
}

/** The warm-up's checkout as the chain left it, and a fork of its session. */
async function deepStart(
  spec: RunSpec,
  warmupSpec: NonNullable<RunSpec["warmup"]>,
  logFile: string,
  env: Record<string, string>,
): Promise<Start> {
  const { chain, prepared } = warmupSpec;
  if (chain.repo !== spec.task.repo || chain.start !== spec.task.start) {
    throw new Error(`task ${spec.task.id} does not start where warm-up ${chain.id} does (${chain.repo} at ${chain.start})`);
  }
  const ready = await ensureWarmup({ ...spec, chain, prepared });
  refuseUnfinished(ready);
  restoreWarmup(ready, logFile, env);
  const { dir, warmup } = ready;
  return {
    agentDir: path.join(dir, "agent"),
    homeDir: dir,
    committed: committedIn(dir, env),
    from: warmup.sessionId,
    parentOutput: `${outputStem(dir, chain.prompts.length)}.jsonl`,
    commentBytes: placedCommentBytes(spec.arm, dir, env, prepared),
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
  const runDir = runDirFor({ ...spec, chain: spec.warmup?.chain });
  mkdirSync(runDir, { recursive: true });
  const env = isolatedEnv(path.join(runDir, "state"), path.join(spec.workDir, "cli-home"));
  const logFile = path.join(runDir, "calls.jsonl");
  const start = spec.warmup ? await deepStart(spec, spec.warmup, logFile, env) : freshStart(spec, runDir, env);

  const proxy = await startRecordingProxy(spec.provider, logFile, "probe");
  const startedAt = new Date();
  const dirs = { agentDir: start.agentDir, homeDir: start.homeDir, outputDir: runDir };
  const agent = { ...spec, readOnly: answersByReading(spec.task) };
  const prompts = [spec.task.prompt];
  const session = await runAgent(agent, prompts, dirs, env, proxy.url, start.from).finally(() => proxy.close());
  const wallMs = Date.now() - startedAt.getTime();
  const exit = session.exits[0];
  if (!exit) throw new Error("the probe's prompt never ran");

  const log = readLog(logFile);
  // On a failure there is no result.json, so the next batch runs this one again; the checkouts stay for a look.
  refuseFailedSession(probeCalls(log), `task ${spec.task.id}`);
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
    grade: grade(spec, metrics.finalText, start, env, runDir),
    metrics,
    harnessTotals: probeTotals(spec.harness, start, runDir),
    commentBytes: start.commentBytes,
    commentBytesRead: metrics.filesRead.reduce((sum, file) => sum + (start.commentBytes[file] ?? 0), 0),
  };
  writeFileSync(path.join(runDir, "result.json"), JSON.stringify(result, null, 2));
  // A deep run's checkouts are its warm-up's, so its own directory has none to remove.
  if (!spec.keep) removeCheckouts(runDir);
  return result;
}
