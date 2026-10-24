import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentsMdFor, freezeNotes, loadNotesSet, notesGiven, planLoop, verdict, type LoopSpec, type NotesSet } from "../notes.ts";
import { findPython, prepareTask, type PreparedTask } from "../prepare.ts";
import { runOne, type RunSpec } from "../runner.ts";
import { startStandIn, type StandIn } from "../standin.ts";
import type { QuestionTask, TaskFile } from "../tasks.ts";
import { CAIRN_CLI, checkoutArm, ensureMirror, isolatedEnv, placedComments, type NotesCheckout } from "../workspace.ts";
import { makeRepo, writeUnder } from "./fixtures.ts";

const FAKE_PI = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-pi.ts");

const python = findPython();

describe.skipIf(!python || !existsSync(CAIRN_CLI))("a notes-loop checkout", () => {
  let dir: string;
  let mirror: string;
  let start: string;
  let env: Record<string, string>;
  let prepared: PreparedTask;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, env, encoding: "utf8" });
  }

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "notes-"));
    env = isolatedEnv(path.join(dir, "state"), path.join(dir, "cli-home"));
    const source = path.join(dir, "source");
    mkdirSync(source);
    writeFileSync(path.join(source, "mod.py"), "# why\ndef f():\n    return 1\n");
    git(dir, "init", "-q", "source");
    git(source, "add", ".");
    git(source, "commit", "-qm", "start");
    start = git(source, "rev-parse", "HEAD").trim();
    mirror = ensureMirror(dir, "repo", { url: source, base: start, setup: [] }, env, [start]);
    prepared = prepareTask({ mirror, taskId: "t1", start, python: python!, env, agentNotes: ["# Agent notes"] });
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

  function checkout(notes: NotesCheckout): { runDir: string; agent: string } {
    const runDir = mkdtempSync(path.join(dir, "run-"));
    return { runDir, agent: checkoutArm({ mirror, runDir, start, arm: "none", hooks: [], env, prepared, notes }) };
  }

  it("commits its own AGENTS.md in the clone's one parentless commit, so the worktree is clean", () => {
    const { agent } = checkout({ agentsMd: "## Notes\n\n# Agent notes\n" });

    expect(readFileSync(path.join(agent, "AGENTS.md"), "utf8")).toBe("## Notes\n\n# Agent notes\n");
    expect(git(agent, "status", "--porcelain")).toBe("");
    expect(git(agent, "log", "--all", "--format=%P|%s").trim()).toBe("|Initial commit");
    expect(readFileSync(path.join(agent, "mod.py"), "utf8")).toBe("def f():\n    return 1\n");
  });

  it("keeps the prepared commit's dates", () => {
    const plain = checkout({ agentsMd: "# Agent notes\n" });
    const other = checkout({ agentsMd: "other\n" });
    const dates = (agent: string) => git(agent, "log", "--format=%aI %cI").trim();

    expect(dates(other.agent)).toBe(dates(plain.agent));
  });

  it("freezes the notes a writer leaves and places them for a reader", () => {
    const writer = checkout({ agentsMd: "# Agent notes\n", cairn: { hooks: [] } });
    writeFileSync(path.join(writer.agent, "mod.py"), "def f():\n    #~ always one\n    return 1\n");
    const frozen = path.join(dir, "frozen");
    const writerSpec: LoopSpec = { role: "writer", arm: "notes", writer: "w", runDir: writer.runDir, checkout: {} as NotesCheckout, freezeTo: frozen };

    expect(freezeNotes(writerSpec, writer.agent, writer.runDir, env)).toEqual({ "mod.py": 1 });

    const sidecars = { sidecars: frozen, hooks: [] };
    const reader = checkout({ agentsMd: "# Agent notes\n", cairn: sidecars });
    expect(readFileSync(path.join(reader.agent, "mod.py"), "utf8")).toMatch(/^def f\(\):\n {4}#~[0-9a-z]{4} always one\n {4}return 1\n$/);
    expect(placedComments(reader.runDir)).toEqual({ placed: { "mod.py": 1 }, stale: 0 });
    const readerSpec: LoopSpec = { role: "reader", arm: "notes", writer: "w", runDir: reader.runDir, checkout: { agentsMd: "", cairn: sidecars } };
    expect(notesGiven(readerSpec, reader.runDir)).toEqual({ entries: { "mod.py": 1 }, placed: { "mod.py": 1 }, stale: 0 });
  });

  it("freezes nothing for a writer in the bare arm", () => {
    const spec: LoopSpec = { role: "writer", arm: "bare", writer: "w", runDir: dir, checkout: { agentsMd: "" } };
    expect(freezeNotes(spec, dir, dir, env)).toBeUndefined();
  });
});

