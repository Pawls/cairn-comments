import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sandbox } from "./harness.js";

/**
 * One round trip per supported language: init, an agent worktree adds a marker,
 * commit collapses it in the blob, and a fresh smudged worktree expands it back.
 */
const CASES: { name: string; file: string; base: string; note: string; edited: string; collapsed: RegExp }[] = [
  {
    name: "TypeScript",
    file: "src/settle.ts",
    base: "function settle(order) {\n    ledger.write(order.id);\n}\n",
    note: "retries are safe",
    edited: "function settle(order) {\n    //~ retries are safe\n    ledger.write(order.id);\n}\n",
    collapsed: /^function settle\(order\) \{\n {4}\/\/~[0-9a-z]{4}\n {4}ledger\.write\(order\.id\);\n\}\n$/,
  },
  {
    name: "C#",
    file: "src/Settle.cs",
    base: "void Settle(Order order) {\n    ledger.Write(order.Id);\n}\n",
    note: "retries are safe",
    edited: "void Settle(Order order) {\n    //~ retries are safe\n    ledger.Write(order.Id);\n}\n",
    collapsed: /^void Settle\(Order order\) \{\n {4}\/\/~[0-9a-z]{4}\n {4}ledger\.Write\(order\.Id\);\n\}\n$/,
  },
  {
    name: "Java",
    file: "src/Settle.java",
    base: "void settle(Order order) {\n    ledger.write(order.id);\n}\n",
    note: "retries are safe",
    edited: "void settle(Order order) {\n    //~ retries are safe\n    ledger.write(order.id);\n}\n",
    collapsed: /^void settle\(Order order\) \{\n {4}\/\/~[0-9a-z]{4}\n {4}ledger\.write\(order\.id\);\n\}\n$/,
  },
];

describe.each(CASES)("round trip through git ($name)", ({ file, base, note, edited, collapsed }) => {
  let box: Sandbox;
  let main: string;
  let wt1: string;
  let wt2: string;

  beforeAll(() => {
    box = new Sandbox({ autocrlf: false });
    main = box.path("main");
    wt1 = box.path("wt1");
    wt2 = box.path("wt2");
    box.write(box.path("main", file), base);
    box.git(box.dir, "init", "-q", "main");
    box.cli(main, "init");
    box.git(main, "add", "-A");
    box.git(main, "commit", "-qm", "base");
  });
  afterAll(() => box.dispose());

  it("an agent worktree adds a marker, and the commit lands a collapsed blob", () => {
    box.cli(main, "worktree", "add", "-q", wt1, "-b", "agent");
    box.write(box.path("wt1", file), edited);
    box.git(wt1, "commit", "-qam", "agent adds a comment");
    expect(box.status(wt1)).toBe("");
    expect(box.git(wt1, "show", `HEAD:${file}`)).toMatch(collapsed);
    expect(box.git(main, "show", `HEAD:${file}`)).not.toMatch(collapsed);
  });

  it("a fresh worktree expands the blob back to the note", () => {
    box.git(main, "merge", "-qm", "merge", "agent");
    box.cli(main, "worktree", "add", "-q", wt2, "-b", "agent2");
    expect(box.read(box.path("wt2", file))).toContain(note);
  });
});
