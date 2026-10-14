/**
 * The task files: repositories, their base commits, and the tasks run against them.
 * `loadTasks` reads the one-prompt rounds; `loadDeepTasks` reads the deep-context probe set
 * (docs/plans/benchmark-deep-context.md), whose probes run fresh or after a warm-up chain.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface RepoSpec {
  url: string;
  /** The commit the frozen comments were written at; it precedes every task's start. */
  base: string;
  /** Shell commands run in each fresh checkout before the agent starts. */
  setup: string[];
  /**
   * "own-comments": the arms differ in the repository's own comments instead of Cairn's
   * (prepare.ts); `none` is the code with them stripped, `comments` is as committed.
   */
  treatment?: "own-comments";
  /**
   * Own-comments only: the lines of the AGENTS.md both arms get in place of the repository's
   * removed instructions, such as how to run a test file.
   */
  agentNotes?: string[];
}

interface TaskBase {
  id: string;
  repo: string;
  /** The commit the agent starts from. */
  start: string;
  prompt: string;
}

export interface EditTask extends TaskBase {
  kind: "fix" | "feature";
  /** The commit whose `testFiles` grade the run. */
  solution: string;
  testFiles: string[];
  /** Shell command, run from the checkout's root, that passes when the task is done. */
  testCommand: string;
}

export interface QuestionTask extends TaskBase {
  kind: "question";
  /** Patterns a correct answer matches, all of them (see `gradeAnswer`). */
  answerKey: string[];
}

export type Task = EditTask | QuestionTask;

export interface TaskFile {
  repos: Record<string, RepoSpec>;
  tasks: Task[];
}

/** A setup or test command with `{venv-python}` replaced by the checkout's virtualenv interpreter. */
export function expandCommand(command: string): string {
  const venvPython = process.platform === "win32" ? path.join(".venv", "Scripts", "python.exe") : ".venv/bin/python";
  return command.replaceAll("{venv-python}", venvPython);
}

export function loadTasks(file: string): TaskFile {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as TaskFile;
  for (const task of parsed.tasks) {
    if (!parsed.repos[task.repo]) throw new Error(`task ${task.id}: unknown repo ${task.repo}`);
  }
  return parsed;
}

/**
 * A warm-up chain, run as one session to put a probe deep into a full context: ordinary
 * work, one prompt after another. Stored as `<id>.json` without the id.
 */
export interface WarmupChain {
  id: string;
  repo: string;
  /** Must be the probes' start: a probe forks from the chain's checkout. */
  start: string;
  /** Every source file the chain's prompts lead the agent to read or change. */
  modules: string[];
  prompts: string[];
}

interface ProbeBase {
  id: string;
  /** Finding the code it needs, or reading a complicated function correctly. */
  use: "navigation" | "understanding";
  /**
   * Source files no warm-up chain may touch: where the answer lives, callers that lead
   * straight to it, and what the hidden tests import.
   */
  modules: string[];
  prompt: string;
}

/**
 * "What does this function return for these inputs?", answered from reading alone: the
 * harness must give the agent no shell, or it can run the function instead of reading it.
 * `probes/<id>/compute.py` prints `expected` by running the function.
 */
export interface PredictProbe extends ProbeBase {
  kind: "predict";
  /** The text after `ANSWER:` on the final answer's last such line (see `gradePrediction`). */
  expected: string;
  /** Patterns for facts a full explanation states; scored beside the prediction, never alone. */
  rubric?: string[];
}

/** "Which file and function decides this?", graded like a question task. */
export interface LocateProbe extends ProbeBase {
  kind: "locate";
  answerKey: string[];
}

/**
 * An edit graded by hidden tests. Each hidden test is `probes/<id>/<path>`, placed at
 * `<path>` in the checkout before `testCommand` runs; `probes/<id>/reference.patch` is a
 * solution against the comments arm (verify-probes.ts derives the stripped arm's).
 */
export interface ChangeProbe extends ProbeBase {
  kind: "change";
  hiddenTests: string[];
  /**
   * Existing test files put back to the arm's committed version before grading, so the
   * agent's edits to them do not count.
   */
  keptTests?: string[];
  testCommand: string;
  /** Patterns for facts the final answer states; scored beside the hidden tests, never alone. */
  rubric?: string[];
}

export type Probe = PredictProbe | LocateProbe | ChangeProbe;

/** The prepared-commit id the probe set's start is stored under (`prepared/deep/<arm>`). */
export const DEEP_PREPARED_ID = "deep";

export interface DeepTaskFile {
  repos: Record<string, RepoSpec>;
  repo: string;
  /** Every warm-up and probe starts here, so one deep session serves all the probes. */
  start: string;
  warmups: WarmupChain[];
  probes: Probe[];
}

/** A file belonging to a probe: `<task file's folder>/probes/<id>/<name>`. */
export function probeFile(taskFile: string, probeId: string, name: string): string {
  return path.join(path.dirname(taskFile), "probes", probeId, name);
}

