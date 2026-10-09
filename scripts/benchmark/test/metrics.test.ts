import path from "node:path";
import { describe, expect, it } from "vitest";
import { gradeAnswer, runMetrics, type LoggedCall } from "../metrics.ts";

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