describe.skipIf(!python || !existsSync(CAIRN_CLI))("a writer and its reader, run by runOne", () => {
  let standIn: StandIn;
  let base: Omit<RunSpec, "task" | "loop">;
  let root: string;

  beforeAll(async () => {
    standIn = await startStandIn();
    root = mkdtempSync(path.join(os.tmpdir(), "notes-run-"));
    const { repo, start, env } = makeRepo(root, { "mod.py": "def f():\n    return 1\n" });
    const work = path.join(root, "work");
    const mirror = ensureMirror(work, "r", { url: repo, base: start, setup: [] }, env, [start]);
    const prepared = prepareTask({ mirror, taskId: "deep", start, python: python!, env, agentNotes: ["# Agent notes"] });
    base = {
      harness: "pi",
      provider: standIn.url,
      local: true,
      model: "stand-in",
      apiKey: "local",
      piCli: FAKE_PI,
      timeoutMs: 60_000,
      repo: { url: repo, base: start, setup: [] },
      mirror,
      arm: "none",
      rep: 1,
      workDir: work,
      comments: "",
      keep: true,
      prepared,
    };
  });

  afterAll(async () => {
    await standIn.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  function task(id: string, prompt: string): QuestionTask {
    return { id, repo: "r", kind: "question", start: base.repo.base, prompt, answerKey: ["stand-in reply"] };
  }

  it("records the notes a writer left, and the ones its reader was given and saw placed", async () => {
    const frozen = path.join(root, "work", "notes", "w-1");
    const writer = await runOne({
      ...base,
      task: task("w", "note:mod.py"),
      loop: {
        role: "writer",
        arm: "notes",
        writer: "w",
        runDir: path.join(root, "work", "loop", "w"),
        checkout: { agentsMd: "## Notes\n", cairn: { hooks: [] } },
        freezeTo: frozen,
      },
    });
    expect(writer.loop).toEqual({ role: "writer", arm: "notes", writer: "w", left: { "mod.py": 1 } });

    const readerDir = path.join(root, "work", "loop", "r");
    const reader = await runOne({
      ...base,
      task: task("r", "read it"),
      loop: { role: "reader", arm: "notes", writer: "w", runDir: readerDir, checkout: { agentsMd: "## Notes\n", cairn: { hooks: [], sidecars: frozen } } },
    });
    expect(reader.loop).toEqual({
      role: "reader",
      arm: "notes",
      writer: "w",
      given: { entries: { "mod.py": 1 }, placed: { "mod.py": 1 }, stale: 0 },
    });
    expect(reader.commentBytes["mod.py"]).toBeGreaterThan(0);
    expect(readFileSync(path.join(readerDir, "agent", "AGENTS.md"), "utf8")).toBe("## Notes\n");
    expect(existsSync(path.join(readerDir, "result.json"))).toBe(true);
  });

  it("gives a bare reader neither notes nor Cairn", async () => {
    const readerDir = path.join(root, "work", "loop", "bare");
    const reader = await runOne({
      ...base,
      task: task("r", "read it"),
      loop: { role: "reader", arm: "bare", writer: "w", runDir: readerDir, checkout: { agentsMd: "# Agent notes\n" } },
    });
    expect(reader.loop).toEqual({ role: "reader", arm: "bare", writer: "w" });
    expect(reader.commentBytes).toEqual({});
    expect(existsSync(path.join(readerDir, "repo", ".git", "cairn"))).toBe(false);
  });
});

describe("agentsMdFor", () => {
  it("puts the prepend above the repository's agent notes in the notes arm only", () => {
    expect(agentsMdFor("bare", ["# Agent notes", "", "Run pytest."], "## Notes\n")).toBe("# Agent notes\n\nRun pytest.\n");
    expect(agentsMdFor("notes", ["# Agent notes"], "## Notes\n\ntext\n")).toBe("## Notes\n\ntext\n\n# Agent notes\n");
  });
});

function probe(id: string) {
  return { id, use: "understanding", kind: "change", modules: ["m.py"], prompt: id, hiddenTests: [], testCommand: "x" };
}

function writeSet(pairs: unknown, probes = ["w1", "r1", "r2", "w2", "r3"]): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "notes-set-"));
  writeUnder(root, "prepend.md", "## Notes\n");
  for (const id of probes) writeUnder(root, `probes/${id}/reference.patch`, "");
  const repos = { r: { url: "u", base: "b", setup: [] } };
  writeUnder(root, "set.json", { repos, repo: "r", start: "s", warmups: [], probes: probes.map(probe), pairs, prepend: "prepend.md" });
  return path.join(root, "set.json");
}

