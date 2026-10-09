import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sandbox } from "./harness.js";

// Private mode keeps the sidecars in the git common dir, off every branch (design.md § Private mode).
describe.each([false, true])("private mode (autocrlf=%s)", (autocrlf) => {
  it("keeps the sidecar out of the commit and still shows the comment in an agent worktree", () => {
    const box = new Sandbox({ autocrlf });
    try {
      const repo = box.path("repo");
      box.git(box.dir, "init", "-q", "repo");
      box.cli(repo, "init");
      mkdirSync(box.path("repo", ".git", "cairn", "comments"), { recursive: true });

      box.write(box.path("repo", "a.py"), "def f():\n    #~ explains f\n    return 1\n");
      box.git(repo, "add", "-A");
      box.git(repo, "commit", "-qm", "with a comment");

      expect(box.git(repo, "show", "HEAD:a.py")).toBe("def f():\n    return 1\n");
      expect(box.git(repo, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain(".agents/");
      expect(existsSync(box.path("repo", ".agents", "comments", "a.py.md"))).toBe(false);
      expect(readFileSync(box.path("repo", ".git", "cairn", "comments", "a.py.md"), "utf8")).toMatch(
        /^## [0-9a-z]{4}\n<!-- [^\n]*-->\nexplains f\n$/,
      );
      expect(box.status(repo)).toBe("");

      box.cli(repo, "worktree", "add", "../agent");
      expect(box.read(box.path("agent", "a.py"))).toMatch(/^def f\(\):\n {4}#~[0-9a-z]{4} explains f\n {4}return 1\n$/);
      expect(box.status(box.path("agent"))).toBe("");
    } finally {
      box.dispose();
    }
  });

  describe("init --private", () => {
    let box: Sandbox;
    let repo: string;
    // The team's own attributes, in the working tree's terminator, which init must leave byte for byte.
    let teamAttributes: Buffer;

    beforeAll(() => {
      box = new Sandbox({ autocrlf });
      repo = box.path("repo");
      box.git(box.dir, "init", "-q", "repo");
      box.write(box.path("repo", ".gitattributes"), "*.png binary\n");
      box.write(box.path("repo", "a.py"), "def f():\n    return 1\n");
      box.git(repo, "add", "-A");
      box.git(repo, "commit", "-qm", "base");
      teamAttributes = readFileSync(box.path("repo", ".gitattributes"));
      box.cli(repo, "init", "--private", "--hooks", "claude-code");
    });
    afterAll(() => box.dispose());

    it("writes only untracked config", () => {
      expect(readFileSync(box.path("repo", ".gitattributes"))).toEqual(teamAttributes);
      expect(readFileSync(box.path("repo", ".git", "info", "attributes"), "utf8")).toContain("*.py filter=cairn");
      expect(existsSync(box.path("repo", ".git", "cairn", "comments"))).toBe(true);
      expect(box.git(repo, "config", "--get", "filter.cairn.process")).toContain("filter-process");
      expect(existsSync(box.path("repo", ".claude", "settings.local.json"))).toBe(true);
      expect(box.status(repo)).toBe("");
    });

    it("commits the code alone and keeps the comment in the store", () => {
      box.write(box.path("repo", "a.py"), "def f():\n    #~ explains f\n    return 2\n");
      box.git(repo, "commit", "-qam", "with a comment");
      expect(box.git(repo, "show", "--name-only", "--format=", "HEAD").trim()).toBe("a.py");
      expect(box.git(repo, "show", "HEAD:a.py")).toBe("def f():\n    return 2\n");
      expect(readFileSync(box.path("repo", ".git", "cairn", "comments", "a.py.md"), "utf8")).toContain("explains f");
      expect(box.status(repo)).toBe("");
    });

    it("keeps private mode when init runs again without the flag", () => {
      box.cli(repo, "init");
      expect(readFileSync(box.path("repo", ".gitattributes"))).toEqual(teamAttributes);
      expect(box.status(repo)).toBe("");
    });

    it("uninstall removes the untracked config and keeps the store", () => {
      const report = box.cli(repo, "uninstall");
      expect(report).toContain(".git/cairn/comments");
      expect(readFileSync(box.path("repo", ".gitattributes"))).toEqual(teamAttributes);
      expect(existsSync(box.path("repo", ".git", "info", "attributes"))).toBe(false);
      expect(box.cliResult(repo, "check").status).toBe(0);
      expect(readFileSync(box.path("repo", ".git", "cairn", "comments", "a.py.md"), "utf8")).toContain("explains f");
    });
  });

  describe("init --private in a repository with tracked sidecars", () => {
    let box: Sandbox;
    let repo: string;

    beforeAll(() => {
      box = new Sandbox({ autocrlf });
      repo = box.path("repo");
      box.git(box.dir, "init", "-q", "repo");
      box.cli(repo, "init");
      box.write(box.path("repo", "a.py"), "def f():\n    #~ explains f\n    return 1\n");
      box.git(repo, "add", "-A");
      box.git(repo, "commit", "-qm", "tracked comments");
    });
    afterAll(() => box.dispose());

    it("refuses without --migrate", () => {
      const result = box.cliResult(repo, "init", "--private");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--migrate");
      expect(existsSync(box.path("repo", ".git", "cairn", "comments"))).toBe(false);
    });

    it("moves the sidecars into the store with --migrate", () => {
      box.cli(repo, "init", "--private", "--migrate");
      expect(readFileSync(box.path("repo", ".git", "cairn", "comments", "a.py.md"), "utf8")).toContain("explains f");
      box.git(repo, "commit", "-qm", "comments leave the branch");
      expect(box.git(repo, "ls-tree", "-r", "--name-only", "HEAD").trim()).toBe("a.py");
      expect(box.status(repo)).toBe("");

      box.cli(repo, "worktree", "add", "../agent");
      expect(box.read(box.path("agent", "a.py"))).toMatch(/#~[0-9a-z]{4} explains f/);
    });
  });
});
