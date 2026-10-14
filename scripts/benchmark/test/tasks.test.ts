import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gradePrediction, loadDeepTasks, probeFile, type DeepTaskFile } from "../tasks.ts";

const REPO = { url: "https://example.com/r.git", base: "b", setup: [] };

describe("loadDeepTasks", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "deep-tasks-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(file: string, content: unknown): void {
    const full = path.join(dir, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, typeof content === "string" ? content : JSON.stringify(content));
  }

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

  it("loads the warm-up chains the file names, relative to the file, each named by its file", () => {
    write("probes/leash/tests/test_leash.py", "def test(): pass\n");
    write("probes/leash/reference.patch", "");

    const loaded = loadDeepTasks(taskFile([change]));

    expect(loaded.warmups).toEqual([{ id: "a", repo: "r", start: "s", modules: ["editor.py"], prompts: ["fix it"] }]);
  });

  it("refuses a chain that starts anywhere but the probes' start, since a probe forks from the chain's checkout", () => {
    write("probes/leash/tests/test_leash.py", "");
    write("probes/leash/reference.patch", "");

    expect(() => loadDeepTasks(taskFile([change], ["editor.py"], "other"))).toThrow(/warm-up chain a starts at r@other, not r@s/);
  });

  it("refuses a probe in a module a warm-up chain works in, since the warm-up would teach it the answer", () => {
    write("probes/leash/tests/test_leash.py", "");
    write("probes/leash/reference.patch", "");

    expect(() => loadDeepTasks(taskFile([change], ["npc_brain.py"]))).toThrow(/leash.*npc_brain\.py.*a/);
  });

  it("refuses an edit probe whose hidden tests or reference solution are missing", () => {
    write("probes/leash/reference.patch", "");
    expect(() => loadDeepTasks(taskFile([change]))).toThrow(/leash.*tests[/\\]test_leash\.py/);

    write("probes/leash/tests/test_leash.py", "");
    rmSync(path.join(dir, "probes/leash/reference.patch"));
    expect(() => loadDeepTasks(taskFile([change]))).toThrow(/leash.*reference\.patch/);
  });

  it("refuses a prediction probe with no script that computes its answer", () => {
    const predict = { id: "drain", use: "understanding", kind: "predict", modules: ["water.py"], prompt: "p", expected: "3" };

    expect(() => loadDeepTasks(taskFile([predict]))).toThrow(/drain.*compute\.py/);
  });

  it("refuses two probes with one id", () => {
    const locate = { id: "x", use: "navigation", kind: "locate", modules: ["a.py"], prompt: "p", answerKey: ["a"] };

    expect(() => loadDeepTasks(taskFile([locate, locate]))).toThrow(/duplicate probe id x/);
  });
});

describe("the deep-context probe set", () => {
  const file = path.join("benchmark", "deep-tasks.json");
  let tasks: DeepTaskFile;

  beforeEach(() => {
    tasks = loadDeepTasks(file);
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
    for (const probe of tasks.probes.filter((p) => p.use === "navigation" && p.kind === "locate")) {
      for (const pattern of probe.kind === "locate" ? probe.answerKey : []) {
        expect(new RegExp(pattern, "i").test(probe.prompt), `${probe.id}: ${pattern}`).toBe(false);
      }
    }
  });

  it("keeps every probe's files beside the task file", () => {
    for (const probe of tasks.probes) {
      expect(probeFile(file, probe.id, "x")).toBe(path.join("benchmark", "probes", probe.id, "x"));
    }
  });
});

describe("gradePrediction", () => {
  it("passes when the last ANSWER line matches, ignoring spacing and case", () => {
    const text = "Working it out...\nANSWER: 7 cells\nOn reflection:\nanswer:  keep=6   level=2 \n";

    expect(gradePrediction(text, "keep=6 level=2")).toEqual({ passed: true, missing: [] });
  });

  it("fails on an earlier ANSWER line that a later one replaced", () => {
    const text = "ANSWER: keep=6 level=2\nNo, wait.\nANSWER: keep=7 level=2\n";

    expect(gradePrediction(text, "keep=6 level=2").passed).toBe(false);
  });

  it("fails when there is no ANSWER line, even if the text contains the answer", () => {
    expect(gradePrediction("I think keep=6 level=2.", "keep=6 level=2")).toEqual({ passed: false, missing: ["ANSWER: keep=6 level=2"] });
  });
});
