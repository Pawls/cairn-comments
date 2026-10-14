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
      firstCallContext: input / 2,
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

  it("gives the median per-task change with a bootstrap interval", () => {
    expect(report).toMatch(/input tokens, all -1\.4% \(95% interval -?\d+\.\d% to \+\d+\.\d%; lower on 1 of 2 tasks\)/);
  });

  it("reads a result written before depths existed as fresh", () => {
    expect(report).toContain("## claude, fresh (m)");
    expect(report).not.toContain("deep");
  });

  it("gives the median context of the first call", () => {
    expect(report).toContain("First-call context");
    expect(report).toMatch(/\| none \| 2\/3 \| .*\| 500 \(375 to 550\) \|/);
  });

  it("leaves out cost for a harness that reports none", () => {
    const free = results.map((r) => ({ ...r, harnessTotals: { ...r.harnessTotals!, costUsd: 0 } }));
    const freeReport = renderReport(free);

    expect(report).toContain("Cost ($)");
    expect(freeReport).not.toContain("Cost ($)");
    expect(freeReport).not.toContain("cost ($)");
    expect(freeReport).not.toContain("NaN");
  });
});

describe("renderReport with deep runs", () => {
  const deep = (r: RunResult): RunResult => ({ ...r, depth: "deep", chain: "w1" });
  const report = renderReport([
    result("t1", "none", 1000, true),
    result("t1", "comments", 800, true),
    deep(result("t1", "none", 150_000, false)),
    deep(result("t1", "comments", 140_000, true)),
  ]);
  const [fresh, deepSection] = report.split("## claude, deep (m)");

  it("reports each depth in a section of its own", () => {
    expect(fresh).toContain("## claude, fresh (m)");
    expect(deepSection).toBeDefined();
  });

  it("keeps each depth's runs out of the other's tables", () => {
    expect(fresh).toMatch(/\| t1 \| 1\/1 \| 1\/1 \| 1,000 \| 800 \| -20\.0% \|/);
    expect(deepSection).toMatch(/\| t1 \| 0\/1 \| 1\/1 \| 150,000 \| 140,000 \| -6\.7% \|/);
  });
});
