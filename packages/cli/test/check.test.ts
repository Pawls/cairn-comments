import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sandbox } from "./harness.js";

const NOTE = "retries are safe: ledger write is idempotent";
const SOURCE = `def settle(order):\n    #~ ${NOTE}\n    ledger.write(order.id)\n`;
const sidecar = (file: string) => `.agents/comments/${file}.md`;

describe.each([true, false])("check (autocrlf=%s)", (autocrlf) => {
  let box: Sandbox;
  let main: string;
  let id: string;

  beforeAll(() => {
    box = new Sandbox({ autocrlf });
    main = box.path("main");
    box.write(box.path("main", "a.py"), SOURCE);
    box.git(box.dir, "init", "-q", "main");
    box.cli(main, "init");
    box.git(main, "add", "-A");
    box.git(main, "commit", "-qm", "base");
    // Collapsed like an owner's checkout, so a rename carries no inline text for sync to recover.
    box.cli(main, "collapse");
    id = /#~([0-9a-z]{4})/.exec(box.read(box.path("main", "a.py")))![1]!;
  });
  afterAll(() => box.dispose());

  const check = (cwd: string, ...args: string[]) => box.cliResult(cwd, "check", ...args);
  const commit = (cwd: string, message: string, ...args: string[]) => box.gitResult(cwd, "commit", "-qm", message, ...args);

  it("passes on a repository the filter kept consistent", () => {
    expect(check(main)).toMatchObject({ status: 0, stdout: "" });
  });

  it("the pre-commit hook moves the body along with a renamed file", () => {
    box.git(main, "mv", "a.py", "b.py");
    const result = commit(main, "rename");
    // Git sends hook output to stderr.
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`relocated ${id}: ${sidecar("a.py")} -> ${sidecar("b.py")}\n`);
    expect(box.git(main, "show", "--name-status", "--no-renames", "--format=", "HEAD").trim().split("\n").sort()).toEqual(
      [`A\t${sidecar("b.py")}`, "A\tb.py", `D\t${sidecar("a.py")}`, "D\ta.py"].sort(),
    );
    expect(box.git(main, "show", `HEAD:${sidecar("b.py")}`)).toContain(NOTE);
    expect(box.status(main)).toBe("");
    expect(check(main).status).toBe(0);
  });

  it("without the hook, check names both halves of a rename and --fix repairs it", () => {
    box.git(main, "mv", "b.py", "c.py");
    commit(main, "rename, hook skipped", "--no-verify");
    const found = check(main);
    expect(found.status).toBe(1);
    expect(found.stdout).toBe(
      `${sidecar("b.py")}: body ${id} has no marker in b.py (\`slopstash check --fix\` moves it to ${sidecar("c.py")})\n` +
        `c.py:2: marker ${id} has no body in ${sidecar("c.py")}\n`,
    );
    expect(JSON.parse(check(main, "--json").stdout).problems.map((p: { kind: string }) => p.kind)).toEqual(["orphan-body", "missing-body"]);
    expect(check(main, "--fix")).toMatchObject({ status: 0, stdout: `relocated ${id}: ${sidecar("b.py")} -> ${sidecar("c.py")}\n` });
    expect(box.status(main)).toBe(`R  ${sidecar("b.py")} -> ${sidecar("c.py")}\n`);
    commit(main, "fix");
    expect(check(main)).toMatchObject({ status: 0, stdout: "" });
  });

  it("deleting a comment drops its body in the same commit", () => {
    const file = box.path("main", "c.py");
    box.write(file, box.read(file).replace(`    #~${id}\n`, ""));
    const result = commit(main, "drop the comment", "-a");
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`removed ${id} from ${sidecar("c.py")}: its marker is gone from c.py\n`);
    expect(box.git(main, "ls-files", ".agents")).toBe("");
    expect(box.status(main)).toBe("");
  });

  it("refuses a commit that would strand a moved marker in an unstaged file", () => {
    box.write(box.path("main", "d.py"), "def a():\n    #~ keep me\n    pass\n");
    box.git(main, "add", "d.py");
    commit(main, "d");
    const moved = /#~([0-9a-z]{4})/.exec(box.read(box.path("main", "d.py")))![1]!;
    box.write(box.path("main", "d.py"), "def a():\n    pass\n");
    box.write(box.path("main", "e.py"), `def b():\n    #~${moved}\n    pass\n`);
    box.git(main, "add", "d.py");
    const result = commit(main, "half a move");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${sidecar("d.py")}: body ${moved} has no marker in d.py (referenced in the working tree by e.py; stage it)`);
    box.git(main, "add", "e.py");
    const whole = commit(main, "the whole move");
    expect(whole.status).toBe(0);
    expect(whole.stderr).toContain(`relocated ${moved}: ${sidecar("d.py")} -> ${sidecar("e.py")}\n`);
    expect(box.git(main, "show", `HEAD:${sidecar("e.py")}`)).toContain("keep me");
  });

  it("CI in a clone without the filter catches committed comment text and dangling ids", () => {
    const clone = box.path("clone");
    box.git(box.dir, "clone", "-q", "main", "clone");
    box.write(box.path("clone", "f.py"), "x = 1  #~ an agent wrote this\ny = 2  #~todo\n");
    box.git(clone, "add", "f.py");
    box.git(clone, "commit", "-qm", "no filter here");
    const result = check(clone);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(
      "f.py:1: comment committed with its text: an agent wrote this\n" +
        `f.py:2: marker todo has no body in ${sidecar("f.py")}\n` +
        "hint: this clone commits without the filter; run `slopstash init`, then `slopstash collapse` and commit the result\n",
    );
    expect(check(clone, "e.py").status).toBe(0);
  });

  it("ignored sidecars mean dangling markers by choice", () => {
    const clone = box.path("clone");
    box.write(box.path("clone", ".gitignore"), ".agents/comments/\n");
    expect(check(clone).stdout).toBe(
      "f.py:1: comment committed with its text: an agent wrote this\n" +
        "hint: this clone commits without the filter; run `slopstash init`, then `slopstash collapse` and commit the result\n",
    );
  });
});

describe.each([true, false])("sidecar merge driver (autocrlf=%s)", (autocrlf) => {
  let box: Sandbox;
  let main: string;
  const file = () => box.path("main", sidecar("a.py"));
  const BASE = "## ab12\n<!-- anchor=11111111 -->\nretries are safe\n";

  beforeAll(() => {
    box = new Sandbox({ autocrlf });
    main = box.path("main");
    box.git(box.dir, "init", "-q", "main");
    box.cli(main, "init");
    box.write(file(), BASE);
    box.git(main, "add", "-A");
    box.git(main, "commit", "-qm", "base", "--no-verify");
  });
  afterAll(() => box.dispose());

  const branch = (name: string, text: string) => {
    box.git(main, "checkout", "-q", "-b", name, "main");
    writeFileSync(file(), text);
    box.git(main, "commit", "-qam", name, "--no-verify");
    box.git(main, "checkout", "-q", "main");
  };

  it("merges entries both branches appended, which a text merge would conflict on", () => {
    branch("left", BASE + "\n## cd34\nleft note\n");
    branch("right", BASE + "\n## ef56\nright note\n");
    box.git(main, "merge", "-q", "left");
    expect(box.gitResult(main, "merge", "-q", "right", "-m", "merge", "--no-verify").status).toBe(0);
    expect(readFileSync(file(), "utf8")).toBe(BASE + "\n## cd34\nleft note\n\n## ef56\nright note\n");
  });

  it("stops on a body both branches edited, with the conflict inside that body", () => {
    const now = readFileSync(file(), "utf8");
    branch("one", now.replace("retries are safe", "retries are safe; the ledger dedupes"));
    branch("two", now.replace("retries are safe", "retries are safe because writes are idempotent"));
    box.git(main, "merge", "-q", "one");
    const result = box.gitResult(main, "merge", "two", "-m", "merge", "--no-verify");
    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain("both sides changed ab12");
    expect(readFileSync(file(), "utf8")).toContain(
      "## ab12\n<!-- anchor=11111111 -->\n<<<<<<< ours\nretries are safe; the ledger dedupes\n=======\nretries are safe because writes are idempotent\n>>>>>>> theirs\n\n## cd34\n",
    );
    box.git(main, "merge", "--abort");
  });
});

describe("init --dry-run, uninstall, and promote --all", () => {
  let box: Sandbox;
  let main: string;

  beforeAll(() => {
    box = new Sandbox({ autocrlf: false });
    main = box.path("main");
    box.git(box.dir, "init", "-q", "main");
    box.write(box.path("main", ".gitattributes"), "*.png binary\n.agents/comments/** merge=union text eol=lf\n");
    box.write(box.path("main", "AGENTS.md"), "# Rules\n");
    box.write(box.path("main", ".claude/settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }, null, 2) + "\n");
    box.write(box.path("main", "a.py"), SOURCE);
    box.git(main, "add", "-A");
    box.git(main, "commit", "-qm", "base");
  });
  afterAll(() => box.dispose());

  const config = () => box.gitResult(main, "config", "--local", "--list").stdout;

  it("a dry run prints the plan and changes nothing", () => {
    const before = config();
    const out = box.cli(main, "init", "--dry-run", "--hooks", "claude-code,cursor", "--agents-md");
    expect(out).toMatch(/^dry run; would change:\n {2}git config: set extensions\.worktreeConfig = true\n/);
    expect(out).toContain("  .gitattributes: add 14 line(s), remove 1 line(s)\n");
    expect(out).toContain("  .claude/settings.local.json: set the claude-code hook\n");
    expect(out).toContain("  .cursor/hooks.json: create with the cursor hook\n");
    expect(out).toContain("  AGENTS.md: add the sigil convention\n");
    expect(config()).toBe(before);
    expect(box.status(main)).toBe("");
  });

  it("init replaces the union line from earlier versions and reports only what changed", () => {
    box.cli(main, "init", "--hooks", "claude-code,cursor", "--agents-md");
    const attributes = box.read(box.path("main", ".gitattributes"));
    expect(attributes).toMatch(/^\*\.png binary\n\*\.py filter=slopstash\n/);
    expect(attributes).toContain(".agents/comments/** merge=slopstash text eol=lf\n");
    expect(attributes).not.toContain("merge=union text eol=lf\n.agents/comments");
    expect(box.cli(main, "init", "--hooks", "claude-code,cursor", "--agents-md")).toBe("nothing to change\n");
    expect(box.cli(main, "init", "--one-shot")).toBe("git config: unset filter.slopstash.process\n");
    box.cli(main, "init");
  });

  it("promote --all turns every AI comment into an ordinary one", () => {
    box.cli(main, "collapse");
    box.git(main, "add", "-A");
    box.git(main, "commit", "-qm", "stash");
    expect(box.cli(main, "promote", "--all")).toMatch(/^promoted [0-9a-z]{4} in a\.py\n$/);
    expect(box.read(box.path("main", "a.py"))).toBe(`def settle(order):\n    # ${NOTE}\n    ledger.write(order.id)\n`);
    expect(existsSync(box.path("main", sidecar("a.py")))).toBe(false);
    expect(box.cli(main, "promote", "--all")).toBe("no AI comments to promote\n");
    box.git(main, "commit", "-qam", "promote");
  });

  it("uninstall undoes init and keeps everything else", () => {
    box.cli(main, "worktree", "add", box.path("agent"), "-b", "agent");
    const dry = box.cli(main, "uninstall", "--dry-run");
    expect(dry).toContain('  git config: remove [filter "slopstash"]\n');
    expect(dry).toContain('  git config: remove [merge "slopstash"]\n');
    expect(dry).toMatch(/ {2}git config --worktree \(.*agent\): remove \[filter "slopstash"\]\n/);
    expect(box.cli(main, "uninstall")).toContain(".cursor/hooks.json: delete (nothing else was in it)\n");
    expect(config()).not.toContain("slopstash");
    expect(box.gitResult(box.path("agent"), "config", "--worktree", "--list").stdout).not.toContain("slopstash");
    expect(box.read(box.path("main", ".gitattributes"))).toBe("*.png binary\n");
    expect(box.read(box.path("main", "AGENTS.md"))).toBe("# Rules\n");
    expect(JSON.parse(box.read(box.path("main", ".claude/settings.local.json")))).toEqual({ permissions: { allow: ["Bash(ls)"] } });
    expect(existsSync(box.path("main", ".git/hooks/pre-commit"))).toBe(false);
    expect(box.status(main)).toBe(" M .claude/settings.local.json\n D .cursor/hooks.json\n M .gitattributes\n M AGENTS.md\n");
    expect(box.cli(main, "uninstall")).toBe("nothing to change\n");
  });
});
