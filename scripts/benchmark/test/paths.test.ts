import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loopRunDir, NOTES_ARMS } from "../notes.ts";
import { legacyRunDirs, runDirFor } from "../runner.ts";
import type { Task, WarmupChain } from "../tasks.ts";
import { warmupDirFor } from "../warmup.ts";
import { ARMS } from "../workspace.ts";

const workDir = path.resolve("/bench");
const task: Task = { id: "t1", repo: "r", kind: "question", start: "s", prompt: "p", answerKey: [] };
const chain = (id: string): WarmupChain => ({ id, repo: "r", start: "s", prompts: ["warm up"] });

/** The part of a path below the work directory, which is the same for every run. */
const below = (dir: string) => path.relative(workDir, dir);

describe("the directories an agent works in", () => {
  it("never name the arm of a fresh or a deep run", () => {
    for (const arm of ARMS) {
      for (const forks of [undefined, chain("w1")]) {
        const dir = below(runDirFor({ workDir, harness: "claude", task, arm, rep: 2, chain: forks }));
        expect(dir).not.toMatch(/none|comments/i);
      }
    }
  });

  it("never name the arm or the role of a notes-loop run", () => {
    const dirs = new Set<string>();
    for (const arm of NOTES_ARMS) {
      for (const role of ["writer", "reader"] as const) {
        const dir = below(loopRunDir(workDir, "claude", { task, role, arm, writer: "w", rep: 2 }));
        expect(dir).not.toMatch(/bare|notes|writer|reader/i);
        dirs.add(dir);
      }
    }
    expect(dirs.size).toBe(2);
  });

  it("never name the arm of a warm-up", () => {
    for (const arm of ARMS) expect(below(warmupDirFor(workDir, "pi", "w1", arm))).not.toMatch(/none|comments/i);
  });

  it("still give every run and warm-up a directory of its own", () => {
    const runs = new Set<string>();
    for (const arm of ARMS) {
      for (const forks of [undefined, chain("w1"), chain("w2")]) {
        for (const rep of [1, 2]) runs.add(runDirFor({ workDir, harness: "claude", task, arm, rep, chain: forks }));
      }
    }
    const warmups = new Set(ARMS.flatMap((arm) => ["w1", "w2"].map((id) => warmupDirFor(workDir, "pi", id, arm))));

    expect(runs.size).toBe(2 * 3 * 2);
    expect(warmups.size).toBe(4);
  });
});

describe("legacyRunDirs", () => {
  it("finds results under the old <arm>-<rep> names, which run and status would no longer see", () => {
    const work = mkdtempSync(path.join(tmpdir(), "legacy-"));
    const result = (...parts: string[]) => {
      mkdirSync(path.join(work, "runs", ...parts), { recursive: true });
      writeFileSync(path.join(work, "runs", ...parts, "result.json"), "{}");
    };
    result("claude", "t1", "none-3");
    result("pi", "t2", "comments-1");
    result("pi", "t2", "0123456789ab");

    expect(legacyRunDirs(work).map((dir) => path.relative(work, dir).split(path.sep).join("/")).sort()).toEqual([
      "runs/claude/t1/none-3",
      "runs/pi/t2/comments-1",
    ]);
  });

  it("finds none in a work directory with no runs yet", () => {
    expect(legacyRunDirs(mkdtempSync(path.join(tmpdir(), "legacy-")))).toEqual([]);
  });
});
