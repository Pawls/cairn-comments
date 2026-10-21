import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { forkTotals, harnessTotals, launchFor, type LaunchOptions, type SessionStart } from "../harnesses.ts";

const jsonl = (events: object[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

const NEW: SessionStart = { kind: "new", id: "b1" };

const FORK: SessionStart = { kind: "fork", from: "b1", id: "c2" };

function options(local: boolean, session = NEW, readOnly = false): LaunchOptions {
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
    readOnly,
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

  it("tells Claude Code the local model's real window, so it does not compact at 200,000 tokens", () => {
    expect(launchFor("claude", options(true)).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("262144");
  });

  it("leaves Claude Code's side calls and window alone against the Anthropic API", () => {
    const env = launchFor("claude", options(false)).env;
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
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

describe("launchFor's tools for a run that answers from reading alone", () => {
  /** The value of `--tools`, or undefined when the launch leaves the harness its own tools. */
  const toolsArg = (harness: "claude" | "pi", session: SessionStart, readOnly: boolean) => {
    const args = launchFor(harness, options(true, session, readOnly)).args;
    const index = args.indexOf("--tools");
    return index === -1 ? undefined : args[index + 1];
  };

  it("gives Claude Code only Read, Grep and Glob, in a new session and a fork alike", () => {
    // An allowlist, not a denylist: it also shuts out PowerShell on Windows and subagents.
    expect(toolsArg("claude", NEW, true)).toBe("Read,Grep,Glob");
    expect(toolsArg("claude", FORK, true)).toBe("Read,Grep,Glob");
  });

  it("gives pi only read, grep, find and ls, in a new session and a fork alike", () => {
    expect(toolsArg("pi", NEW, true)).toBe("read,grep,find,ls");
    expect(toolsArg("pi", FORK, true)).toBe("read,grep,find,ls");
  });

  it("leaves each harness its own tools for a run that may edit", () => {
    expect(toolsArg("claude", FORK, false)).toBeUndefined();
    expect(toolsArg("pi", FORK, false)).toBeUndefined();
  });

  it("keeps pi's prompt last, behind the end of options", () => {
    expect(launchFor("pi", options(true, FORK, true)).args.slice(-2)).toEqual(["--", "fix it"]);
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

  it("gives a Claude Code fork its own spend: the session's totals less those at the fork", () => {
    const result = (input: number, cost: number) =>
      jsonl([
        {
          type: "result",
          total_cost_usd: cost,
          modelUsage: { m: { inputTokens: input, outputTokens: input / 1000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
        },
      ]);

    const totals = forkTotals("claude", result(69_000, 0.4), result(52_000, 0.3));

    expect(totals?.tokens).toEqual({ input: 17_000, output: 17, cacheRead: 0, cacheWrite: 0 });
    expect(totals?.costUsd).toBeCloseTo(0.1);
  });

  it("matches the proxy's count on Claude Code 2.1.299's own result lines, recorded from the stand-in", () => {
    // The warm-up's last prompt, then a probe forked from it; the proxy logged 17,420 input
    // tokens and 5 output tokens for the probe's one call.
    const parent = jsonl([
      { type: "result", total_cost_usd: 0.26014, modelUsage: { "stand-in": { inputTokens: 51953, outputTokens: 15, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } },
    ]);
    const fork = jsonl([
      { type: "result", total_cost_usd: 0.347365, modelUsage: { "stand-in": { inputTokens: 69373, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } },
    ]);

    expect(forkTotals("claude", fork, parent)?.tokens).toEqual({ input: 17420, output: 5, cacheRead: 0, cacheWrite: 0 });
  });

  it("knows no Claude Code fork's spend when the session's totals at the fork are missing", () => {
    const fork = jsonl([{ type: "result", total_cost_usd: 0.4, modelUsage: {} }]);

    expect(forkTotals("claude", fork, "")).toBeUndefined();
  });

  it("takes a pi fork's totals as they are, since pi counts each process alone", () => {
    const stdout = jsonl([
      { type: "message_end", message: { role: "assistant", usage: { input: 3, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } } },
    ]);

    expect(forkTotals("pi", stdout, stdout)).toEqual(harnessTotals("pi", stdout));
  });

  it("skips lines that are not JSON", () => {
    expect(harnessTotals("pi", "warning: something\n")).toBeUndefined();
  });
});
