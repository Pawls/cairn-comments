import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMetrics, type Phase } from "../metrics.ts";
import { startRecordingProxy } from "../proxy.ts";
import { readLog, runAgent, type AgentDirs, type AgentOptions } from "../runner.ts";
import { startStandIn, type StandIn } from "../standin.ts";

const FAKE_PI = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-pi.ts");

const agent: AgentOptions = {
  harness: "pi",
  provider: "",
  local: true,
  model: "stand-in",
  apiKey: "local",
  piCli: FAKE_PI,
  timeoutMs: 60_000,
};

let standIn: StandIn;
let dirs: AgentDirs;
let logFile: string;

beforeEach(async () => {
  standIn = await startStandIn();
  const root = mkdtempSync(path.join(tmpdir(), "session-"));
  dirs = { agentDir: path.join(root, "agent"), homeDir: path.join(root, "home"), outputDir: path.join(root, "out") };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  logFile = path.join(root, "calls.jsonl");
});

afterEach(async () => {
  await standIn.close();
});

/** Runs `prompts` through a proxy that tags each call with `phase`, all into one log. */
async function inPhase(phase: Phase, prompts: string[], from?: string) {
  const proxy = await startRecordingProxy(standIn.url, logFile, phase);
  try {
    return await runAgent(agent, prompts, dirs, { ...process.env } as Record<string, string>, proxy.url, from);
  } finally {
    await proxy.close();
  }
}

describe("a warm-up chain and a probe forked from it", () => {
  it("logs every call once, tagged with its phase, in one proxy log", async () => {
    const warmup = await inPhase("warmup", ["first warm-up prompt", "second warm-up prompt"]);
    await inPhase("probe", ["the probe"], warmup.sessionId);

    expect(warmup.exits.map((exit) => exit.code)).toEqual([0, 0]);
    expect(readLog(logFile).map((call) => call.phase)).toEqual(["warmup", "warmup", "probe"]);
  });

  it("gives the probe the warm-up's context, and counts only the probe's calls", async () => {
    const warmup = await inPhase("warmup", ["first warm-up prompt", "second warm-up prompt"]);
    const probe = await inPhase("probe", ["the probe"], warmup.sessionId);

    const log = readLog(logFile);
    const inputs = log.map((call) => call.response?.usage.input ?? 0);
    expect(inputs[1]).toBeGreaterThan(inputs[0]!);
    expect(inputs[2]).toBeGreaterThan(inputs[1]!);
    expect(probe.sessionId).not.toBe(warmup.sessionId);

    const metrics = runMetrics(log, { model: "stand-in", agentDir: dirs.agentDir });
    expect(metrics.calls).toBe(1);
    expect(metrics.tokens.input).toBe(inputs[2]);
    expect(metrics.firstCallInput).toBe(inputs[2]);
  });

  it("starts a second fork from the warm-up's end, not from the first fork", async () => {
    const warmup = await inPhase("warmup", ["first warm-up prompt"]);
    await inPhase("probe", ["a probe"], warmup.sessionId);
    await inPhase("probe", ["a probe"], warmup.sessionId);

    const inputs = readLog(logFile).map((call) => call.response?.usage.input);
    expect(inputs[2]).toBe(inputs[1]);
  });
});
