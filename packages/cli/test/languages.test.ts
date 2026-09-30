import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sandbox } from "./harness.js";

/**
 * One round trip per supported language: init, an agent worktree adds a comment, the
 * commit's blob is the code without it, and a fresh smudged worktree places it back.
 */
const CASES: { name: string; file: string; base: string; note: string; edited: string; scope: string }[] = [
  {
    name: "TypeScript",
    file: "src/settle.ts",
    base: "function settle(order) {\n    ledger.write(order.id);\n}\n",
    note: "retries are safe",
    edited: "function settle(order) {\n    //~ retries are safe\n    ledger.write(order.id);\n}\n",
    scope: "settle",
  },
  {
    name: "C#",
    file: "src/Settle.cs",
    base: "void Settle(Order order) {\n    ledger.Write(order.Id);\n}\n",
    note: "retries are safe",
    edited: "void Settle(Order order) {\n    //~ retries are safe\n    ledger.Write(order.Id);\n}\n",
    scope: "Settle",
  },
  {
    name: "Java",
    file: "src/Settle.java",
    base: "void settle(Order order) {\n    ledger.write(order.id);\n}\n",
    note: "retries are safe",
    edited: "void settle(Order order) {\n    //~ retries are safe\n    ledger.write(order.id);\n}\n",
    scope: "settle",
  },
  {
    name: "Kotlin",
    file: "src/Settle.kt",
    base: "fun settle(order: Order) {\n    ledger.write(order.id)\n}\n",
    note: "retries are safe",
    edited: "fun settle(order: Order) {\n    //~ retries are safe\n    ledger.write(order.id)\n}\n",
    scope: "settle",
  },
  {
    name: "JavaScript",
    file: "src/settle.js",
    base: "const settle = (order) => {\n  ledger.write(order.id);\n};\n",
    note: "retries are safe",
    edited: "const settle = (order) => {\n  //~ retries are safe\n  ledger.write(order.id);\n};\n",
    scope: "settle",
  },
  {
    name: "TSX",
    file: "src/App.tsx",
    base: "export function App({ items }: Props) {\n  return (\n    <ul>\n      {items.map((item) => (\n        <li key={item.id} />\n      ))}\n    </ul>\n  );\n}\n",
    note: "keyed by id",
    edited:
      "export function App({ items }: Props) {\n  return (\n    <ul>\n      {items.map((item) => (\n        //~ keyed by id\n        <li key={item.id} />\n      ))}\n    </ul>\n  );\n}\n",
    scope: "App",
  },
];

describe.each(CASES)("round trip through git ($name)", ({ file, base, note, edited, scope }) => {
  const sidecar = `.agents/comments/${file}.md`;
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

  it("an agent's comment reaches the sidecar, scoped to its function, and the blob is the base code", () => {
    box.cli(main, "worktree", "add", "-q", wt1, "-b", "agent");
    box.write(box.path("wt1", file), edited);
    box.cli(wt1, "sync");
    box.git(wt1, "add", "-A");
    box.git(wt1, "commit", "-qm", "agent adds a comment");
    expect(box.status(wt1)).toBe("");
    expect(box.git(wt1, "show", `HEAD:${file}`)).toBe(base);
    expect(box.git(wt1, "show", `HEAD:${sidecar}`)).toContain(`scope=${scope} `);
  });

  it("the owner's checkout stays the base code, and a fresh worktree places the comment", () => {
    box.git(main, "merge", "-q", "agent");
    expect(box.read(box.path("main", file))).toBe(base);
    box.cli(main, "worktree", "add", "-q", wt2, "-b", "agent2");
    expect(box.read(box.path("wt2", file))).toBe(box.read(box.path("wt1", file)));
    expect(box.read(box.path("wt2", file))).toContain(note);
    expect(box.status(wt2)).toBe("");
  });
});
