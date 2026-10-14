import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MAIN = path.join("scripts", "benchmark", "main.ts");
const DEEP_TASKS = path.join("benchmark", "deep-tasks.json");

/** `main.ts <command>` on a new work directory, removed afterwards. */
function main(command: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const work = mkdtempSync(path.join(tmpdir(), "main-"));
  try {
    const run = spawnSync(process.execPath, [MAIN, command, "--work", work, ...args], { encoding: "utf8" });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/** `main.ts status`, which plans the queue and runs nothing. */
function status(...args: string[]): string {
  const run = main("status", "--harness", "pi", ...args);
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

  it("refuses --warmups, since a probe set names its own chains", () => {
    const run = main("status", "--tasks", DEEP_TASKS, "--warmups", path.join("benchmark", "warmups"), "--depths", "deep");

    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/deep-tasks\.json names its own warm-up chains; leave out --warmups/);
  });
});

describe("prepare over the deep-context probe set", () => {
  it("names the one entry the set prepares when --only names a probe", () => {
    const run = main("prepare", "--repo", "boxel", "--tasks", DEEP_TASKS, "--only", "enemy-leash");

    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/--only names no prepared entry of boxel: enemy-leash; its entries are deep/);
  });
});
