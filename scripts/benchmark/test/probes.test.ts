import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outputStem } from "../agent.ts";
import { runDirFor, runOne, type RunResult, type RunSpec } from "../runner.ts";
import { planRuns, type Planned } from "../schedule.ts";
import { startStandIn, type StandIn } from "../standin.ts";
import { loadTaskFile } from "../tasks.ts";
import { warmupDirFor } from "../warmup.ts";
import { CHANGE_CHECK, makeRepo, writeUnder } from "./fixtures.ts";

const FAKE_PI = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-pi.ts");

/** A probe set with one probe of each kind and one warm-up chain, all at `start`. */
function makeProbeSet(root: string, repo: string, start: string): string {
  const dir = path.join(root, "probe-set");
  const prompts = ["first warm-up prompt", "second warm-up prompt"];
  writeUnder(dir, "warmups/w.json", { repo: "r", start, modules: ["warmup.py"], prompts });
  writeUnder(dir, "probes/predict-it/compute.py", "print(42)\n");
  writeUnder(dir, "probes/change-it/tests/hidden.txt", "hidden");
  writeUnder(dir, "probes/change-it/reference.patch", "");
  const probes = [
    {
      id: "predict-it",
      use: "understanding",
      kind: "predict",
      modules: ["a.py"],
      prompt: "predict",
      expected: "42",
      rubric: ["stand-in"],
    },
    { id: "locate-it", use: "navigation", kind: "locate", modules: ["b.py"], prompt: "locate", answerKey: ["stand-in reply"] },
    {
      id: "change-it",
      use: "understanding",
      kind: "change",
      modules: ["c.py"],
      prompt: "change",
      hiddenTests: ["tests/hidden.txt"],
      keptTests: ["tests/kept.txt"],
      testCommand: "node check.mjs",
      rubric: ["nothing the stand-in says"],
    },
  ];
  const repos = { r: { url: repo, base: start, setup: [] } };
  writeUnder(dir, "deep-tasks.json", { repos, repo: "r", start, warmups: ["warmups/w.json"], probes });
  return path.join(dir, "deep-tasks.json");
}

let standIn: StandIn;
let root: string;
let queue: Planned[];
let base: Omit<RunSpec, "task" | "arm" | "rep">;
const results = new Map<string, RunResult>();

const resultOf = (task: string, depth: "fresh" | "deep") => results.get(`${task} ${depth}`)!;

beforeAll(async () => {
  standIn = await startStandIn();
  root = mkdtempSync(path.join(tmpdir(), "probes-"));
  const { repo, start } = makeRepo(root, { "check.mjs": CHANGE_CHECK, "tests/kept.txt": "good" });
  const loaded = loadTaskFile(makeProbeSet(root, repo, start));
  queue = planRuns(loaded.tasks, ["none"], 1, 1, { fresh: true, chains: loaded.chains ?? [] });
  base = {
    harness: "pi",
    provider: standIn.url,
    local: true,
    model: "stand-in",
    apiKey: "local",
    piCli: FAKE_PI,
    timeoutMs: 60_000,
    repo: loaded.repos.r!,
    mirror: repo,
    workDir: path.join(root, "work"),
    comments: "",
    keep: false,
  };
  for (const planned of queue) {
    const result = await runOne({ ...base, ...planned, warmup: planned.chain && { chain: planned.chain } });
    results.set(`${result.task} ${result.depth}`, result);
  }
}, 120_000);

afterAll(async () => {
  await standIn.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** The tools the fake pi was given for the run's one prompt (see fake-pi.ts). */
function toolsOf(planned: Planned): string {
  const runDir = runDirFor({ ...base, ...planned });
  const session = readFileSync(`${outputStem(runDir, 1)}.jsonl`, "utf8").split("\n")[0]!;
  return (JSON.parse(session) as { tools: string }).tools;
}

describe("a probe set's runs", () => {
  it("plans a fresh run and a run forked from the chain for every probe", () => {
    const starts = queue.map((planned) => `${planned.task.id} ${planned.chain?.id ?? "fresh"}`).sort();

    expect(starts).toEqual(["change-it fresh", "change-it w", "locate-it fresh", "locate-it w", "predict-it fresh", "predict-it w"]);
  });

  it("grades a prediction on its ANSWER line, with the rubric beside it", () => {
    for (const depth of ["fresh", "deep"] as const) {
      expect(resultOf("predict-it", depth).grade).toEqual({
        passed: false,
        missing: ["ANSWER: 42"],
        rubric: { passed: true, missing: [] },
      });
    }
  });

  it("grades a location against its answer key", () => {
    for (const depth of ["fresh", "deep"] as const) {
      expect(resultOf("locate-it", depth).grade).toEqual({ passed: true, missing: [] });
    }
  });

  it("grades a change by its hidden tests, with the rubric beside it", () => {
    for (const depth of ["fresh", "deep"] as const) {
      expect(resultOf("change-it", depth).grade).toEqual({
        passed: true,
        testExit: 0,
        rubric: { passed: false, missing: ["nothing the stand-in says"] },
      });
    }
  });

  it("records each run's kind and depth in result.json", () => {
    for (const planned of queue) {
      const recorded = JSON.parse(readFileSync(path.join(runDirFor({ ...base, ...planned }), "result.json"), "utf8")) as RunResult;
      expect(recorded).toMatchObject({ kind: planned.task.kind, depth: planned.chain ? "deep" : "fresh" });
    }
  });

  it("gives a prediction or a location only tools that read, fresh or forked, and a change every tool", () => {
    for (const planned of queue) {
      const expected = planned.task.kind === "change" ? "all" : "read,grep,find,ls";
      expect(toolsOf(planned), `${planned.task.id} ${planned.chain?.id ?? "fresh"}`).toBe(expected);
    }
  });

  it("gives the warm-up every tool, whatever the probes forked from it are given", () => {
    const warmupDir = warmupDirFor(base.workDir, "pi", "w", "none");
    for (const prompt of [1, 2]) {
      const session = readFileSync(`${outputStem(warmupDir, prompt)}.jsonl`, "utf8").split("\n")[0]!;
      expect((JSON.parse(session) as { tools: string }).tools).toBe("all");
    }
  });
});
