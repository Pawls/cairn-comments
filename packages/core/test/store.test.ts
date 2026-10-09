import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commonGitDir, privateSidecarDir, sidecarDir } from "../src/index.js";

describe("the private store", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "cairn-store-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("is off without the folder, and the sidecars are tracked", () => {
    mkdirSync(path.join(root, ".git"));
    expect(privateSidecarDir(root)).toBeUndefined();
    expect(sidecarDir(root)).toBe(path.join(root, ".agents", "comments"));
  });

  it("is the folder in the git dir when it exists", () => {
    mkdirSync(path.join(root, ".git", "cairn", "comments"), { recursive: true });
    expect(privateSidecarDir(root)).toBe(path.join(root, ".git", "cairn", "comments"));
  });

  it("is found through a linked worktree's gitdir pointer and commondir", () => {
    const main = path.join(root, "main");
    mkdirSync(path.join(main, ".git", "worktrees", "agent"), { recursive: true });
    mkdirSync(path.join(main, ".git", "cairn", "comments"), { recursive: true });
    writeFileSync(path.join(main, ".git", "worktrees", "agent", "commondir"), "../..\n");
    const agent = path.join(root, "agent");
    mkdirSync(agent);
    writeFileSync(path.join(agent, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "agent")}\n`);
    expect(commonGitDir(agent)).toBe(path.join(main, ".git"));
    expect(privateSidecarDir(agent)).toBe(path.join(main, ".git", "cairn", "comments"));
  });

  // A failed check must not pick the tracked folder: sync would then write private comments onto the branch.
  it.skipIf(process.platform === "win32")("throws when the store cannot be checked, rather than falling back to the branch", () => {
    mkdirSync(path.join(root, ".git", "cairn"), { recursive: true });
    symlinkSync("comments", path.join(root, ".git", "cairn", "comments"));
    expect(() => privateSidecarDir(root)).toThrow(/ELOOP/);
  });
});
