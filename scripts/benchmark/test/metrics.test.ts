import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gradeAnswer, gradeChangeProbe, gradePrediction, providerFailed, runMetrics, type LoggedCall } from "../metrics.ts";
import type { ChangeProbe } from "../tasks.ts";
import { CHANGE_CHECK, makeRepo, writeUnder, type Repo } from "./fixtures.ts";

const agentDir = path.resolve("/work/run/agent");

function call(model: string, tools: { name: string; input: Record<string, unknown> }[], text = ""): LoggedCall {
  return {
    path: "/v1/messages",
    status: 200,
    ms: 10,
    response: { model, usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 }, tools, text },
  };
}

describe("runMetrics", () => {
  it("sums usage over every call and counts turns of the run's model only", () => {
    const calls = [
      call("claude-haiku-5-5", []),
      call("claude-sonnet-5-5-20261001", []),
      call("claude-sonnet-5-5-20261001", []),
    ];

    const metrics = runMetrics(calls, { model: "claude-sonnet-5-5", agentDir });

    expect(metrics.calls).toBe(3);
    expect(metrics.turns).toBe(2);
    expect(metrics.tokens).toEqual({ input: 30, output: 15, cacheRead: 300, cacheWrite: 60 });
  });

  it("counts tool calls by name and distinct files read, by either harness's read tool", () => {
    const calls = [
      call("m", [
        { name: "Read", input: { file_path: path.join(agentDir, "src", "a.ts") } },
        { name: "Grep", input: { pattern: "x" } },
      ]),
      call("m", [
        { name: "read", input: { path: "src/a.ts" } },
        { name: "read", input: { path: "src/b.ts", offset: 10 } },
      ]),
    ];

    const metrics = runMetrics(calls, { model: "m", agentDir });

    expect(metrics.toolCalls).toEqual({ Read: 1, Grep: 1, read: 2 });
    expect(metrics.filesRead).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("takes the final answer from the run model's last call that wrote text", () => {
    const calls = [call("m", [], "first"), call("m", [], "the answer"), call("m", []), call("haiku", [], "a title")];

    expect(runMetrics(calls, { model: "m", agentDir }).finalText).toBe("the answer");
  });

  it("ignores calls without a parsed response", () => {
    const calls: LoggedCall[] = [{ path: "/v1/messages/count_tokens", status: 200, ms: 3 }, call("m", [])];

    expect(runMetrics(calls, { model: "m", agentDir }).calls).toBe(1);
  });

  it("measures only the probe's calls of a log that also holds its warm-up's", () => {
    const warmup = { ...call("m", [{ name: "Read", input: { file_path: "warm.ts" } }], "warm-up answer"), phase: "warmup" as const };
    const probe = { ...call("m", [], "probe answer"), phase: "probe" as const };

    const metrics = runMetrics([warmup, warmup, probe], { model: "m", agentDir });

    expect(metrics.calls).toBe(1);
    expect(metrics.tokens.input).toBe(10);
    expect(metrics.filesRead).toEqual([]);
    expect(metrics.finalText).toBe("probe answer");
  });

  it("gives the context of the probe's first call: uncached input and both cache counts", () => {
    const warmup = { ...call("m", []), phase: "warmup" as const };
    const usage = { input: 7, output: 1, cacheRead: 150_000, cacheWrite: 300 };
    const first: LoggedCall = { path: "/v1/messages", status: 200, ms: 10, phase: "probe", response: { model: "m", usage, tools: [], text: "" } };

    expect(runMetrics([warmup, first, call("m", [])], { model: "m", agentDir }).firstCallContext).toBe(150_307);
  });

  it("takes the first-call context from the agent's own call, not a side call without tools that finished first", () => {
    const usage = (input: number) => ({ input, output: 1, cacheRead: 0, cacheWrite: 0 });
    const logged = (input: number, tools: number): LoggedCall => ({
      path: "/v1/messages",
      status: 200,
      ms: 10,
      phase: "probe",
      tools,
      response: { model: "m", usage: usage(input), tools: [], text: "" },
    });

    expect(runMetrics([logged(300, 0), logged(150_000, 12)], { model: "m", agentDir }).firstCallContext).toBe(150_000);
  });

  it("gives the context of the probe's last agent call, so the tokens a run added can be read off", () => {
    const usage = (input: number) => ({ input, output: 1, cacheRead: 0, cacheWrite: 0 });
    const logged = (input: number, tools: number): LoggedCall => ({
      path: "/v1/messages",
      status: 200,
      ms: 10,
      phase: "probe",
      tools,
      response: { model: "m", usage: usage(input), tools: [], text: "" },
    });

    expect(runMetrics([logged(4_000, 12), logged(9_000, 12), logged(50, 0)], { model: "m", agentDir }).finalContext).toBe(9_000);
  });

  it("counts the context a run grew by across compactions, and its last output, without counting earlier output twice", () => {
    const logged = (input: number, output: number): LoggedCall => ({
      path: "/v1/messages",
      status: 200,
      ms: 10,
      phase: "probe",
      tools: 12,
      response: { model: "m", usage: { input, output, cacheRead: 0, cacheWrite: 0 }, tools: [], text: "" },
    });
    // 4k to 9k to 200k, compacted to 30k, then 35k: growth 5k + 191k + 5k, plus the last call's 700 of output.
    const log = [logged(4_000, 100), logged(9_000, 100), logged(200_000, 100), logged(30_000, 100), logged(35_000, 700)];

    expect(runMetrics(log, { model: "m", agentDir }).grownTokens).toBe(201_700);
  });

  it("counts every call of a log written before calls had phases", () => {
    expect(runMetrics([call("m", []), call("m", [])], { model: "m", agentDir }).calls).toBe(2);
  });
});

describe("providerFailed", () => {
  it("is true when the model server answered any call with a server error", () => {
    expect(providerFailed([call("m", []), { path: "/v1/messages", status: 502, ms: 1 }])).toBe(true);
    expect(providerFailed([{ path: "/v1/messages", status: 503, ms: 1 }])).toBe(true);
  });

  it("is true when the harness never reached the model", () => {
    expect(providerFailed([])).toBe(true);
  });

  it("is true when the server rejected every model call, as when it does not accept the harness's requests", () => {
    expect(providerFailed([{ path: "/v1/messages", status: 400, ms: 1 }, { path: "/v1/messages", status: 400, ms: 1 }])).toBe(
      true,
    );
  });

  it("is false when every call succeeded or failed on the client's side", () => {
    expect(providerFailed([call("m", []), { path: "/v1/messages/count_tokens", status: 404, ms: 1 }])).toBe(false);
  });
});

describe("gradeAnswer", () => {
  it("passes when every key pattern matches, ignoring case", () => {
    expect(gradeAnswer("It calls placeComments and RETURNS null.", ["placeComments", "returns (null|undefined)"])).toEqual({
      passed: true,
      missing: [],
    });
  });

  it("lists the patterns an answer misses", () => {
    expect(gradeAnswer("It calls placeComments.", ["placeComments", "returns null"])).toEqual({
      passed: false,
      missing: ["returns null"],
    });
  });
});

describe("gradeChangeProbe", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "change-probe-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function probe(testCommand: string): ChangeProbe {
    return {
      id: "p",
      repo: "r",
      start: "s",
      dir: path.join(dir, "probes", "p"),
      use: "understanding",
      kind: "change",
      modules: [],
      prompt: "",
      hiddenTests: ["tests/hidden.txt"],
      keptTests: ["tests/kept.txt"],
      testCommand,
    };
  }

  /** A committed checkout whose kept test the agent then edited, and the probe's hidden files. */
  function checkout(): Repo {
    const failing = 'console.log("nope");\nprocess.exit(3);\n';
    const committed = makeRepo(dir, { "tests/kept.txt": "good", "check.mjs": CHANGE_CHECK, "fail.mjs": failing });
    writeUnder(committed.repo, "tests/kept.txt", "edited by the agent");
    writeUnder(dir, "probes/p/tests/hidden.txt", "hidden");
    writeUnder(dir, "probes/p/tests/__pycache__/hidden.cpython-313.pyc", "bytecode");
    return committed;
  }

  it("places the named hidden tests, puts the kept tests back, and passes when the command does", () => {
    const { repo, env } = checkout();

    const grade = gradeChangeProbe(probe("node check.mjs"), repo, env);

    expect(grade.passed).toBe(true);
    expect(readFileSync(path.join(repo, "tests", "kept.txt"), "utf8")).toBe("good");
    expect(existsSync(path.join(repo, "tests", "__pycache__"))).toBe(false);
  });

  it("fails with the command's exit code and keeps its output", () => {
    const { repo, env } = checkout();

    const grade = gradeChangeProbe(probe("node fail.mjs"), repo, env);

    expect(grade).toMatchObject({ passed: false, testExit: 3 });
    expect(grade.output).toContain("nope");
  });

  it("runs the command without a shell, so a timeout stops the test process itself", () => {
    const { repo, env } = checkout();

    const grade = gradeChangeProbe(probe("node fail.mjs || node check.mjs"), repo, env);

    expect(grade.testExit).toBe(3);
  });
});

