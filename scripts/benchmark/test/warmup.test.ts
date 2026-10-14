import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLog } from "../agent.ts";
import { runDirFor, runOne, type RunSpec } from "../runner.ts";
import { startStandIn, type StandIn } from "../standin.ts";
import type { QuestionTask } from "../tasks.ts";
import { warmupDirFor, type WarmupChain } from "../warmup.ts";
import { git, isolatedEnv } from "../workspace.ts";

const FAKE_PI = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-pi.ts");

let standIn: StandIn;
let spec: RunSpec;

/** A one-commit repository to check out, made with an isolated git config. */
function makeRepo(root: string): { repo: string; start: string } {
  const repo = path.join(root, "source");
  mkdirSync(repo);
  const env = isolatedEnv(path.join(root, "git-state"), path.join(root, "cli-home"));
  git(repo, env, "init", "--quiet");
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, env, "add", "a.txt");
  git(repo, env, "commit", "--quiet", "-m", "start");
  return { repo, start: git(repo, env, "rev-parse", "HEAD").trim() };
}

beforeEach(async () => {
  standIn = await startStandIn();
  const root = mkdtempSync(path.join(tmpdir(), "warmup-"));
  const { repo, start } = makeRepo(root);
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
});
