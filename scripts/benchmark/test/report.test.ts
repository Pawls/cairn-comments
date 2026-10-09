import { describe, expect, it } from "vitest";
import { renderReport } from "../report.ts";
import type { RunResult } from "../runner.ts";

function result(task: string, arm: "none" | "comments", input: number, passed: boolean): RunResult {
  return {
    harness: "claude",
    task,
    repo: "r",
    kind: "fix",
    arm,
    rep: 1,
    model: "m",
    startedAt: "2026-10-09T00:00:00.000Z",
    wallMs: 60_000,
    exitCode: 0,
    timedOut: false,
    grade: { passed, testExit: passed ? 0 : 1 },
    metrics: {
      calls: 4,
      turns: 3,
      tokens: { input, output: 100, cacheRead: 0, cacheWrite: 0 },
      toolCalls: { Read: 2 },
      filesRead: ["a.ts"],
      finalText: "",
    },
    harnessTotals: { costUsd: 0.5, tokens: { input, output: 100, cacheRead: 0, cacheWrite: 0 } },
    commentBytes: arm === "comments" ? { "a.ts": 400 } : {},
    commentBytesRead: arm === "comments" ? 400 : 0,
  };
}

describe("renderReport", () => {
  const results = [
    result("t1", "none", 1000, true),
    result("t1", "none", 1200, false),
    result("t1", "comments", 800, true),
    result("t1", "comments", 900, true),
    result("t2", "none", 500, true),
    result("t2", "comments", 600, true),
  ];
  const report = renderReport(results);

  it("gives each arm's success count and median input tokens with the IQR", () => {
    expect(report).toContain("| none | 2/3 |");
    expect(report).toMatch(/\| none \| .*\| 1,000 \(750 to 1,100\) \|/);
    expect(report).toMatch(/\| comments \| 3\/3 \|.*\| 800 \(700 to 850\) \|/);
  });

  it("pairs the arms task by task", () => {
    expect(report).toMatch(/\| t1 \| 1\/2 \| 2\/2 \| 1,100 \| 850 \| -22\.7% \|/);
    expect(report).toMatch(/\| t2 \| 1\/1 \| 1\/1 \| 500 \| 600 \| \+20\.0% \|/);
  });

  it("states how far the proxy's totals are from the harness's own", () => {
    expect(report).toContain("largest difference between proxy and harness token totals: 0.0%");
  });
});