describe("gradePrediction", () => {
  it("passes when the last ANSWER line matches, ignoring spacing and case", () => {
    const text = "Working it out...\nANSWER: 7 cells\nOn reflection:\nanswer:  keep=6   level=2 \n";

    expect(gradePrediction(text, "keep=6 level=2")).toEqual({ passed: true, missing: [] });
  });

  it("reads an ANSWER line through markdown emphasis, code spans, and a closing period", () => {
    for (const line of ["**ANSWER:** keep=6 level=2", "ANSWER: `keep=6 level=2`", "- **ANSWER: keep=6 level=2.**", "> Answer: keep=6 level=2"]) {
      expect(gradePrediction(`Reasoning.\n${line}\n`, "keep=6 level=2").passed, line).toBe(true);
    }
  });

  it("reads an ANSWER line that is a numbered or plus-marked list item", () => {
    for (const line of ["1. ANSWER: keep=6 level=2", "2) **ANSWER:** keep=6 level=2", "+ ANSWER: keep=6 level=2"]) {
      expect(gradePrediction(`Reasoning.\n${line}\n`, "keep=6 level=2").passed, line).toBe(true);
    }
  });

  it("keeps underscores and comparison signs inside the answer itself", () => {
    expect(gradePrediction("**ANSWER:** `spilled_cells=0 level>3`.", "spilled_cells=0 level>3").passed).toBe(true);
  });

  it("fails on an earlier ANSWER line that a later one replaced", () => {
    const text = "ANSWER: keep=6 level=2\nNo, wait.\nANSWER: keep=7 level=2\n";

    expect(gradePrediction(text, "keep=6 level=2").passed).toBe(false);
  });

  it("fails when there is no ANSWER line, even if the text contains the answer", () => {
    expect(gradePrediction("I think keep=6 level=2.", "keep=6 level=2")).toEqual({ passed: false, missing: ["ANSWER: keep=6 level=2"] });
  });
});