function filesOf(probe: Probe): string[] {
  if (probe.kind === "predict") return ["compute.py"];
  if (probe.kind === "change") return [...probe.hiddenTests, "reference.patch"];
  return [];
}

function checkProbes(taskFile: string, probes: Probe[], warmups: WarmupChain[]): void {
  const ids = new Set<string>();
  for (const probe of probes) {
    if (ids.has(probe.id)) throw new Error(`duplicate probe id ${probe.id}`);
    ids.add(probe.id);
    for (const module of probe.modules) {
      const chain = warmups.find((warmup) => warmup.modules.includes(module));
      if (chain) throw new Error(`probe ${probe.id}: ${module} is also in warm-up chain ${chain.id}`);
    }
    for (const name of filesOf(probe)) {
      const file = probeFile(taskFile, probe.id, name);
      if (!existsSync(file)) throw new Error(`probe ${probe.id}: no ${file}`);
    }
  }
}

function loadChain(taskFile: string, chainFile: string): WarmupChain {
  const folder = path.resolve(path.dirname(taskFile));
  const relative = path.relative(folder, path.resolve(folder, chainFile));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`warm-up chain ${chainFile} is outside ${folder}`);
  const text = readFileSync(path.join(folder, relative), "utf8");
  const chain = JSON.parse(text) as Omit<WarmupChain, "id">;
  return { id: path.basename(chainFile, ".json"), ...chain };
}

export function loadDeepTasks(file: string): DeepTaskFile {
  // The task file is the operator's own --tasks choice on a local benchmark script.
  const text = readFileSync(file, "utf8"); // NOSONAR
  const parsed = JSON.parse(text) as Omit<DeepTaskFile, "warmups"> & { warmups: string[] };
  if (!parsed.repos[parsed.repo]) throw new Error(`unknown repo ${parsed.repo}`);
  const warmups = parsed.warmups.map((chainFile) => loadChain(file, chainFile));
  for (const chain of warmups) {
    if (chain.repo !== parsed.repo || chain.start !== parsed.start) {
      throw new Error(`warm-up chain ${chain.id} starts at ${chain.repo}@${chain.start}, not ${parsed.repo}@${parsed.start}`);
    }
  }
  checkProbes(file, parsed.probes, warmups);
  return { ...parsed, warmups };
}

/** The same limit as runner.ts's edit grading, so a probe that hangs fails here as it would there. */
const TEST_TIMEOUT_MS = 20 * 60 * 1000;
export const OUTPUT_LIMIT = 64 * 1024 * 1024;

export interface ChangeGrade {
  passed: boolean;
  testExit: number | null;
  output: string;
}

/**
 * Grades a change probe in `checkout`: copies each named hidden test into place (never a
 * whole folder, so local bytecode stays behind), puts `keptTests` back to `committed`, and
 * runs `testCommand`. `committed` is the arm's prepared commit when HEAD has moved past it.
 */
export function gradeChangeProbe(
  taskFile: string,
  probe: ChangeProbe,
  checkout: string,
  env: Record<string, string>,
  committed = "HEAD",
): ChangeGrade {
  for (const test of probe.hiddenTests) {
    const destination = path.join(checkout, test);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(probeFile(taskFile, probe.id, test), destination);
  }
  if (probe.keptTests?.length) {
    execFileSync("git", ["checkout", committed, "--", ...probe.keptTests], { cwd: checkout, env, stdio: "ignore" }); // NOSONAR: git comes from PATH, as for any tool that drives git
  }
  const run = spawnSync(expandCommand(probe.testCommand), {
    cwd: checkout,
    env,
    shell: true,
    encoding: "utf8",
    timeout: TEST_TIMEOUT_MS,
    maxBuffer: OUTPUT_LIMIT,
  });
  return { passed: run.status === 0, testExit: run.status, output: `${run.stdout}\n${run.stderr}` };
}

/** Markdown a model wraps an answer line in: emphasis, code spans, quote markers. */
const DECORATION = /[*_`>]/g;

/** The text after `ANSWER:` on one line, or undefined when the line is not an answer line. */
function answerOn(line: string): string | undefined {
  let plain = line.replaceAll(DECORATION, "").trim();
  if (plain.startsWith("-")) plain = plain.slice(1).trim(); // a list item
  if (!plain.toLowerCase().startsWith("answer:")) return undefined;
  return plain.slice("answer:".length).replace(/\.$/, "");
}

function normalized(text: string): string {
  return text.trim().replaceAll(/\s+/g, " ").toLowerCase();
}

/**
 * Exact match on the last `ANSWER:` line of the final answer, so a run that changes its
 * mind is graded on where it ended. Spacing, case, markdown decoration and a closing period
 * do not count.
 */
export function gradePrediction(finalText: string, expected: string): { passed: boolean; missing: string[] } {
  const last = finalText
    .split("\n")
    .map((line) => answerOn(line))
    .findLast((answer) => answer !== undefined);
  const passed = last !== undefined && normalized(last) === normalized(expected);
  return { passed, missing: passed ? [] : [`ANSWER: ${expected}`] };
}
