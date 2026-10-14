import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDirFor } from "../runner.ts";
import type { Task } from "../tasks.ts";
import { warmupDirFor } from "../warmup.ts";
import { ARMS } from "../workspace.ts";

const workDir = path.resolve("/bench");
const task: Task = { id: "t1", repo: "r", kind: "question", start: "s", prompt: "p", answerKey: [] };

/** The part of a path below the work directory, which is the same for every run. */
const below = (dir: string) => path.relative(workDir, dir);

describe("the directories an agent works in", () => {
  it("never name the arm of a fresh or a deep run", () => {
    for (const arm of ARMS) {
      for (const chain of [undefined, "w1"]) {
        const dir = below(runDirFor({ workDir, harness: "claude", task, arm, rep: 2, chain }));
        expect(dir).not.toMatch(/none|comments/i);
      }
    }
  });

  it("never name the arm of a warm-up", () => {
    for (const arm of ARMS) expect(below(warmupDirFor(workDir, "pi", "w1", arm))).not.toMatch(/none|comments/i);
  });

  it("still give every run and warm-up a directory of its own", () => {
    const runs = new Set<string>();
    for (const arm of ARMS) {
      for (const chain of [undefined, "w1", "w2"]) {
        for (const rep of [1, 2]) runs.add(runDirFor({ workDir, harness: "claude", task, arm, rep, chain }));
      }
    }
    const warmups = new Set(ARMS.flatMap((arm) => ["w1", "w2"].map((chain) => warmupDirFor(workDir, "pi", chain, arm))));

    expect(runs.size).toBe(2 * 3 * 2);
    expect(warmups.size).toBe(4);
  });
});
