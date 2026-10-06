import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sandbox } from "./harness.js";

// A global core.hooksPath silently disables .git/hooks (design.md § Git behavior, item 4).
describe("init with a global-style core.hooksPath", () => {
  let box: Sandbox;
  let repo: string;
  let hooks: string;

  beforeAll(() => {
    box = new Sandbox({ autocrlf: false });
    hooks = box.path("global-hooks").replaceAll("\\", "/");
    mkdirSync(hooks);
    writeFileSync(
      `${hooks}/pre-commit`,
      '#!/bin/sh\necho ran >> "$(git rev-parse --show-toplevel)/../previous-hook.log"\n',
    );
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
    expect(box.git(repo, "show", "HEAD:.agents/comments/a.py.md")).toMatch(
      /^## [0-9a-z]{4}\n<!-- pos=trail [^\n]*-->\nwhy one\n$/,
    );
    expect(box.git(repo, "show", "HEAD:a.py")).toBe("x = 1\n");
    expect(readFileSync(box.path("previous-hook.log"), "utf8").trim()).toBe("ran");
    expect(box.status(repo)).toBe("");
  });

  it("running init again does not chain the managed hook to itself", () => {
    box.cli(repo, "init");
    expect(readFileSync(`${hooks}/pre-commit.cairn-chained`, "utf8")).toContain("previous-hook.log");
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

describe("uninstall with a shared hooks directory", () => {
  let box: Sandbox;
  let hooks: string;
  const repos = ["one", "two"];

  beforeAll(() => {
    box = new Sandbox({ autocrlf: false });
    hooks = box.path("global-hooks").replaceAll("\\", "/");
    box.git(box.dir, "config", "--global", "core.hooksPath", hooks);
    for (const name of repos) {
      box.git(box.dir, "init", "-q", name);
      box.write(box.path(name, "a.py"), "x = 1\n");
      box.git(box.path(name), "add", "-A");
      box.git(box.path(name), "commit", "-qm", "base");
    }
  });
  afterAll(() => box.dispose());

  it("init says the hook directory is shared", () => {
    expect(box.cli(box.path("one"), "init")).toContain(
      "pre-commit: install (a shared hooks directory from core.hooksPath",
    );
    box.cli(box.path("two"), "init");
  });

  it("keeps the hook, so a repository still set up keeps moving bodies into sidecars", () => {
    const report = box.cli(box.path("one"), "uninstall");
    expect(report).toContain("pre-commit: kept, since core.hooksPath shares it with other repositories");
    expect(existsSync(`${hooks}/pre-commit`)).toBe(true);
    expect(box.cli(box.path("one"), "uninstall")).toBe("nothing to change\n");

    const two = box.path("two");
    box.write(box.path("two", "a.py"), "x = 1  #~ why one\n");
    box.git(two, "add", "-A");
    box.git(two, "commit", "-qm", "with a comment");
    expect(box.git(two, "show", "HEAD:.agents/comments/a.py.md")).toMatch(/\nwhy one\n$/);
    expect(box.cliResult(two, "check").status).toBe(0);
  });
});

describe("hook adapters in linked worktrees", () => {
  let box: Sandbox;
  let main: string;
  const settings = (...worktree: string[]) => box.path(...worktree, ".claude", "settings.local.json");

  beforeAll(() => {
    box = new Sandbox({ autocrlf: false });
    main = box.path("main");
    box.git(box.dir, "init", "-q", "main");
    box.write(box.path("main", "a.py"), "x = 1\n");
    box.git(main, "add", "-A");
    box.git(main, "commit", "-qm", "base");
    box.cli(main, "init");
    box.git(main, "add", "-A");
    box.git(main, "commit", "-qm", "init");
  });
  afterAll(() => box.dispose());

  it("init --hooks installs into a worktree added before it", () => {
    box.cli(main, "worktree", "add", box.path("early"), "-b", "early");
    const report = box.cli(main, "init", "--hooks", "claude-code");
    expect(report).toContain(".claude/settings.local.json: create with the claude-code hook\n");
    expect(report).toContain(`${settings("early").split(path.sep).join("/")}: create with the claude-code hook\n`);
    expect(readFileSync(settings("early"), "utf8")).toContain("hook claude-code");
  });

  it("worktree add carries the installed adapter into the new worktree", () => {
    box.cli(main, "worktree", "add", box.path("late"), "-b", "late");
    expect(readFileSync(settings("late"), "utf8")).toContain("hook claude-code");
    expect(box.status(box.path("late"))).toBe("?? .claude/\n");
  });

  it("uninstall removes the adapter from every worktree and turns worktreeConfig back off", () => {
    const report = box.cli(main, "uninstall");
    expect(report).toContain("git config: unset extensions.worktreeConfig (init turned it on)\n");
    for (const wt of [["main"], ["early"], ["late"]]) expect(existsSync(settings(...wt))).toBe(false);
    expect(box.gitResult(main, "config", "--local", "--list").stdout).not.toMatch(/worktreeconfig|cairn/i);
    expect(box.cli(main, "uninstall")).toBe("nothing to change\n");
  });

  it("leaves worktreeConfig on when init found it already on", () => {
    box.git(main, "config", "--local", "extensions.worktreeConfig", "true");
    box.cli(main, "init");
    box.cli(main, "uninstall");
    expect(box.git(main, "config", "--local", "--get", "extensions.worktreeConfig").trim()).toBe("true");
  });
});

describe("an unparseable harness settings file", () => {
  let box: Sandbox;
  let repo: string;

  beforeAll(() => {
    box = new Sandbox({ autocrlf: false });
    repo = box.path("repo");
    box.git(box.dir, "init", "-q", "repo");
    box.write(box.path("repo", ".claude", "settings.local.json"), '{ "permissions": { "allow": [], }, }\n');
  });
  afterAll(() => box.dispose());

  it("does not stop init or uninstall, which only look for a hook it cannot hold", () => {
    expect(box.cli(repo, "init")).not.toContain("settings.local.json");
    expect(box.cli(repo, "uninstall")).not.toContain("settings.local.json");
    expect(readFileSync(box.path("repo", ".claude", "settings.local.json"), "utf8")).toContain('"allow": [], }');
  });

  it("still reports the file when --hooks asks to install into it", () => {
    const result = box.cliResult(repo, "init", "--hooks", "claude-code");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("is not valid JSON");
  });
});

describe("the refresh usage text", () => {
  let box: Sandbox;
  let repo: string;

  beforeAll(() => {
    box = new Sandbox({ autocrlf: false });
    repo = box.path("repo");
    box.git(box.dir, "init", "-q", "repo");
    box.cli(repo, "init");
  });
  afterAll(() => box.dispose());

  it("names exactly the hooks init installs to run refresh", () => {
    const usage = box.cli(repo, "help");
    // The refresh entry runs from its line to the next command's line.
    const entry = /^ {2}refresh .*\n(?: {4,}.*\n)*/m.exec(usage)?.[0] ?? "";
    const named = [...new Set(entry.match(/\bpost-[a-z]+/g))].sort();
    const hooksDir = path.join(repo, ".git", "hooks");
    const installed = readdirSync(hooksDir)
      .filter((name) => readFileSync(path.join(hooksDir, name), "utf8").includes(" refresh "))
      .sort();
    expect(installed.length).toBeGreaterThan(0);
    expect(named).toEqual(installed);
  });
});
