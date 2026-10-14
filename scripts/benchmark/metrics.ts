/** Per-run measurements taken from the recording proxy's log, and the graders that score a run. */
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { ModelResponse, Usage } from "./responses.ts";
import { expandCommand, probeFile, type ChangeProbe } from "./tasks.ts";

/**
 * Which part of a run made a call: a deep run's warm-up chain, or the probe itself, which
 * makes every call of a fresh run.
 */
export type Phase = "warmup" | "probe";

/** One line of the proxy log: a request and, for a model call, its parsed response. */
export interface LoggedCall {
  path: string;
  status: number;
  /** Time from the request reaching the proxy to the response's last byte. */
  ms: number;
  /** Absent in logs written before runs had phases; those calls are all the probe's. */
  phase?: Phase;
  /**
   * How many tools a model call's request declared. The agent's own loop declares its tools
   * on every call; side calls (titles, summaries) declare none. Absent in older logs.
   */
  tools?: number;
  response?: ModelResponse;
}

/** A call of the agent's own loop, as far as the log can tell. */
export function isAgentCall(call: LoggedCall): boolean {
  return call.tools === undefined || call.tools > 0;
}

/** The context of the first agent call in `calls` that has a response, or 0 when none does. */
export function firstAgentContext(calls: LoggedCall[]): number {
  const first = calls.find((call) => call.response && isAgentCall(call))?.response;
  return first ? contextOf(first.usage) : 0;
}

