import { describe, expect, it } from "vitest";
import { harnessTotals } from "../harnesses.ts";

const jsonl = (events: object[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

describe("harnessTotals", () => {
  it("reads Claude Code's result line, summing every model it used", () => {
    const stdout = jsonl([
      { type: "system", subtype: "init" },
      { type: "assistant", message: { content: [] } },
      {
        type: "result",
        total_cost_usd: 0.42,
        modelUsage: {
          "claude-sonnet-5-5": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40 },
          "claude-haiku-5-5": { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        },
      },
    ]);

    expect(harnessTotals("claude", stdout)).toEqual({
      costUsd: 0.42,
      tokens: { input: 11, output: 22, cacheRead: 300, cacheWrite: 40 },
    });
  });

  it("returns undefined when Claude Code never wrote a result line", () => {
    expect(harnessTotals("claude", jsonl([{ type: "system" }]))).toBeUndefined();
  });

  it("sums pi's assistant message_end events, ignoring the user's", () => {
    const usage = (input: number, cost: number) => ({ input, output: 5, cacheRead: 7, cacheWrite: 1, cost: { total: cost } });
    const stdout = jsonl([
      { type: "message_end", message: { role: "user", content: [] } },
      { type: "message_update", usage: usage(99, 9) },
      { type: "message_end", message: { role: "assistant", usage: usage(3, 0.01) } },
      { type: "message_end", message: { role: "assistant", usage: usage(4, 0.02) } },
    ]);

    const totals = harnessTotals("pi", stdout);

    expect(totals?.tokens).toEqual({ input: 7, output: 10, cacheRead: 14, cacheWrite: 2 });
    expect(totals?.costUsd).toBeCloseTo(0.03);
  });

  it("skips lines that are not JSON", () => {
    expect(harnessTotals("pi", "warning: something\n")).toBeUndefined();
  });
});
