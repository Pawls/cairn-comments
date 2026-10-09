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

  it("check --fix follows a rename and a deletion in the store", () => {
    const box = new Sandbox({ autocrlf });
    try {
      const repo = box.path("repo");
      const store = (...parts: string[]) => box.path("repo", ".git", "cairn", "comments", ...parts);
      box.git(box.dir, "init", "-q", "repo");
      box.cli(repo, "init", "--private");
      box.write(box.path("repo", "a.py"), "def f():\n    #~ explains f\n    return 1\n");
      box.write(box.path("repo", "c.py"), "def g():\n    #~ explains g\n    return 3\n");
      box.git(repo, "add", "-A");
      box.git(repo, "commit", "-qm", "two files with comments");

      box.git(repo, "mv", "a.py", "b.py");
      box.git(repo, "rm", "-q", "c.py");
      box.git(repo, "commit", "-qm", "rename one, delete the other");

      expect(existsSync(store("a.py.md"))).toBe(false);
      expect(readFileSync(store("b.py.md"), "utf8")).toContain("explains f");
      expect(existsSync(store("c.py.md"))).toBe(false);
      expect(box.cliResult(repo, "check").status).toBe(0);
      expect(box.status(repo)).toBe("");
    } finally {
      box.dispose();
    }
  });

  describe("push and fetch", () => {
    let box: Sandbox;
    let owner: string;
    let mate: string;
    const stored = (repo: string, file: string) => readFileSync(`${repo}/.git/cairn/comments/${file}.md`, "utf8");

    beforeAll(() => {
      box = new Sandbox({ autocrlf });
      owner = box.path("owner");
      mate = box.path("mate");
      box.git(box.dir, "init", "-q", "--bare", "remote.git");
      box.git(box.dir, "init", "-q", "owner");
      box.cli(owner, "init", "--private");
      box.write(`${owner}/a.py`, "def f():\n    #~ explains f\n    return 1\n\n\ndef g():\n    return 2\n");
      box.write(`${owner}/b.py`, "def h():\n    return 3\n");
      box.git(owner, "add", "-A");
      box.git(owner, "commit", "-qm", "base");
      box.git(owner, "remote", "add", "origin", box.path("remote.git"));
      box.git(owner, "push", "-q", "origin", "main");
    });
    afterAll(() => box.dispose());

    it("gives a fresh clone the owner's comments only after fetch", () => {
      box.cli(owner, "push");
      box.git(box.dir, "clone", "-q", box.path("remote.git"), "mate");
      box.cli(mate, "init", "--private");
      box.cli(mate, "worktree", "add", "../mate-before");
      expect(box.read(box.path("mate-before", "a.py"))).not.toContain("explains f");

      box.cli(mate, "fetch");
      expect(stored(mate, "a.py")).toBe(stored(owner, "a.py"));
      box.cli(owner, "worktree", "add", "../owner-agent");
      box.cli(mate, "worktree", "add", "../mate-agent");
      expect(box.read(box.path("mate-agent", "a.py"))).toContain("explains f");
      expect(box.read(box.path("mate-agent", "a.py"))).toBe(box.read(box.path("owner-agent", "a.py")));
    });

    it("merges comments both sides added to one file, entry by entry", () => {
      // Each side changes code too: a comment-only edit cleans to the committed blob, so in
      // private mode only `sync` records it, never a commit.
      box.write(`${mate}/a.py`, "def f():\n    return 1\n\n\ndef g():\n    #~ mate's note\n    return 4\n");
      box.write(`${mate}/b.py`, "def h():\n    #~ mate's other note\n    return 4\n");
      box.git(mate, "commit", "-qam", "mate comments g and h");
      box.cli(mate, "push");

      box.write(`${owner}/a.py`, "def f():\n    #~ explains f\n    return 1  #~ owner's note\n\n\ndef g():\n    return 5\n");
      box.git(owner, "commit", "-qam", "owner comments f again");
      const rejected = box.cliResult(owner, "push");
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain("fetch");

      box.cli(owner, "fetch");
      expect(stored(owner, "a.py")).toContain("explains f");
      expect(stored(owner, "a.py")).toContain("owner's note");
      expect(stored(owner, "a.py")).toContain("mate's note");
      expect(stored(owner, "b.py")).toContain("mate's other note");
      box.cli(owner, "push");

      box.cli(mate, "fetch");
      expect(stored(mate, "a.py")).toBe(stored(owner, "a.py"));
      expect(stored(mate, "b.py")).toBe(stored(owner, "b.py"));
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