/** Every input token: uncached, read from cache, and written to it. For one call, its context. */
export function contextOf(usage: Usage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

/** The probe's calls; a deep run's log also holds its warm-up's. */
export function probeCalls(log: LoggedCall[]): LoggedCall[] {
  return log.filter((call) => call.phase !== "warmup");
}

/** Each harness's file-reading tool and the argument that names the file. */
const READ_TOOLS = new Map([
  ["Read", "file_path"],
  ["read", "path"],
]);

export interface RunMetrics {
  /** Every model call of the probe, side calls (titles, summaries) included. */
  calls: number;
  /** The context of the probe's first agent call (not a side call); at depth `deep` that includes the warm-up. */
  firstCallContext: number;
  /** Calls to the run's own model. */
  turns: number;
  tokens: Usage;
  toolCalls: Record<string, number>;
  /** Distinct files read, relative to the agent's directory with `/` separators. */
  filesRead: string[];
  /** The run model's last text: the answer to a question task. */
  finalText: string;
}

function relativeToAgent(agentDir: string, file: string): string {
  const relative = path.relative(agentDir, path.resolve(agentDir, file));
  return relative.split(path.sep).join("/");
}

/**
 * Measures the probe's calls only; a deep run's log also holds its warm-up's. `model`
 * matches by prefix, since the API may answer with a dated id for the alias the harness
 * asked for.
 */
export function runMetrics(log: LoggedCall[], options: { model: string; agentDir: string }): RunMetrics {
  const ownCalls = probeCalls(log);
  const responses = ownCalls.flatMap((call) => (call.response ? [call.response] : []));
  const ownModel = responses.filter((r) => r.model.startsWith(options.model));
  const tokens: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const toolCalls: Record<string, number> = {};
  const filesRead = new Set<string>();
  for (const response of responses) {
    tokens.input += response.usage.input;
    tokens.output += response.usage.output;
    tokens.cacheRead += response.usage.cacheRead;
    tokens.cacheWrite += response.usage.cacheWrite;
    for (const tool of response.tools) {
      toolCalls[tool.name] = (toolCalls[tool.name] ?? 0) + 1;
      const fileArgument = READ_TOOLS.get(tool.name);
      const file = fileArgument && tool.input[fileArgument];
      if (typeof file === "string") filesRead.add(relativeToAgent(options.agentDir, file));
    }
  }
  return {
    calls: responses.length,
    firstCallContext: firstAgentContext(ownCalls),
    turns: ownModel.length,
    tokens,
    toolCalls,
    filesRead: [...filesRead].sort((a, b) => a.localeCompare(b)),
    finalText: ownModel.findLast((r) => r.text !== "")?.text ?? "",
  };
}

/**
 * The run says nothing about the agent: the model server failed a call (a 5xx, or the
 * proxy's 502 when it could not connect), or no model call succeeded at all, as when the
 * server rejects every request the harness makes.
 */
export function providerFailed(log: LoggedCall[]): boolean {
  return log.some((call) => call.status >= 500) || !log.some((call) => call.response);
}

export interface AnswerGrade {
  passed: boolean;
  /** What the answer lacked: answer-key patterns, or the expected `ANSWER:` line. */
  missing: string[];
}

/** An answer passes when it matches every pattern in the key, ignoring case. */
export function gradeAnswer(answer: string, key: string[]): AnswerGrade {
  const missing = key.filter((pattern) => !new RegExp(pattern, "i").test(answer));
  return { passed: missing.length === 0, missing };
}

/** Markdown a model puts around an answer line: emphasis, code spans, quote markers. */
const LINE_DECORATION = new Set(["*", "_", "`", ">"]);
/** ...and around the answer's value; an underscore or sign inside it is part of the answer. */
const VALUE_DECORATION = new Set(["*", "`"]);

/** `text` without the whitespace and `decoration` characters at either end. */
function trimDecoration(text: string, decoration: Set<string>): string {
  const isEdge = (char: string) => decoration.has(char) || char.trim() === "";
  let start = 0;
  let end = text.length;
  while (start < end && isEdge(text.charAt(start))) start += 1;
  while (end > start && isEdge(text.charAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/** A list item's marker: `-`, `+`, `1.` or `1)`, then a space. */
const LIST_MARKER = /^(?:[-+]|\d+[.)])\s+/;

/** The text after `ANSWER:` on one line, or undefined when the line is not an answer line. */
function answerOn(line: string): string | undefined {
  let plain = trimDecoration(line, LINE_DECORATION);
  const marker = LIST_MARKER.exec(plain);
  if (marker) plain = trimDecoration(plain.slice(marker[0].length), LINE_DECORATION);
  if (!plain.toLowerCase().startsWith("answer:")) return undefined;
  const value = trimDecoration(plain.slice("answer:".length), VALUE_DECORATION);
  return trimDecoration(value.endsWith(".") ? value.slice(0, -1) : value, VALUE_DECORATION);
}

function normalized(text: string): string {
  return text.trim().replaceAll(/\s+/g, " ").toLowerCase();
}

/**
 * Exact match on the last `ANSWER:` line of the final answer, so a run that changes its
 * mind is graded on where it ended. Spacing, case, markdown decoration and a closing period
 * do not count.
 */
export function gradePrediction(finalText: string, expected: string): AnswerGrade {
  const last = finalText
    .split("\n")
    .map((line) => answerOn(line))
    .findLast((answer) => answer !== undefined);
  const passed = last !== undefined && normalized(last) === normalized(expected);
  return { passed, missing: passed ? [] : [`ANSWER: ${expected}`] };
}

/** Long enough for any task's tests; a test run that hangs fails rather than stalling the batch. */
const TEST_TIMEOUT_MS = 20 * 60 * 1000;
/** Room for a test run's or a git command's whole output. */
export const OUTPUT_LIMIT = 64 * 1024 * 1024;

export interface TestRun {
  passed: boolean;
  testExit: number | null;
  /** Standard output, then standard error. */
  output: string;
}

function testOptions(cwd: string, env: Record<string, string>) {
  return { cwd, env, encoding: "utf8", timeout: TEST_TIMEOUT_MS, maxBuffer: OUTPUT_LIMIT } as const;
}

function testRunOf(run: SpawnSyncReturns<string>): TestRun {
  return { passed: run.status === 0, testExit: run.status, output: `${run.stdout}\n${run.stderr}` };
}

/** Runs a round's test command, a shell command line (`&&` and all), from `cwd`. */
export function runShellTest(command: string, cwd: string, env: Record<string, string>): TestRun {
  return testRunOf(spawnSync(expandCommand(command), { ...testOptions(cwd, env), shell: true }));
}

/**
 * Runs a probe's test command, a program and its arguments, from `cwd` with no shell, so the
 * timeout stops the test process itself rather than a shell around it.
 */
function runProgramTest(command: string, cwd: string, env: Record<string, string>): TestRun {
  const [program, args] = programArgs(command, cwd);
  return testRunOf(spawnSync(program, args, testOptions(cwd, env)));
}

/**
 * A probe's test command split into its program and arguments, with `{venv-python}` expanded
 * and a relative program path resolved against `cwd`. Words are split on spaces, with no quoting.
 */
function programArgs(command: string, cwd: string): [string, string[]] {
  const [program = "", ...args] = expandCommand(command).split(" ").filter(Boolean);
  const isPath = program.includes("/") || program.includes("\\");
  return [isPath ? path.resolve(cwd, program) : program, args];
}

/**
 * Grades a change probe in `checkout`: copies each named hidden test into place (never a
 * whole folder, so local bytecode stays behind), puts `keptTests` back to `committed`, and
 * runs `testCommand`. `committed` is the arm's prepared commit when HEAD has moved past it.
 */
export function gradeChangeProbe(
  probe: ChangeProbe,
  checkout: string,
  env: Record<string, string>,
  committed = "HEAD",
): TestRun {
  for (const test of probe.hiddenTests) {
    const destination = path.join(checkout, test);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(probeFile(probe, test), destination);
  }
  if (probe.keptTests?.length) {
    execFileSync("git", ["checkout", committed, "--", ...probe.keptTests], { cwd: checkout, env, stdio: "ignore" }); // NOSONAR: git comes from PATH, as for any tool that drives git
  }
  return runProgramTest(probe.testCommand, checkout, env);
}
