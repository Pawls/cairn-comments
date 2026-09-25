import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sandbox } from "./harness.js";

const SOURCE = "src/settle.py";
const SIDECAR = ".agents/comments/src/settle.py.md";
const SETTLE = "def settle(order):\n    ledger.write(order.id)\n    notify(order)\n";
const REFUND = "def refund(order):\n    ledger.reverse(order.id)\n";
const BASE = `import ledger\n\n\n${SETTLE}\n\n${REFUND}`;
const AGENT_EDIT = [
  "import ledger",
  "",
  "",
  "#~ settles one order; safe to retry",
  "def settle(order):",
  "    #~ retries are safe: ledger write is idempotent",
  "    #~ the ledger rejects a duplicate order id",
  "    ledger.write(order.id)  #~ keyed on order.id",
  "    notify(order)",
  "",
  "",
  REFUND,
].join("\n");

/** `text` as an agent worktree shows it once synced: every comment's first line carries an id. */
function withIds(text: string): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/#~ (?!the ledger rejects)/g, "#~[0-9a-z]{4} ")}$`);
}

const MODES = [true, false].flatMap((autocrlf) => [false, true].map((oneShot) => ({ autocrlf, oneShot })));
describe.each(MODES)("markerless round trip through git (autocrlf=$autocrlf, oneShot=$oneShot)", ({ autocrlf, oneShot }) => {
  const initArgs = ["init", "--markerless", ...(oneShot ? ["--one-shot"] : [])];
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
    box.cli(main, ...initArgs);
    box.git(main, "add", "-A");
    box.git(main, "commit", "-qm", "base");
  });
  afterAll(() => box.dispose());

  const workingEol = (cwd: string) => box.git(cwd, "ls-files", "--eol", SOURCE).split(/\s+/)[1];
  const blob = (cwd: string, rev: string) => box.git(cwd, "show", `${rev}:${SOURCE}`);

  it("init turns markerless mode on, installs the refresh hooks, and is idempotent", () => {
    expect(box.git(main, "config", "--get", "filter.cairn.markerless").trim()).toBe("true");
    for (const hook of ["pre-commit", "post-checkout", "post-merge", "post-commit", "post-rewrite"]) {
      expect(existsSync(box.path("main", ".git", "hooks", hook))).toBe(true);
    }
    expect(box.cli(main, ...initArgs).trim()).toBe("nothing to change");
    // A later plain `init` never turns markerless mode off.
    expect(box.cli(main, ...initArgs.filter((a) => a !== "--markerless")).trim()).toBe("nothing to change");
    expect(box.status(main)).toBe("");
  });

  it("comments an agent writes leave the code unchanged in git's eyes", () => {
    box.cli(main, "worktree", "add", "-q", wt1, "-b", "agent");
    box.write(box.path("wt1", SOURCE), AGENT_EDIT);
    expect(box.git(wt1, "diff", "--no-color", "--", SOURCE)).toBe("");
  });

  it("a comment-only commit carries the sidecar the post-edit sync wrote; the blob is the code without them", () => {
    // git decides a commit is empty before its pre-commit hook can stage anything, so the
    // sidecar must be staged already: the hook adapters' sync writes it after each edit.
    box.cli(wt1, "sync");
    box.git(wt1, "add", "-A");
    box.git(wt1, "commit", "-qm", "agent adds comments");
    expect(box.status(wt1)).toBe("");
    expect(blob(wt1, "HEAD")).toBe(BASE);
    expect(box.git(wt1, "show", "--name-only", "--format=", "HEAD").trim()).toBe(SIDECAR);
    const sidecar = box.git(wt1, "show", `HEAD:${SIDECAR}`);
    expect(sidecar).toContain("pos=before");
    expect(sidecar).toContain("scope=settle");
    expect(sidecar).toContain("pos=trail");
    expect(box.read(box.path("wt1", SOURCE))).toMatch(withIds(AGENT_EDIT));
  });

  it("merging into the owner checkout leaves the owner's code untouched", () => {
    box.git(main, "merge", "-q", "agent");
    expect(box.read(box.path("main", SOURCE))).toBe(BASE);
    expect(box.status(main)).toBe("");
  });

  it("a fresh smudged worktree places every comment, with the working tree's terminator", () => {
    box.cli(main, "worktree", "add", "-q", wt2, "-b", "agent2");
    expect(box.read(box.path("wt2", SOURCE))).toBe(box.read(box.path("wt1", SOURCE)));
    expect(workingEol(wt2)).toBe(autocrlf ? "w/crlf" : "w/lf");
    expect(box.status(wt2)).toBe("");
  });

  it("a body edit reaches the sidecar through sync and never dirties the source", () => {
    const file = box.path("wt2", SOURCE);
    box.write(file, box.read(file).replace("safe to retry", "safe to retry after a crash"));
    box.cli(wt2, "sync", SOURCE);
    expect(box.status(wt2)).toBe(` M ${SIDECAR}\n`);
    box.git(wt2, "commit", "-qam", "agent edits a body");
    expect(box.status(wt2)).toBe("");
    expect(blob(wt2, "HEAD")).toBe(BASE);
  });

  it("a branch switch shows the plain code and places the comments again on return", () => {
    box.git(wt2, "checkout", "-q", "--detach", "main~1");
    expect(box.read(box.path("wt2", SOURCE))).toBe(BASE);
    box.git(wt2, "checkout", "-q", "agent2");
    expect(box.read(box.path("wt2", SOURCE))).toContain("safe to retry after a crash");
    expect(box.status(wt2)).toBe("");
  });

  it("a cherry-pick of a comment-only commit places the comments through the refresh hook", () => {
    box.cli(main, "worktree", "add", "-q", wt3, "-b", "agent3", "main~1");
    expect(box.read(box.path("wt3", SOURCE))).toBe(BASE);
    box.git(wt3, "cherry-pick", "agent");
    expect(box.read(box.path("wt3", SOURCE))).toMatch(withIds(AGENT_EDIT));
    expect(box.status(wt3)).toBe("");
  });

  it("the owner's moves, reformatting, and edits elsewhere keep every comment in place", () => {
    const moved = `import ledger\n\n\n${REFUND.replace("reverse(order.id)", "reverse(order.id, reason)")}\n\n${SETTLE.replace("write(order.id)", "write( order.id )")}`;
    box.write(box.path("main", SOURCE), moved);
    box.git(main, "commit", "-qam", "owner moves settle, edits refund, reformats a call");
    box.git(wt2, "merge", "-q", "--no-edit", "main");
    const placed = box.read(box.path("wt2", SOURCE));
    expect(placed).toMatch(/#~[0-9a-z]{4} settles one order; safe to retry after a crash\ndef settle\(order\):\n {4}#~[0-9a-z]{4} retries are safe/);
    expect(placed).toMatch(/ledger\.write\( order\.id \) {2}#~[0-9a-z]{4} keyed on order\.id\n/);
    expect(placed.indexOf("def refund")).toBeLessThan(placed.indexOf("def settle"));
    expect(box.status(wt2)).toBe("");
  });

  it("an owner edit inside a function hides that function's comments without deleting them", () => {
    box.write(box.path("main", SOURCE), box.read(box.path("main", SOURCE)).replace("notify(order)", "notify(order, now)"));
    box.git(main, "commit", "-qam", "owner edits settle");
    box.git(wt2, "merge", "-q", "--no-edit", "main");
    const placed = box.read(box.path("wt2", SOURCE));
    expect(placed).toContain("settles one order");
    expect(placed).not.toContain("retries are safe");
    box.cli(wt2, "sync", SOURCE);
    expect(box.read(box.path("wt2", SIDECAR))).toContain("retries are safe");
    expect(box.status(wt2)).toBe("");
  });

  it("deleting a comment in an agent worktree deletes its entry", () => {
    const file = box.path("wt2", SOURCE);
    box.write(file, box.read(file).replace(/#~[0-9a-z]{4} settles one order[^\n]*\n/, ""));
    box.cli(wt2, "sync", SOURCE);
    expect(box.read(box.path("wt2", SIDECAR))).not.toContain("settles one order");
    expect(box.read(box.path("wt2", SIDECAR))).toContain("retries are safe");
  });

  it("expand and collapse rewrite the owner checkout out of band and end clean", () => {
    box.cli(main, "expand");
    expect(box.read(box.path("main", SOURCE))).toContain("settles one order");
    expect(box.status(main)).toBe("");
    box.cli(main, "collapse");
    expect(box.read(box.path("main", SOURCE))).not.toContain("#~");
    expect(box.status(main)).toBe("");
  });

  it("check reports a sigil comment that reached a blob and nothing else", () => {
    expect(box.cliResult(main, "check").stdout).toBe("");
    const leak = box.path("main", "src/leak.py");
    box.write(leak, "x = 1  #~ committed by a clone without the filter\n");
    box.git(main, "-c", "filter.cairn.clean=cat", "-c", "filter.cairn.process=", "add", "src/leak.py");
    const result = box.cliResult(main, "check", "--staged");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("src/leak.py:1: comment committed with its text");
    expect(readFileSync(box.path("main", SIDECAR), "utf8")).toContain("keyed on order.id");
  });
});
