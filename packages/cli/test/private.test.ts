import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
});
