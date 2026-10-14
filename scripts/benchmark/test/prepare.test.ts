import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENTS_TEXT, findPython, prepareTask, type PreparedTask } from "../prepare.ts";
import { checkoutArm, isolatedEnv } from "../workspace.ts";

const python = findPython();

describe.skipIf(!python)("prepareTask", () => {
  let dir: string;
  let mirror: string;
  let start: string;
  let env: Record<string, string>;
  let prepared: PreparedTask;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, env, encoding: "utf8" });
  }

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "prepare-"));
    env = isolatedEnv(path.join(dir, "state"), path.join(dir, "cli-home"));
    const source = path.join(dir, "source");
    mkdirSync(path.join(source, ".claude"), { recursive: true });
    mkdirSync(path.join(source, "docs"));
    writeFileSync(path.join(source, "mod.py"), "# why\nx = 1  # one\n");
    writeFileSync(path.join(source, "README.md"), "# project\nthe fix is in mod.py\n");
    writeFileSync(path.join(source, "docs", "plan.md"), "plan\n");
    writeFileSync(path.join(source, ".claude", "settings.json"), "{}\n");
    writeFileSync(path.join(source, "AGENTS.md"), "long agent guide\n");
    git(dir, "init", "-q", "source");
    git(source, "add", ".");
    git(source, "commit", "-qm", "start");
    start = git(source, "rev-parse", "HEAD").trim();
    git(dir, "clone", "-q", "--mirror", source, path.join(dir, "mirror.git"));
    mirror = path.join(dir, "mirror.git");
    prepared = prepareTask({ mirror, taskId: "t1", start, python: python!, env });
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

  function checkout(arm: "none" | "comments"): string {
    const runDir = path.join(dir, `run-${arm}`);
    mkdirSync(runDir);
    return checkoutArm({ mirror, runDir, start, arm, hooks: [], env, prepared });
  }

  it("gives both arms the same files, minus markdown and agent folders, plus the same minimal AGENTS.md", () => {
    for (const arm of ["none", "comments"] as const) {
      const agent = checkout(arm);

      expect(existsSync(path.join(agent, "docs"))).toBe(false);
      expect(existsSync(path.join(agent, ".claude"))).toBe(false);
      expect(readFileSync(path.join(agent, "AGENTS.md"), "utf8")).toBe(AGENTS_TEXT);
      expect(readFileSync(path.join(agent, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    }
  });

  it("strips the comments in the none arm only", () => {
    expect(readFileSync(path.join(checkout("none"), "mod.py"), "utf8")).toBe("x = 1\n");
    expect(readFileSync(path.join(checkout("comments"), "mod.py"), "utf8")).toBe("# why\nx = 1  # one\n");
  });

  it("records the bytes the comments add to each file", () => {
    expect(prepared.commentBytes).toEqual({ "mod.py": "# why\nx = 1  # one\n".length - "x = 1\n".length });
  });

  it("leaves no history for the agent to read the original from", () => {
    const agent = checkout("none");

    expect(git(agent, "rev-list", "--all", "--count").trim()).toBe("1");
    expect(git(agent, "remote").trim()).toBe("");
  });
});
