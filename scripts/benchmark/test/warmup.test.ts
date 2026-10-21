import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderError, readLog } from "../agent.ts";
import { runDirFor, runOne, type RunSpec } from "../runner.ts";
import { startStandIn, type StandIn } from "../standin.ts";
import type { QuestionTask, WarmupChain } from "../tasks.ts";
import { warmupDirFor } from "../warmup.ts";
import { git, isolatedEnv } from "../workspace.ts";
import { makeRepo } from "./fixtures.ts";

const FAKE_PI = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-pi.ts");

let standIn: StandIn;
let spec: RunSpec;

beforeEach(async () => {
  standIn = await startStandIn();
  const root = mkdtempSync(path.join(tmpdir(), "warmup-"));
  const { repo, start } = makeRepo(root, { "a.txt": "a\n" });
  const task: QuestionTask = { id: "q", repo: "r", kind: "question", start, prompt: "the probe", answerKey: ["stand-in reply"] };
  const chain: WarmupChain = { id: "w", repo: "r", start, prompts: ["first warm-up prompt", "second warm-up prompt"] };
  spec = {
    harness: "pi",
    provider: standIn.url,
    local: true,
    model: "stand-in",
    apiKey: "local",
    piCli: FAKE_PI,
    timeoutMs: 60_000,
    task,
    repo: { url: repo, base: start, setup: [] },
    mirror: repo,
    arm: "none",
    rep: 1,
    workDir: path.join(root, "work"),
    comments: "",
    keep: false,
    warmup: { chain },
  };
});

afterEach(async () => {
  await standIn.close();
});

describe("a deep run", () => {
  it("forks the warm-up's session and records its depth, chain, and starting context", async () => {
    const result = await runOne(spec);

    expect(result).toMatchObject({ depth: "deep", chain: "w", grade: { passed: true } });
    expect(result.metrics.calls).toBe(1);
    const log = readLog(path.join(runDirFor({ ...spec, chain: spec.warmup?.chain }), "calls.jsonl"));
    expect(log.map((call) => call.phase)).toEqual(["warmup", "warmup", "probe"]);
    expect(result.metrics.firstCallContext).toBe(log[2]?.response?.usage.input);
  });

  it("runs the warm-up once and puts its checkout back before each probe", async () => {
    await runOne(spec);
    const agentDir = path.join(warmupDirFor(spec.workDir, "pi", "w", "none"), "agent");
    writeFileSync(path.join(agentDir, "left-by-the-first-probe.txt"), "x");
    writeFileSync(path.join(agentDir, "a.txt"), "changed\n");

    const second = await runOne({ ...spec, rep: 2 });

    expect(existsSync(path.join(agentDir, "left-by-the-first-probe.txt"))).toBe(false);
    expect(readFileSync(path.join(agentDir, "a.txt"), "utf8")).toBe("a\n");
    // The stand-in numbers its replies: two for the chain, one per probe.
    expect(second.metrics.finalText).toBe("Stand-in reply 4.");
  });

  it("leaves nothing in the warm-up's directory that names the arm", async () => {
    await runOne(spec);

    const record = readFileSync(path.join(warmupDirFor(spec.workDir, "pi", "w", "none"), "warmup.json"), "utf8");
    expect(record).not.toMatch(/none|comments/i);
  });

  it("puts the harness's configuration and sessions back before each probe, so probes share nothing", async () => {
    await runOne(spec);
    const dir = warmupDirFor(spec.workDir, "pi", "w", "none");
    writeFileSync(path.join(dir, "config", "memory-of-the-first-probe.md"), "x");
    writeFileSync(path.join(dir, "sessions", "left-by-the-first-probe.json"), "[]");

    await runOne({ ...spec, rep: 2 });

    expect(existsSync(path.join(dir, "config", "memory-of-the-first-probe.md"))).toBe(false);
    expect(existsSync(path.join(dir, "sessions", "left-by-the-first-probe.json"))).toBe(false);
  });

  it("hands a probe a restored checkout whose git index is current, so its first git command does not rehash it", async () => {
    await runOne(spec);
    await runOne({ ...spec, rep: 2 });

    const agentDir = path.join(warmupDirFor(spec.workDir, "pi", "w", "none"), "agent");
    const env = isolatedEnv(path.join(spec.workDir, "check-state"), path.join(spec.workDir, "cli-home"));
    expect(git(agentDir, env, "diff-files", "--name-only").trim()).toBe("");
  });

  it("refuses to fork a warm-up whose prompt failed, without running the chain again", async () => {
    const failing = { ...spec.warmup!.chain, prompts: ["first warm-up prompt", "fail: second warm-up prompt"] };
    const failingSpec = { ...spec, warmup: { chain: failing } };
    const warmupLog = path.join(warmupDirFor(spec.workDir, "pi", "w", "none"), "calls.jsonl");

    await expect(runOne(failingSpec)).rejects.toThrow(/warm-up w did not finish: prompt 2 exited 1/);
    await expect(runOne({ ...failingSpec, rep: 2 })).rejects.toThrow(/did not finish/);
    expect(readLog(warmupLog)).toHaveLength(2);
  });

  it("refuses a finished warm-up whose chain has since changed its prompts", async () => {
    await runOne(spec);
    const shorter = { ...spec.warmup!.chain, prompts: ["first warm-up prompt"] };

    await expect(runOne({ ...spec, rep: 2, warmup: { chain: shorter } })).rejects.toThrow(
      /warm-up w ran with other prompts, start or model; delete .* to run it again/,
    );
  });

  it("refuses a finished warm-up that ran on another model", async () => {
    await runOne(spec);

    await expect(runOne({ ...spec, rep: 2, model: "another-model" })).rejects.toThrow(/ran with other prompts, start or model/);
  });

  it("refuses a finished warm-up whose record predates the prompts it ran with", async () => {
    await runOne(spec);
    const record = path.join(warmupDirFor(spec.workDir, "pi", "w", "none"), "warmup.json");
    const legacy = JSON.parse(readFileSync(record, "utf8"));
    delete legacy.prompts;
    delete legacy.start;
    delete legacy.model;
    writeFileSync(record, JSON.stringify(legacy));

    await expect(runOne({ ...spec, rep: 2 })).rejects.toThrow(/ran with other prompts, start or model/);
  });

  it("refuses a probe that does not start where the chain does", async () => {
    const elsewhere = { ...spec.task, start: "0000000000000000000000000000000000000000" };

    await expect(runOne({ ...spec, task: elsewhere })).rejects.toThrow(/does not start where warm-up w does/);
  });
});

describe("a fresh run", () => {
  it("starts an empty session in a checkout of its own", async () => {
    const result = await runOne({ ...spec, warmup: undefined });

    expect(result).toMatchObject({ depth: "fresh", grade: { passed: true } });
    expect(result.chain).toBeUndefined();
    expect(result.metrics.finalText).toBe("Stand-in reply 1.");
    expect(existsSync(warmupDirFor(spec.workDir, "pi", "w", "none"))).toBe(false);
  });

  it("blames the harness, not the model server, when the harness never makes a call", async () => {
    const silent = path.join(mkdtempSync(path.join(tmpdir(), "silent-")), "silent-pi.mjs");
    writeFileSync(silent, "process.exit(1);\n");

    const run = runOne({ ...spec, warmup: undefined, piCli: silent });

    await expect(run).rejects.toThrow(/made no model call/);
    await expect(run).rejects.not.toBeInstanceOf(ProviderError);
  });
});