describe("loadNotesSet", () => {
  it("reads the pairs and the prepend beside the set", () => {
    const set = loadNotesSet(writeSet([{ writer: "w1", readers: ["r1", "r2"] }]));
    expect(set.pairs).toEqual([{ writer: "w1", readers: ["r1", "r2"] }]);
    expect(set.prepend).toBe("## Notes\n");
  });

  it("refuses a pair that names no probe of the set", () => {
    expect(() => loadNotesSet(writeSet([{ writer: "w1", readers: ["missing"] }]))).toThrow(/no probe missing/);
  });

  it("refuses a reader in two pairs, whose notes would come from two writers", () => {
    const pairs = [
      { writer: "w1", readers: ["r1"] },
      { writer: "w2", readers: ["r1"] },
    ];
    expect(() => loadNotesSet(writeSet(pairs))).toThrow(/r1 is in more than one pair/);
  });
});

describe("planLoop", () => {
  const tasks = ["w1", "r1", "r2", "w2", "r3"].map((id) => ({ ...probe(id), repo: "r", start: "s", dir: "" }));
  const set: NotesSet = {
    taskFile: { repos: {}, tasks } as unknown as TaskFile,
    pairs: [
      { writer: "w1", readers: ["r1", "r2"] },
      { writer: "w2", readers: ["r3"] },
    ],
    prepend: "",
  };
  const names = (runs: ReturnType<typeof planLoop>) => runs.map((run) => `${run.task.id}:${run.arm}:${run.rep}`);

  it("runs each writer before its readers, the bare writer only in the first repetitions, and alternates the readers' arms", () => {
    expect(names(planLoop(set, 2, 1))).toEqual([
      "w1:notes:1", "w1:bare:1", "r1:bare:1", "r1:notes:1", "r2:bare:1", "r2:notes:1",
      "w2:notes:1", "w2:bare:1", "r3:bare:1", "r3:notes:1",
      "w1:notes:2", "r1:notes:2", "r1:bare:2", "r2:notes:2", "r2:bare:2",
      "w2:notes:2", "r3:notes:2", "r3:bare:2",
    ]);
  });

  it("records each reader's writer, and plans writers alone when asked", () => {
    expect(planLoop(set, 1, 0).filter((run) => run.role === "reader").map((run) => run.writer)).toEqual(["w1", "w1", "w1", "w1", "w2", "w2"]);
    expect(names(planLoop(set, 1, 1, ["writer"]))).toEqual(["w1:notes:1", "w1:bare:1", "w2:notes:1", "w2:bare:1"]);
  });
});

describe("verdict", () => {
  it("applies the rule fixed before the results", () => {
    expect(verdict(0.7, { low: 0.5, high: 0.95 })).toBe("holds");
    expect(verdict(0.7, { low: 0.5, high: 1.05 })).toBe("inconclusive");
    expect(verdict(0.9, { low: 0.82, high: 1.1 })).toBe("fails");
  });
});
