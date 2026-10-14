import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chainsNamedLikeTasks,
  loadChains,
  loadDeepTasks,
  loadTaskFile,
  type DeepTaskFile,
  type LocateProbe,
} from "../tasks.ts";
import { writeUnder } from "./fixtures.ts";

const REPO = { url: "https://example.com/r.git", base: "b", setup: [] };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "deep-tasks-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (file: string, content: unknown) => writeUnder(dir, file, content);

function taskFile(probes: unknown[], warmupModules = ["editor.py"], chainStart = "s"): string {
  write("warmups/a.json", { repo: "r", start: chainStart, modules: warmupModules, prompts: ["fix it"] });
  write("deep.json", { repos: { r: REPO }, repo: "r", start: "s", warmups: ["warmups/a.json"], probes });
  return path.join(dir, "deep.json");
}

const change = {
  id: "leash",
  use: "understanding",
  kind: "change",
  modules: ["npc_brain.py"],
  prompt: "add a leash",
  hiddenTests: ["tests/test_leash.py"],
  testCommand: "pytest tests/test_leash.py",
};

function writeLeashFiles(): void {
  write("probes/leash/tests/test_leash.py", "def test(): pass\n");
  write("probes/leash/reference.patch", "");
}

describe("loadChains", () => {
  it("reads each chain under its file name", () => {
    write("chains/w1.json", { repo: "r", start: "s", prompts: ["go"] });

    expect(loadChains(path.join(dir, "chains")).get("w1")).toEqual({ id: "w1", repo: "r", start: "s", prompts: ["go"] });
  });

  it("refuses a chain file without a repository, a start commit, and at least one prompt, naming the file", () => {
    const chainsIn = (name: string, content: unknown) => {
      write(`${name}/${name}.json`, content);
      return path.join(dir, name);
    };

    expect(() => loadChains(chainsIn("w2", { repo: "r", start: "s", prompts: [] }))).toThrow(/w2\.json/);
    expect(() => loadChains(chainsIn("w3", { repo: "r", prompts: ["go"] }))).toThrow(/w3\.json/);
    expect(() => loadChains(chainsIn("w4", "{ not json"))).toThrow(/w4\.json/);
  });

  it("names the chains whose id is also a task's, which would share the task's prepared commits", () => {
    const chains = [{ id: "fix-flow", repo: "r", start: "s", prompts: ["go"] }, { id: "w1", repo: "r", start: "s", prompts: ["go"] }];

    expect(chainsNamedLikeTasks(chains, [{ id: "fix-flow" }, { id: "q1" }])).toEqual(["fix-flow"]);
  });
});

describe("loadTaskFile", () => {
  it("reads a probe set as tasks that start where the set does, with its own chains and one prepared entry", () => {
    writeLeashFiles();

    const loaded = loadTaskFile(taskFile([change]));

    const probeDir = path.join(dir, "probes", "leash");
    expect(loaded.tasks).toEqual([{ ...change, repo: "r", start: "s", preparedId: "deep", dir: probeDir }]);
    expect(loaded.chains?.map((chain) => [chain.id, chain.preparedId])).toEqual([["a", "deep"]]);
  });

  it("reads a round's task file as it is, with no chains of its own", () => {
    const question = { id: "q", repo: "r", kind: "question", start: "s", prompt: "why?", answerKey: ["because"] };
    write("round.json", { repos: { r: REPO }, tasks: [question] });

    expect(loadTaskFile(path.join(dir, "round.json"))).toEqual({ repos: { r: REPO }, tasks: [question] });
  });

  it("drops a chains key from a round's file, whose chains come from --warmups and are checked there", () => {
    write("round.json", { repos: { r: REPO }, tasks: [], chains: [{ id: "unchecked" }] });

    expect(loadTaskFile(path.join(dir, "round.json")).chains).toBeUndefined();
  });

  it("refuses a file with neither tasks nor probes, naming it", () => {
    write("typo.json", { repos: { r: REPO }, repo: "r", start: "s", warmups: [], probs: [] });

    expect(() => loadTaskFile(path.join(dir, "typo.json"))).toThrow(/typo\.json has neither tasks nor probes/);
  });

  it("refuses a round's task in a repository the file does not define", () => {
    write("round.json", { repos: { r: REPO }, tasks: [{ id: "q", repo: "elsewhere", kind: "question", start: "s", prompt: "", answerKey: [] }] });

    expect(() => loadTaskFile(path.join(dir, "round.json"))).toThrow(/task q: unknown repo elsewhere/);
  });
});

