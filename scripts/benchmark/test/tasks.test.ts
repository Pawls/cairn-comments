import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gradeChangeProbe, gradePrediction, loadDeepTasks, type ChangeProbe, type DeepTaskFile, type LocateProbe } from "../tasks.ts";
import { isolatedEnv } from "../workspace.ts";

const REPO = { url: "https://example.com/r.git", base: "b", setup: [] };

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

describe("loadDeepTasks", () => {
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

  it("loads the warm-up chains the file names, relative to the file, each named by its file", () => {
    writeLeashFiles();

    const loaded = loadDeepTasks(taskFile([change]));

    expect(loaded.warmups).toEqual([{ id: "a", repo: "r", start: "s", modules: ["editor.py"], prompts: ["fix it"] }]);
  });

  it("refuses a chain that starts anywhere but the probes' start, since a probe forks from the chain's checkout", () => {
    writeLeashFiles();

    expect(() => loadDeepTasks(taskFile([change], ["editor.py"], "other"))).toThrow(/warm-up chain a starts at r@other, not r@s/);
  });

  it("refuses a probe in a module a warm-up chain works in, since the warm-up would teach it the answer", () => {
    writeLeashFiles();

    expect(() => loadDeepTasks(taskFile([change], ["npc_brain.py"]))).toThrow(/leash.*npc_brain\.py.*a/);
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

describe("gradeChangeProbe", () => {
  const CHECK = [
    'import { existsSync, readFileSync } from "node:fs";',
    'const ready = existsSync("tests/hidden.txt") && readFileSync("tests/kept.txt", "utf8") === "good";',
    "process.exit(ready ? 0 : 3);",
  ].join("\n");

  function probe(testCommand: string): ChangeProbe {
    return {
      id: "p",
      use: "understanding",
      kind: "change",
      modules: [],
      prompt: "",
      hiddenTests: ["tests/hidden.txt"],
      keptTests: ["tests/kept.txt"],
      testCommand,
    };
  }

  function checkout(): { taskFile: string; agentDir: string; env: Record<string, string> } {
    const env = isolatedEnv(path.join(dir, "state"), path.join(dir, "cli-home"));
    const agentDir = path.join(dir, "agent");
    write("agent/tests/kept.txt", "good");
    write("agent/check.mjs", CHECK);
    write("agent/fail.mjs", 'console.log("nope");\nprocess.exit(3);\n');
    execFileSync("git", ["init", "-q", agentDir], { env });
    execFileSync("git", ["add", "."], { cwd: agentDir, env });
    execFileSync("git", ["commit", "-qm", "start"], { cwd: agentDir, env });
    write("agent/tests/kept.txt", "edited by the agent");
    write("probes/p/tests/hidden.txt", "hidden");
    write("probes/p/tests/__pycache__/hidden.cpython-313.pyc", "bytecode");
    return { taskFile: path.join(dir, "deep.json"), agentDir, env };
  }

  it("places the named hidden tests, puts the kept tests back, and passes when the command does", () => {
    const { taskFile, agentDir, env } = checkout();

    const grade = gradeChangeProbe(taskFile, probe("node check.mjs"), agentDir, env);

    expect(grade.passed).toBe(true);
    expect(readFileSync(path.join(agentDir, "tests", "kept.txt"), "utf8")).toBe("good");
    expect(existsSync(path.join(agentDir, "tests", "__pycache__"))).toBe(false);
  });

  it("fails with the command's exit code and keeps its output", () => {
    const { taskFile, agentDir, env } = checkout();

    const grade = gradeChangeProbe(taskFile, probe("node fail.mjs"), agentDir, env);

    expect(grade).toMatchObject({ passed: false, testExit: 3 });
    expect(grade.output).toContain("nope");
  });

  it("runs the command without a shell, so a timeout stops the test process itself", () => {
    const { taskFile, agentDir, env } = checkout();

    const grade = gradeChangeProbe(taskFile, probe("node fail.mjs || node check.mjs"), agentDir, env);

    expect(grade.testExit).toBe(3);
  });
});

describe("gradePrediction", () => {
  it("passes when the last ANSWER line matches, ignoring spacing and case", () => {
    const text = "Working it out...\nANSWER: 7 cells\nOn reflection:\nanswer:  keep=6   level=2 \n";

    expect(gradePrediction(text, "keep=6 level=2")).toEqual({ passed: true, missing: [] });
  });

  it("reads an ANSWER line through markdown emphasis, code spans, and a closing period", () => {
    for (const line of ["**ANSWER:** keep=6 level=2", "ANSWER: `keep=6 level=2`", "- **ANSWER: keep=6 level=2.**", "> Answer: keep=6 level=2"]) {
      expect(gradePrediction(`Reasoning.\n${line}\n`, "keep=6 level=2").passed, line).toBe(true);
    }
  });

  it("keeps underscores and comparison signs inside the answer itself", () => {
    expect(gradePrediction("**ANSWER:** `spilled_cells=0 level>3`.", "spilled_cells=0 level>3").passed).toBe(true);
  });

  it("fails on an earlier ANSWER line that a later one replaced", () => {
    const text = "ANSWER: keep=6 level=2\nNo, wait.\nANSWER: keep=7 level=2\n";

    expect(gradePrediction(text, "keep=6 level=2").passed).toBe(false);
  });

  it("fails when there is no ANSWER line, even if the text contains the answer", () => {
    expect(gradePrediction("I think keep=6 level=2.", "keep=6 level=2")).toEqual({ passed: false, missing: ["ANSWER: keep=6 level=2"] });
  });
});
