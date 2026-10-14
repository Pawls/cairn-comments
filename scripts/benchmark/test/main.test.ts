import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MAIN = path.join("scripts", "benchmark", "main.ts");
const DEEP_TASKS = path.join("benchmark", "deep-tasks.json");

/** `main.ts status` on a new work directory, which plans the queue and runs nothing. */
function status(...args: string[]): string {
  const work = mkdtempSync(path.join(tmpdir(), "status-"));
  const run = spawnSync(process.execPath, [MAIN, "status", "--work", work, "--harness", "pi", ...args], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout;
}

describe("status over the deep-context probe set", () => {
  it("plans every probe fresh and forked from each of the set's own chains, in both arms", () => {
    // 8 probes, 2 arms, and 3 starts: fresh and one per chain.
    expect(status("--tasks", DEEP_TASKS, "--depths", "fresh,deep", "--reps", "1")).toContain("pi: 0 of 48 runs finished, 48 left");
  });

  it("forks only the chains --chains names", () => {
    expect(status("--tasks", DEEP_TASKS, "--depths", "deep", "--chains", "game-systems", "--reps", "1")).toContain("pi: 0 of 16 runs finished");
  });
});
