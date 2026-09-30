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
    id = /^## ([0-9a-z]{4})$/m.exec(box.read(box.path("main", sidecar("a.py"))))![1]!;
  });
  afterAll(() => box.dispose());

  const check = (cwd: string, ...args: string[]) => box.cliResult(cwd, "check", ...args);
  const commit = (cwd: string, message: string, ...args: string[]) => box.gitResult(cwd, "commit", "-qm", message, ...args);

  it("passes on a repository the filter kept consistent", () => {
    expect(box.read(box.path("main", "a.py"))).toBe("def settle(order):\n    ledger.write(order.id)\n");
    expect(check(main)).toMatchObject({ status: 0, stdout: "" });
  });

  it("the pre-commit hook moves the sidecar along with a renamed file", () => {
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

  it("without the hook, check names the sidecar whose source is gone and --fix moves it", () => {
    box.git(main, "mv", "b.py", "c.py");
    commit(main, "rename, hook skipped", "--no-verify");
    const found = check(main);
    expect(found.status).toBe(1);
    expect(found.stdout).toBe(`${sidecar("b.py")}: ${id} has no source; b.py is gone (\`cairn check --fix\` moves it to ${sidecar("c.py")})\n`);
    expect(JSON.parse(check(main, "--json").stdout).problems.map((p: { kind: string }) => p.kind)).toEqual(["missing-source"]);
    expect(check(main, "--fix")).toMatchObject({ status: 0, stdout: `relocated ${id}: ${sidecar("b.py")} -> ${sidecar("c.py")}\n` });
    expect(box.status(main)).toBe(`R  ${sidecar("b.py")} -> ${sidecar("c.py")}\n`);
    commit(main, "fix");
    expect(check(main)).toMatchObject({ status: 0, stdout: "" });
  });

  it("deleting a file drops its comments in the same commit, even beside a new file where they would place", () => {
    box.git(main, "rm", "-q", "c.py");
    // Not a rename in git's eyes: the shared function is a small part of the new file.
    const helpers = Array.from({ length: 30 }, (_, i) => `def helper_${i}(x):\n    return x + ${i}\n`).join("\n\n");
    box.write(box.path("main", "d.py"), `${helpers}\n\ndef settle(order):\n    ledger.write(order.id)\n    audit(order)\n`);
    box.git(main, "add", "d.py");
    const result = commit(main, "drop the file");
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`removed ${id} from ${sidecar("c.py")}: c.py is gone\n`);
    expect(result.stderr).not.toContain("relocated");
    expect(box.git(main, "ls-files", ".agents")).toBe("");
    expect(box.status(main)).toBe("");
  });

  it("CI in a clone without the filter catches sigil comments committed in the code", () => {
    const clone = box.path("clone");
    box.git(box.dir, "clone", "-q", "main", "clone");
    box.write(box.path("clone", "f.py"), "x = 1  #~ an agent wrote this\ny = 2  #~todo\n");
    box.git(clone, "add", "f.py");
    box.git(clone, "commit", "-qm", "no filter here");
    const result = check(clone);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(
      "f.py:1: comment committed with its text: an agent wrote this\n" +
        "f.py:2: sigil comment committed (todo)\n" +
        "hint: this clone commits without the filter; run `cairn init`, then `cairn collapse` and commit the result\n",
    );
  });
});

