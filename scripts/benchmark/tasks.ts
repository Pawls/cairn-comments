/**
 * The task files: repositories, their base commits, the tasks run against them, and the
 * warm-up chains a deep run forks. `loadTaskFile` reads either kind of file: a round of
 * one-prompt tasks, or the deep-context probe set (docs/plans/benchmark-deep-context.md),
 * whose probes run fresh or after a warm-up chain.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/** A probe's `repo` and `start` are the probe set's, which `loadDeepTasks` copies onto it. */
interface ProbeBase extends TaskBase {
  /** Finding the code it needs, or reading a complicated function correctly. */
  use: "navigation" | "understanding";
  /**
   * Source files no warm-up chain may touch: where the answer lives, callers that lead
   * straight to it, and what the hidden tests import.
   */
  modules: string[];
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
  /** A program and its arguments separated by spaces, run from the checkout's root with no shell. */
  testCommand: string;
  /** Patterns for facts the final answer states; scored beside the hidden tests, never alone. */
  rubric?: string[];
}

export type Probe = PredictProbe | LocateProbe | ChangeProbe;

export type Task = EditTask | QuestionTask | Probe;

export function isEditTask(task: Task): task is EditTask {
  return task.kind === "fix" || task.kind === "feature";
}

/** A prediction or a location is answered from reading alone, so its run gets no shell and no edits. */
export function answersByReading(task: Task): boolean {
  return task.kind === "predict" || task.kind === "locate";
}

export interface TaskFile {
  repos: Record<string, RepoSpec>;
  tasks: Task[];
  /** A probe set's own warm-up chains. A round's file has none; its deep runs take `--warmups`. */
  chains?: WarmupChain[];
  /**
   * The one prepared entry every task and chain of a probe set uses, since all start at one
   * commit. A round prepares each task and chain under its own id.
   */
  sharedStart?: { id: string; repo: string; start: string };
}

/** A setup or test command with `{venv-python}` replaced by the checkout's virtualenv interpreter. */
export function expandCommand(command: string): string {
  const venvPython = process.platform === "win32" ? path.join(".venv", "Scripts", "python.exe") : ".venv/bin/python";
  return command.replaceAll("{venv-python}", venvPython);
}

/** The checkout's virtualenv interpreter, as an absolute path. */
export function venvPython(checkout: string): string {
  return path.resolve(checkout, expandCommand("{venv-python}"));
}

/** Room for a test run's or a git command's whole output. */
export const OUTPUT_LIMIT = 64 * 1024 * 1024;

/**
 * A warm-up chain, run as one session to put a probe deep into a full context: ordinary
 * work, one prompt after another. Stored as `<id>.json` without the id.
 */
export interface WarmupChain {
  /** The file name without `.json`. */
  id: string;
  repo: string;
  /** The commit the chain starts from; a probe forked from it must start there too. */
  start: string;
  /**
   * Every source file the chain's prompts lead the agent to read or change. A probe set
   * requires them, and refuses a probe that overlaps them.
   */
  modules?: string[];
  prompts: string[];
}

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

/** Why `parsed` is not a chain file's contents, or undefined when it is one. */
function chainProblem(parsed: unknown): string | undefined {
  const chain = parsed as Partial<WarmupChain> | null;
  if (typeof chain !== "object" || chain === null) return "not a JSON object";
  if (!isText(chain.repo) || !isText(chain.start)) return "needs a repo and a start commit";
  if (!Array.isArray(chain.prompts) || !chain.prompts.length || !chain.prompts.every((p) => isText(p))) {
    return "needs at least one prompt, each a string";
  }
  return undefined;
}

/** The chain in `file`, named by the file. */
function readChain(file: string): WarmupChain {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`warm-up chain ${file} is not JSON`, { cause: error });
  }
  const problem = chainProblem(parsed);
  if (problem) throw new Error(`warm-up chain ${file} ${problem}`);
  return { ...(parsed as Omit<WarmupChain, "id">), id: path.basename(file, ".json") };
}

/** Every chain in `dir`, one `<id>.json` file each holding `repo`, `start`, and `prompts`. */
export function loadChains(dir: string): Map<string, WarmupChain> {
  const chains = new Map<string, WarmupChain>();
  if (!existsSync(dir)) return chains;
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    const chain = readChain(path.join(dir, file));
    chains.set(chain.id, chain);
  }
  return chains;
}

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
      const chain = warmups.find((warmup) => warmup.modules?.includes(module));
      if (chain) throw new Error(`probe ${probe.id}: ${module} is also in warm-up chain ${chain.id}`);
    }
    for (const name of filesOf(probe)) {
      const file = probeFile(taskFile, probe.id, name);
      if (!existsSync(file)) throw new Error(`probe ${probe.id}: no ${file}`);
    }
  }
}

/** A probe set's chain, which must sit in the task file's folder and list its modules. */
function loadSetChain(taskFile: string, chainFile: string): WarmupChain {
  const folder = path.resolve(path.dirname(taskFile));
  const relative = path.relative(folder, path.resolve(folder, chainFile));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`warm-up chain ${chainFile} is outside ${folder}`);
  const chain = readChain(path.join(folder, relative));
  if (!chain.modules?.length) {
    throw new Error(`warm-up chain ${chain.id} lists no modules, so no probe can be checked against it`);
  }
  return chain;
}

function readTaskJson(file: string): Record<string, unknown> {
  // The task file is the operator's own --tasks choice on a local benchmark script.
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; // NOSONAR
}

type DeepTaskJson = Omit<DeepTaskFile, "warmups"> & { warmups: string[] };

function deepTasksFrom(file: string, parsed: DeepTaskJson): DeepTaskFile {
  if (!parsed.repos[parsed.repo]) throw new Error(`unknown repo ${parsed.repo}`);
  const warmups = parsed.warmups.map((chainFile) => loadSetChain(file, chainFile));
  for (const chain of warmups) {
    if (chain.repo !== parsed.repo || chain.start !== parsed.start) {
      throw new Error(`warm-up chain ${chain.id} starts at ${chain.repo}@${chain.start}, not ${parsed.repo}@${parsed.start}`);
    }
  }
  const probes = parsed.probes.map((probe) => ({ ...probe, repo: parsed.repo, start: parsed.start }));
  checkProbes(file, probes, warmups);
  return { ...parsed, warmups, probes };
}

export function loadDeepTasks(file: string): DeepTaskFile {
  return deepTasksFrom(file, readTaskJson(file) as unknown as DeepTaskJson);
}

/** A round's tasks, or a probe set's probes as tasks; a probe set is the file that has `probes`. */
export function loadTaskFile(file: string): TaskFile {
  const parsed = readTaskJson(file);
  if ("probes" in parsed) {
    const deep = deepTasksFrom(file, parsed as unknown as DeepTaskJson);
    return {
      repos: deep.repos,
      tasks: deep.probes,
      chains: deep.warmups,
      sharedStart: { id: DEEP_PREPARED_ID, repo: deep.repo, start: deep.start },
    };
  }
  const round = parsed as unknown as TaskFile;
  for (const task of round.tasks) {
    if (!round.repos[task.repo]) throw new Error(`task ${task.id}: unknown repo ${task.repo}`);
  }
  return round;
}
