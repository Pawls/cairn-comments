import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { harnessTotals, launchFor, type LaunchOptions, type SessionStart } from "../harnesses.ts";

const jsonl = (events: object[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

const NEW: SessionStart = { kind: "new", id: "b1" };

function options(local: boolean, session = NEW): LaunchOptions {
  const dir = mkdtempSync(path.join(tmpdir(), "launch-"));
  return {
    prompt: "fix it",
    session,
    model: "qwen3.8-flash-next-iq2_xs",
    configDir: path.join(dir, "config"),
    proxyUrl: "http://127.0.0.1:9999",
    sessionDir: path.join(dir, "sessions"),
    piCli: "cli.js",
    local,
  };
}

describe("launchFor with a local model", () => {
  it("sends Claude Code's side calls to the run's model, which is the only one the server has", () => {
    const launch = launchFor("claude", options(true));

    expect(launch.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9999",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen3.8-flash-next-iq2_xs",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen3.8-flash-next-iq2_xs",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "qwen3.8-flash-next-iq2_xs",
      CLAUDE_CODE_SUBAGENT_MODEL: "qwen3.8-flash-next-iq2_xs",
    });
  });

  it("leaves Claude Code's side calls alone against the Anthropic API", () => {
    expect(launchFor("claude", options(false)).env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
  });

  it("declares the model to pi as a provider speaking the Messages API through the proxy", () => {
    const launchOptions = options(true);
    const launch = launchFor("pi", launchOptions);

    const config = JSON.parse(readFileSync(path.join(launchOptions.configDir, "models.json"), "utf8"));
    expect(config.providers.local).toMatchObject({
      baseUrl: "http://127.0.0.1:9999",
      api: "anthropic-messages",
      models: [{ id: "qwen3.8-flash-next-iq2_xs" }],
    });
    expect(launch.args).toContain("local/qwen3.8-flash-next-iq2_xs");
  });
});

describe("launchFor's session arguments", () => {
  const sessionArgs = (harness: "claude" | "pi", session: SessionStart) => {
    const args = launchFor(harness, options(true, session)).args;
    const flags = new Set(["--session-id", "--resume", "--fork-session", "--fork"]);
    return args.flatMap((arg, i) => (flags.has(arg) || flags.has(args[i - 1] ?? "") ? [arg] : []));
  };

  it("names a new session, resumes it by id, and forks it under a new id in Claude Code", () => {
    expect(sessionArgs("claude", { kind: "new", id: "b1" })).toEqual(["--session-id", "b1"]);
    expect(sessionArgs("claude", { kind: "continue", id: "b1" })).toEqual(["--resume", "b1"]);
    expect(sessionArgs("claude", { kind: "fork", from: "b1", id: "c2" })).toEqual([
      "--resume",
      "b1",
      "--fork-session",
      "--session-id",
      "c2",
    ]);
  });

  it("opens a session by id, new or not, and forks it under a new id in pi", () => {
    expect(sessionArgs("pi", { kind: "new", id: "b1" })).toEqual(["--session-id", "b1"]);
    expect(sessionArgs("pi", { kind: "continue", id: "b1" })).toEqual(["--session-id", "b1"]);
    expect(sessionArgs("pi", { kind: "fork", from: "b1", id: "c2" })).toEqual(["--fork", "b1", "--session-id", "c2"]);
  });

  it("keeps pi's prompt after the session arguments, behind the end of options", () => {
    const args = launchFor("pi", options(true, { kind: "fork", from: "b1", id: "c2" })).args;

    expect(args.slice(-2)).toEqual(["--", "fix it"]);
  });
});

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
