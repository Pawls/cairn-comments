import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sandbox } from "./harness.js";

const SOURCE = "src/settle.py";
const SIDECAR = ".agents/comments/src/settle.py.md";
const BASE = "def settle(order):\n    ledger.write(order.id)\n    notify(order)\n";
const NOTE = "retries are safe: ledger write is idempotent";
const NOTE_2 = "the ledger rejects a duplicate order id";
const TRAILING = "keyed on order.id";
const AGENT_EDIT = `def settle(order):\n    #~ ${NOTE}\n    #~ ${NOTE_2}\n    ledger.write(order.id)  #~ ${TRAILING}\n    notify(order)\n`;
const COLLAPSED = /^def settle\(order\):\n {4}#~[0-9a-z]{4}\n {4}ledger\.write\(order\.id\) {2}#~[0-9a-z]{4}\n {4}notify\(order\)\n$/;
const EXPANDED = new RegExp(
  `^def settle\\(order\\):\\n {4}#~[0-9a-z]{4} ${NOTE}\\n {4}#~ ${NOTE_2}\\n {4}ledger\\.write\\(order\\.id\\) {2}#~[0-9a-z]{4} ${TRAILING}\\n {4}notify\\(order\\)\\n$`,
);

// Both settings run on every platform: autocrlf=true puts CRLF in the working tree even
// on Linux, which is the Windows half of the plan's sign-off.
describe.each([{ autocrlf: true }, { autocrlf: false }])("round trip through git (autocrlf=$autocrlf)", ({ autocrlf }) => {
  let box: Sandbox;
  let main: string;
  let wt1: string;
  let wt2: string;
  let wt3: string;

  beforeAll(() => {
    box = new Sandbox({ autocrlf });
    main = box.path("main");
    wt1 = box.path("wt1");
    wt2 = box.path("wt2");
    wt3 = box.path("wt3");
    box.write(box.path("main", SOURCE), BASE);
    box.git(box.dir, "init", "-q", "main");
    box.cli(main, "init");
    box.git(main, "add", "-A");
    box.git(main, "commit", "-qm", "base");
  });
  afterAll(() => box.dispose());

  const workingEol = (cwd: string) => box.git(cwd, "ls-files", "--eol", SOURCE).split(/\s+/)[1];

  it("init is idempotent and leaves the owner checkout without a smudge filter", () => {
    const attributes = readFileSync(box.path("main", ".gitattributes"), "utf8");
    box.cli(main, "init");
    expect(readFileSync(box.path("main", ".gitattributes"), "utf8")).toBe(attributes);
    expect(attributes).toContain("*.py filter=tildenote");
    expect(attributes).toContain("*.ts filter=tildenote");
    expect(attributes).toContain("*.tsx filter=tildenote");
    expect(attributes).toContain("*.js filter=tildenote");
    expect(attributes).toContain("*.cs filter=tildenote");
    expect(attributes).toContain("*.java filter=tildenote");
    expect(attributes).toContain(".agents/comments/** merge=union text eol=lf");
    expect(() => box.git(main, "config", "--get", "filter.tildenote.smudge")).toThrow();
    expect(box.status(main)).toBe("");
  });

  it("an agent worktree diffs as bare markers only", () => {
    box.cli(main, "worktree", "add", "-q", wt1, "-b", "agent");
    expect(box.git(wt1, "config", "--worktree", "--get", "filter.tildenote.smudge")).toContain("smudge %f");
    box.write(box.path("wt1", SOURCE), AGENT_EDIT);
    const added = box
      .git(wt1, "diff", "--no-color")
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    expect(added).toHaveLength(2);
    expect(added[0]).toMatch(/^\+ {4}#~[0-9a-z]{4}$/);
    expect(added[1]).toMatch(/^\+ {4}ledger\.write\(order\.id\) {2}#~[0-9a-z]{4}$/);
  });

  it("commit -am carries the sidecar, keeps the blob collapsed, and leaves the worktree expanded and clean", () => {
    box.git(wt1, "commit", "-qam", "agent adds comments");
    expect(box.status(wt1)).toBe("");
    expect(box.git(wt1, "show", `HEAD:${SOURCE}`)).toMatch(COLLAPSED);
    expect(box.git(wt1, "show", `HEAD:${SIDECAR}`)).toMatch(
      new RegExp(`^## [0-9a-z]{4}\\n${NOTE}\\n${NOTE_2}\\n\\n## [0-9a-z]{4}\\n${TRAILING}\\n$`),
    );
    expect(box.git(wt1, "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort()).toEqual([SIDECAR, SOURCE]);
    expect(box.read(box.path("wt1", SOURCE))).toMatch(EXPANDED);
    expect(workingEol(wt1)).toBe(autocrlf ? "w/crlf" : "w/lf");
  });

  it("merging into the owner checkout stays collapsed", () => {
    box.git(main, "merge", "-q", "agent");
    expect(box.read(box.path("main", SOURCE))).toMatch(COLLAPSED);
    expect(box.status(main)).toBe("");
  });

  it("a fresh smudged worktree expands, with the working tree's terminator on every generated line", () => {
    box.cli(main, "worktree", "add", "-q", wt2, "-b", "agent2");
    expect(box.read(box.path("wt2", SOURCE))).toMatch(EXPANDED);
    expect(workingEol(wt2)).toBe(autocrlf ? "w/crlf" : "w/lf");
    expect(box.status(wt2)).toBe("");
  });

  it("a size-changing body edit reaches the sidecar through sync and never dirties the source", () => {
    const file = box.path("wt2", SOURCE);
    const edited = readFileSync(file, "utf8").replace(NOTE, `${NOTE}, so a crash mid-settle can simply rerun`);
    box.write(file, edited.replaceAll("\r\n", "\n"));
    box.cli(wt2, "sync", SOURCE);
    expect(box.status(wt2)).toBe(` M ${SIDECAR}\n`);
    expect(box.read(box.path("wt2", SIDECAR))).toContain("so a crash mid-settle can simply rerun");
    box.git(wt2, "commit", "-qam", "agent edits a body");
    expect(box.status(wt2)).toBe("");
  });

  it("a branch switch in a smudged worktree collapses nothing and re-expands on return", () => {
    box.git(wt2, "checkout", "-q", "--detach", "main~1");
    expect(box.read(box.path("wt2", SOURCE))).toBe(BASE);
    box.git(wt2, "checkout", "-q", "agent2");
    expect(box.read(box.path("wt2", SOURCE))).toContain("#~ " + NOTE_2);
    expect(box.read(box.path("wt2", SOURCE))).toContain("simply rerun");
    expect(box.status(wt2)).toBe("");
  });

  it("a cherry-pick into a smudged worktree expands and ends clean", () => {
    box.cli(main, "worktree", "add", "-q", wt3, "-b", "agent3", "main~1");
    expect(box.read(box.path("wt3", SOURCE))).toBe(BASE);
    box.git(wt3, "cherry-pick", "agent");
    expect(box.read(box.path("wt3", SOURCE))).toMatch(EXPANDED);
    expect(box.status(wt3)).toBe("");
  });

  it("expand and collapse rewrite the owner checkout out of band and end clean", () => {
    box.cli(main, "expand");
    expect(box.read(box.path("main", SOURCE))).toMatch(EXPANDED);
    expect(box.status(main)).toBe("");
    box.cli(main, "collapse");
    expect(box.read(box.path("main", SOURCE))).toMatch(COLLAPSED);
    expect(box.status(main)).toBe("");
  });

  it("collapse saves a comment that exists only inline before removing it", () => {
    const file = box.path("main", SOURCE);
    box.write(file, box.read(file).replace("    notify(order)\n", "    notify(order)  #~ fire and forget\n"));
    box.cli(main, "collapse", SOURCE);
    expect(box.read(file)).not.toContain("fire and forget");
    expect(box.read(box.path("main", SIDECAR))).toContain("fire and forget");
    box.git(main, "add", "-A");
    box.git(main, "commit", "-qm", "owner adds a note");
    expect(box.status(main)).toBe("");
    expect(existsSync(box.path("main", SIDECAR))).toBe(true);
  });
});
