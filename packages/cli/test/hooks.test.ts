import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sandbox } from "./harness.js";

// Spike finding 4: a global core.hooksPath silently disables .git/hooks.
describe("init with a global-style core.hooksPath", () => {
  let box: Sandbox;
  let repo: string;
  let hooks: string;

  beforeAll(() => {
    box = new Sandbox({ autocrlf: false });
    hooks = box.path("global-hooks").replaceAll("\\", "/");
    mkdirSync(hooks);
    writeFileSync(`${hooks}/pre-commit`, '#!/bin/sh\necho ran >> "$(git rev-parse --show-toplevel)/../previous-hook.log"\n');
    chmodSync(`${hooks}/pre-commit`, 0o755);
    repo = box.path("repo");
    box.git(box.dir, "init", "-q", "repo");
    // --global lands in the sandbox's config file, never the developer's.
    box.git(repo, "config", "--global", "core.hooksPath", hooks);
  });
  afterAll(() => box.dispose());

  it("installs into the effective hooks directory and chains the hook already there", () => {
    const report = box.cli(repo, "init");
    expect(report).toContain("previous hook now runs after it");
    expect(existsSync(box.path("repo", ".git", "hooks", "pre-commit"))).toBe(false);
    expect(readFileSync(`${hooks}/pre-commit`, "utf8")).toContain("sync --staged --add");

    box.write(box.path("repo", "a.py"), "x = 1  #~ why one\n");
    box.git(repo, "add", "-A");
    box.git(repo, "commit", "-qm", "with a comment");
    expect(box.git(repo, "show", "HEAD:.agents/comments/a.py.md")).toMatch(/^## [0-9a-z]{4}\n<!-- anchor=[0-9a-f]{8} -->\nwhy one\n$/);
    expect(box.git(repo, "show", "HEAD:a.py")).toMatch(/^x = 1 {2}#~[0-9a-z]{4}\n$/);
    expect(readFileSync(box.path("previous-hook.log"), "utf8").trim()).toBe("ran");
    expect(box.status(repo)).toBe("");
  });

  it("running init again does not chain the managed hook to itself", () => {
    box.cli(repo, "init");
    expect(readFileSync(`${hooks}/pre-commit.slopstash-chained`, "utf8")).toContain("previous-hook.log");
    expect(readFileSync(`${hooks}/pre-commit`, "utf8")).toContain("sync --staged --add");
  });

  it("stays inert in another repository that shares the hooks directory", () => {
    const other = box.path("other");
    box.git(box.dir, "init", "-q", "other");
    box.write(box.path("other", "b.py"), "y = 2  #~ untouched\n");
    box.git(other, "add", "-A");
    box.git(other, "commit", "-qm", "no filter here");
    expect(box.git(other, "show", "HEAD:b.py")).toBe("y = 2  #~ untouched\n");
    expect(existsSync(box.path("other", ".agents"))).toBe(false);
    expect(readFileSync(box.path("previous-hook.log"), "utf8").trim()).toBe("ran\nran");
  });
});
