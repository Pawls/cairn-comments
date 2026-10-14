import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findPython, prepareTask, readPrepared, type PreparedTask } from "../prepare.ts";
import { checkoutArm, ensureMirror, isolatedEnv } from "../workspace.ts";

const python = findPython();

const AGENT_NOTES = ["# Agent notes", "", "Run the tests with `pytest`."];

describe.skipIf(!python)("prepareTask", () => {
  let dir: string;
  let source: string;
  let mirror: string;
  let start: string;
  let env: Record<string, string>;
  let prepared: PreparedTask;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, env, encoding: "utf8" });
  }

  function sortedLines(output: string): string[] {
    return output.split("\n").filter(Boolean).sort();
  }

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "prepare-"));
    env = isolatedEnv(path.join(dir, "state"), path.join(dir, "cli-home"));
    source = path.join(dir, "source");
    mkdirSync(path.join(source, ".claude"), { recursive: true });
    mkdirSync(path.join(source, "docs"));
    writeFileSync(path.join(source, "mod.py"), "# why\nx = 1  # one\n");
    // git quotes a non-ASCII path unless asked for NUL-separated output.
    writeFileSync(path.join(source, "ü.py"), "# c\ny = 1\n");
    writeFileSync(path.join(source, "README.md"), "# project\nthe fix is in mod.py\n");
    writeFileSync(path.join(source, "docs", "plan.md"), "plan\n");
    writeFileSync(path.join(source, ".claude", "settings.json"), "{}\n");
    writeFileSync(path.join(source, "AGENTS.md"), "long agent guide\n");
    git(dir, "init", "-q", "source");
    git(source, "add", ".");
    git(source, "commit", "-qm", "start");
    start = git(source, "rev-parse", "HEAD").trim();
    // A tag on the original commit, as a real repository has; a clone must not follow it.
    git(source, "tag", "v1");
    mirror = ensureMirror(dir, "repo", { url: source, base: start, setup: [] }, env, [start]);
    prepared = prepareTask({ mirror, taskId: "t1", start, python: python!, env, agentNotes: AGENT_NOTES });
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

  function checkout(arm: "none" | "comments"): string {
    const runDir = mkdtempSync(path.join(dir, `run-${arm}-`));
    return checkoutArm({ mirror, runDir, start, arm, hooks: [], env, prepared });
  }

  it("gives both arms the same files, minus markdown and agent folders, plus the task file's agent notes", () => {
    for (const arm of ["none", "comments"] as const) {
      const agent = checkout(arm);

      expect(existsSync(path.join(agent, "docs"))).toBe(false);
      expect(existsSync(path.join(agent, ".claude"))).toBe(false);
      expect(readFileSync(path.join(agent, "AGENTS.md"), "utf8")).toBe("# Agent notes\n\nRun the tests with `pytest`.\n");
      expect(readFileSync(path.join(agent, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    }
  });

  it("strips the comments in the none arm only", () => {
    expect(readFileSync(path.join(checkout("none"), "mod.py"), "utf8")).toBe("x = 1\n");
    expect(readFileSync(path.join(checkout("comments"), "mod.py"), "utf8")).toBe("# why\nx = 1  # one\n");
  });

  it("records the bytes the comments add to each file", () => {
    expect(prepared.commentBytes).toEqual({
      "mod.py": "# why\nx = 1  # one\n".length - "x = 1\n".length,
      "ü.py": "# c\n".length,
    });
  });

  it("records the start commit and agent notes the arm commits were built from", () => {
    expect(prepared.start).toBe(start);
    expect(prepared.agentNotes).toEqual(AGENT_NOTES);
  });

  it("gives both arms the same commit message and no branch that names the arm", () => {
    const messages = new Set<string>();
    for (const arm of ["none", "comments"] as const) {
      const agent = checkout(arm);

      messages.add(git(agent, "log", "-1", "--format=%B"));
      expect(git(agent, "branch", "--all", "--format=%(refname)").trim()).toBe("refs/heads/bench");
    }
    expect(messages.size).toBe(1);
    expect([...messages][0]).not.toMatch(/comment|none|t1/i);
  });

  it("leaves no history for the agent to read the original from", () => {
    const agent = checkout("none");

    expect(git(agent, "rev-list", "--all", "--count").trim()).toBe("1");
    expect(git(agent, "tag").trim()).toBe("");
    expect(git(agent, "remote").trim()).toBe("");
  });

  it("copies only the arm's own objects into the clone, so no unreachable original is left to read", () => {
    const agent = checkout("none");

    const stored = sortedLines(git(agent, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)"));
    const reachable = sortedLines(git(agent, "rev-list", "--objects", "--all").replaceAll(/ .*/g, ""));
    expect(stored).toEqual(reachable);
  });

  // Last: it moves the source on, which the tests above do not expect.
  it("keeps the prepared branches when the mirror fetches a commit it lacks", () => {
    writeFileSync(path.join(source, "mod.py"), "x = 2\n");
    git(source, "commit", "-qam", "next");
    const next = git(source, "rev-parse", "HEAD").trim();

    ensureMirror(dir, "repo", { url: source, base: start, setup: [] }, env, [next]);

    expect(git(mirror, "cat-file", "-t", next).trim()).toBe("commit");
    expect(readFileSync(path.join(checkout("none"), "mod.py"), "utf8")).toBe("x = 1\n");
  });
});

describe("readPrepared", () => {
  const t1: PreparedTask = { taskId: "t1", start: "abc", agentNotes: ["notes"], commentBytes: { "mod.py": 12 }, unstripped: [] };
  let dir: string;
  let file: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "prepared-"));
    file = path.join(dir, "repo.json");
    writeFileSync(file, JSON.stringify({ t1 }));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("returns the prepared tasks when each matches its task's start and the agent notes", () => {
    expect(readPrepared(file, "repo", [{ id: "t1", start: "abc" }], ["notes"])).toEqual({ t1 });
  });

  it("names a task the prepared file lacks instead of running it without its arm commits", () => {
    const tasks = [
      { id: "t1", start: "abc" },
      { id: "t2", start: "def" },
    ];

    expect(() => readPrepared(file, "repo", tasks, ["notes"])).toThrow("no prepared commits for repo task t2; run prepare --only t2");
    expect(() => readPrepared(path.join(dir, "missing.json"), "repo", tasks, ["notes"])).toThrow(
      "no prepared commits for repo; run prepare first",
    );
  });

  it("refuses arm commits built from another start commit or other agent notes", () => {
    const stale = "prepared commits for repo task t1 are stale; run prepare --only t1";

    expect(() => readPrepared(file, "repo", [{ id: "t1", start: "abd" }], ["notes"])).toThrow(stale);
    expect(() => readPrepared(file, "repo", [{ id: "t1", start: "abc" }], ["other notes"])).toThrow(stale);
  });
});