describe.each([true, false])("sidecar merge driver (autocrlf=%s)", (autocrlf) => {
  let box: Sandbox;
  let main: string;
  const file = () => box.path("main", sidecar("a.py"));
  const BASE = "## ab12\n<!-- pos=before scope=settle node=11111111 -->\nretries are safe\n";

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
      "## ab12\n<!-- pos=before scope=settle node=11111111 -->\n<<<<<<< ours\nretries are safe; the ledger dedupes\n=======\nretries are safe because writes are idempotent\n>>>>>>> theirs\n\n## cd34\n",
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
    // The CLI home install comes first: every line after it records the home's copy.
    expect(out).toMatch(/^dry run; would change:\n {2}\S.*: install \d+\.\d+\.\d+ \(build \d+\)\n {2}git config: set extensions\.worktreeConfig = true\n/);
    expect(out).toContain("  .gitattributes: add 16 line(s), remove 1 line(s)\n");
    expect(out).toContain("  .claude/settings.local.json: set the claude-code hook\n");
    expect(out).toContain("  .cursor/hooks.json: create with the cursor hook\n");
    expect(out).toContain("  AGENTS.md: add the sigil convention\n");
    expect(config()).toBe(before);
    expect(box.status(main)).toBe("");
  });

  it("init replaces the union line from earlier versions and reports only what changed", () => {
    box.cli(main, "init", "--hooks", "claude-code,cursor", "--agents-md");
    const attributes = box.read(box.path("main", ".gitattributes"));
    expect(attributes).toMatch(/^\*\.png binary\n\*\.py filter=cairn\n/);
    expect(attributes).toContain(".agents/comments/** merge=cairn text eol=lf\n");
    expect(attributes).not.toContain("merge=union text eol=lf\n.agents/comments");
    expect(box.cli(main, "init", "--hooks", "claude-code,cursor", "--agents-md")).toBe("nothing to change\n");
    expect(box.cli(main, "init", "--one-shot")).toBe("git config: unset filter.cairn.process\n");
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
    expect(dry).toContain('  git config: remove [filter "cairn"]\n');
    expect(dry).toContain('  git config: remove [merge "cairn"]\n');
    expect(dry).toMatch(/ {2}git config --worktree \(.*agent\): remove \[filter "cairn"\]\n/);
    expect(box.cli(main, "uninstall")).toContain(".cursor/hooks.json: delete (nothing else was in it)\n");
    expect(config()).not.toContain("cairn");
    expect(box.gitResult(box.path("agent"), "config", "--worktree", "--list").stdout).not.toContain("cairn");
    expect(box.read(box.path("main", ".gitattributes"))).toBe("*.png binary\n");
    expect(box.read(box.path("main", "AGENTS.md"))).toBe("# Rules\n");
    expect(JSON.parse(box.read(box.path("main", ".claude/settings.local.json")))).toEqual({ permissions: { allow: ["Bash(ls)"] } });
    expect(existsSync(box.path("main", ".git/hooks/pre-commit"))).toBe(false);
    expect(box.status(main)).toBe(" M .claude/settings.local.json\n D .cursor/hooks.json\n M .gitattributes\n M AGENTS.md\n");
    expect(box.cli(main, "uninstall")).toBe("nothing to change\n");
  });
});

describe("a rename in a smudged agent worktree", () => {
  let box: Sandbox;
  let agent: string;

  beforeAll(() => {
    box = new Sandbox({ autocrlf: false });
    const main = box.path("main");
    box.write(box.path("main", "a.py"), SOURCE);
    box.git(box.dir, "init", "-q", "main");
    box.cli(main, "init");
    box.git(main, "add", "-A");
    box.git(main, "commit", "-qm", "base");
    // An entry that no longer places anywhere: kept in the sidecar as an orphan.
    const file = box.path("main", sidecar("a.py"));
    box.write(file, box.read(file) + "\n## zzzz\n<!-- pos=before scope=gone nth=0 skip=0 node=deadbeef -->\nan orphan nobody placed\n");
    box.git(main, "add", "-A");
    box.git(main, "commit", "-qm", "orphan");
    agent = box.path("agent");
    box.cli(main, "worktree", "add", agent, "-b", "agent");
  });
  afterAll(() => box.dispose());

  it("carries every entry of the old sidecar, placed or not, to the new one", () => {
    expect(box.read(box.path("agent", "a.py"))).toContain(NOTE);
    box.git(agent, "mv", "a.py", "b.py");
    const result = box.gitResult(agent, "commit", "-qm", "rename");
    expect(result.status).toBe(0);
    const moved = box.git(agent, "show", `HEAD:${sidecar("b.py")}`);
    expect(moved).toContain(NOTE);
    expect(moved).toContain("an orphan nobody placed");
    expect(result.stderr).not.toContain("removed");
  });
});