describe("loadDeepTasks", () => {
  it("loads the warm-up chains the file names, relative to the file, each named by its file", () => {
    writeLeashFiles();

    const loaded = loadDeepTasks(taskFile([change]));

    expect(loaded.warmups).toEqual([
      { id: "a", repo: "r", start: "s", modules: ["editor.py"], prompts: ["fix it"], preparedId: "deep" },
    ]);
  });

  it("refuses a chain that starts anywhere but the probes' start, since a probe forks from the chain's checkout", () => {
    writeLeashFiles();

    expect(() => loadDeepTasks(taskFile([change], ["editor.py"], "other"))).toThrow(/warm-up chain a starts at r@other, not r@s/);
  });

  it("refuses a probe in a module a warm-up chain works in, since the warm-up would teach it the answer", () => {
    writeLeashFiles();

    expect(() => loadDeepTasks(taskFile([change], ["npc_brain.py"]))).toThrow(/leash.*npc_brain\.py.*a/);
  });

  it("refuses a probe that names its own repository or start, since every probe runs at the set's", () => {
    writeLeashFiles();

    expect(() => loadDeepTasks(taskFile([{ ...change, start: "later" }]))).toThrow(/probe leash starts at r@later, not r@s/);
    expect(() => loadDeepTasks(taskFile([{ ...change, repo: "q" }]))).toThrow(/probe leash starts at q@s, not r@s/);
  });

  it("refuses a warm-up chain that lists no modules, since no probe's isolation could be checked", () => {
    writeLeashFiles();

    expect(() => loadDeepTasks(taskFile([change], []))).toThrow(/warm-up chain a lists no modules/);
  });

  it("refuses an edit probe whose hidden tests or reference solution are missing", () => {
    writeLeashFiles();
    rmSync(path.join(dir, "probes/leash/tests/test_leash.py"));
    expect(() => loadDeepTasks(taskFile([change]))).toThrow(/leash.*tests[/\\]test_leash\.py/);

    writeLeashFiles();
    rmSync(path.join(dir, "probes/leash/reference.patch"));
    expect(() => loadDeepTasks(taskFile([change]))).toThrow(/leash.*reference\.patch/);
  });

  it("refuses a prediction probe with no script that computes its answer", () => {
    const predict = { id: "drain", use: "understanding", kind: "predict", modules: ["water.py"], prompt: "p", expected: "3" };

    expect(() => loadDeepTasks(taskFile([predict]))).toThrow(/drain.*compute\.py/);
  });

  it("refuses a warm-up chain file outside the task file's folder", () => {
    writeLeashFiles();
    write("deep.json", { repos: { r: REPO }, repo: "r", start: "s", warmups: ["../elsewhere.json"], probes: [change] });

    expect(() => loadDeepTasks(path.join(dir, "deep.json"))).toThrow(/warm-up chain \.\.\/elsewhere\.json is outside/);
  });

  it("refuses two probes with one id", () => {
    const locate = { id: "x", use: "navigation", kind: "locate", modules: ["a.py"], prompt: "p", answerKey: ["a"] };

    expect(() => loadDeepTasks(taskFile([locate, locate]))).toThrow(/duplicate probe id x/);
  });
});

describe("the deep-context probe set", () => {
  let tasks: DeepTaskFile;

  beforeEach(() => {
    tasks = loadDeepTasks(path.join("benchmark", "deep-tasks.json"));
  });

  it("has four navigation and four understanding probes", () => {
    expect(tasks.probes.filter((probe) => probe.use === "navigation")).toHaveLength(4);
    expect(tasks.probes.filter((probe) => probe.use === "understanding")).toHaveLength(4);
  });

  it("has two warm-up chains of five or six prompts", () => {
    expect(tasks.warmups).toHaveLength(2);
    for (const chain of tasks.warmups) {
      expect(chain.prompts.length).toBeGreaterThanOrEqual(5);
      expect(chain.prompts.length).toBeLessThanOrEqual(6);
    }
  });

  it("names no file or function in a navigation prompt that its answer key requires", () => {
    const locates = tasks.probes.filter((probe): probe is LocateProbe => probe.use === "navigation" && probe.kind === "locate");
    for (const probe of locates) {
      for (const pattern of probe.answerKey) {
        expect(new RegExp(pattern, "i").test(probe.prompt), `${probe.id}: ${pattern}`).toBe(false);
      }
    }
  });
});
