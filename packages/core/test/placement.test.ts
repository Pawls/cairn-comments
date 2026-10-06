import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Language, Parser } from "web-tree-sitter";
import { LANGUAGES, findMarkers, languageForPath, placeComments, recordComments, stripComments, type Sidecar } from "../src/index.js";
import { resolveWasm } from "../src/languages.js";

const EMPTY: Sidecar = { preamble: "", entries: [] };

/** Records `working`, strips it, and places the comments back; returns every stage. */
async function roundTrip(path: string, working: string, sidecar: Sidecar = EMPTY) {
  const recorded = await recordComments(path, working, sidecar);
  const stripped = await stripComments(path, recorded.source);
  const placed = await placeComments(path, stripped, recorded.sidecar);
  return { recorded, stripped, placed };
}

async function expectExact(path: string, working: string): Promise<void> {
  const { recorded, stripped, placed } = await roundTrip(path, working);
  // A sigil inside a string literal or JSX text is not a comment, and stays.
  expect(await findMarkers(languageForPath(path)!, stripped)).toEqual([]);
  expect(placed.unplaced).toEqual([]);
  expect(placed.source).toBe(recorded.source);
}

const SETTLE = [
  "import ledger",
  "",
  "",
  "#~ settles one order; safe to retry",
  "def settle(order):",
  "    #~ retries are safe: ledger write is idempotent",
  "    #~ second line of the same note",
  "    ledger.write(order.id)  #~ keyed on order.id",
  '    log("#~ not a comment")',
  "    notify(order)",
  "    #~ nothing after notify on purpose",
  "",
  "",
  "class Ledger:",
  "    #~ one per process",
  "    instance = None",
  "",
  "    # a human comment stays in the code",
  "    #~ the AI note sits above the human one",
  "",
  "    @property",
  "    def size(self):",
  "        return 1  #~ fixed for now",
  "",
  "    @size.setter",
  "    def size(self, value):",
  "        #~ ignored on purpose",
  "        pass",
  "",
].join("\n");

describe("stripComments", () => {
  it("removes every sigil comment whole and nothing else", async () => {
    const stripped = await stripComments("a.py", SETTLE);
    expect(stripped).toBe(
      [
        "import ledger",
        "",
        "",
        "def settle(order):",
        "    ledger.write(order.id)",
        '    log("#~ not a comment")',
        "    notify(order)",
        "",
        "",
        "class Ledger:",
        "    instance = None",
        "",
        "    # a human comment stays in the code",
        "",
        "    @property",
        "    def size(self):",
        "        return 1",
        "",
        "    @size.setter",
        "    def size(self, value):",
        "        pass",
        "",
      ].join("\n"),
    );
  });

  it("is idempotent and keeps each remaining line's terminator", async () => {
    const mixed = "x = 1\r\n#~ note\ny = 2\n#~ last\r\nz = 3  #~ trailing\r\n";
    const once = await stripComments("a.py", mixed);
    expect(once).toBe("x = 1\r\ny = 2\nz = 3\r\n");
    expect(await stripComments("a.py", once)).toBe(once);
  });

  it("takes the terminator before a comment on an unterminated last line", async () => {
    expect(await stripComments("a.py", "x = 1\n#~ end")).toBe("x = 1");
  });

  it("keeps a blank line's terminator when the comment run after it ends an unterminated file", async () => {
    // Taking it would leave an empty unterminated last line, which is no line at all.
    expect(await stripComments("a.py", "x = 1\n#~ first\n\n#~ second")).toBe("x = 1\n\n");
    expect(await stripComments("a.py", "x = 1\r\n\r\n#~ end")).toBe("x = 1\r\n\r\n");
    expect(await stripComments("a.py", "x = 1\n    \n#~ end")).toBe("x = 1\n    ");
  });
});

describe("placeComments after recordComments", () => {
  it("restores a file exactly: blocks, trailing, class members, decorators, duplicate names", async () => {
    await expectExact("a.py", SETTLE);
  });

  it("restores CRLF files and an unterminated last line", async () => {
    await expectExact("a.py", SETTLE.replaceAll("\n", "\r\n"));
    await expectExact("a.py", "x = 1\n#~ end");
    await expectExact("a.py", "x = 1\r\n#~ end");
    await expectExact("a.py", "x = 1\r\n#~ first\r\n#~a1b2 second\r\n#~c3d4 third");
  });

  it("restores an unterminated last comment that follows a blank line", async () => {
    for (const eol of ["\n", "\r\n"]) {
      const file = (...lines: string[]) => lines.join(eol);
      await expectExact("a.py", file("x = 1", "#~ first", "", "#~ second"));
      await expectExact("a.py", file("x = 1", "", "#~ end"));
      await expectExact("a.py", file("x = 1", "", "", "#~ end"));
      await expectExact("a.py", file("x = 1", "", "#~ first", "#~ same block"));
      await expectExact("a.py", file("x = 1", "#~ a", "", "#~ b", "", "#~ c"));
      await expectExact("a.py", file("x = 1", "# human", "", "#~ end"));
      await expectExact("a.py", file("x = 1", "    ", "#~ end"));
      await expectExact("a.py", file("def f():", "    #~ a", "", "    #~ b"));
      await expectExact("a.py", file("", "#~ only"));
      await expectExact("a.py", file("#~ a", "", "#~ b"));
    }
  });

  it("keeps the order of blocks that land on one line", async () => {
    await expectExact("a.py", "def f():\n    #~ first\n    #~a1b2 second\n    x = 1\n");
    await expectExact("a.py", "def f():\n    if x:\n        a()\n        #~ inner\n    #~ outer\ndef g():\n    pass\n");
  });

  it("restores comments at the top of a file and in a file with no code", async () => {
    await expectExact("a.py", "#~ about this module\nimport os\n");
    await expectExact("a.py", "# license\n\n#~ only a note\n");
    await expectExact("a.py", "#~ only a note");
  });

  it("reports each comment's site in the stripped file", async () => {
    const working = "def f():\n    #~ first\n    #~ second line\n    #~a1b2 next block\n    x = 1  #~ trail\n    y = 2\n#~ end\n";
    const { recorded, stripped, placed } = await roundTrip("a.py", working);
    expect(stripped).toBe("def f():\n    x = 1\n    y = 2\n");
    const ids = recorded.sidecar.entries.map((e) => e.id);
    expect(placed.sites).toEqual([
      { id: ids[0], row: 1, kind: "own" },
      { id: "a1b2", row: 1, kind: "own" },
      { id: ids[2], row: 1, kind: "trail" },
      { id: ids[3], row: 3, kind: "own" },
    ]);
  });

  it("writes placement keys an owner can read", async () => {
    const { recorded } = await roundTrip("a.py", SETTLE);
    const meta = recorded.sidecar.entries.map((e) => Object.fromEntries(e.meta));
    expect(meta[0]).toMatchObject({ pos: "before" });
    expect(meta[0]!.scope).toBeUndefined();
    expect(meta[1]).toMatchObject({ pos: "before", scope: "settle" });
    expect(meta[1]!.body).toMatch(/^[0-9a-f]{8}$/);
    expect(meta.find((m) => m.gap === "2s")).toMatchObject({ pos: "trail", scope: "settle" });
    expect(meta.find((m) => m.scope === "Ledger.size@1")).toMatchObject({ pos: "before" });
    expect(meta.find((m) => m.pos === "after")).toMatchObject({ scope: "settle" });
  });
});

describe("placement across code changes", () => {
  async function recordAndChange(working: string, change: (stripped: string) => string) {
    const { recorded, stripped } = await roundTrip("a.py", working);
    return placeComments("a.py", change(stripped), recorded.sidecar);
  }

  const TWO = "def f():\n    #~ inside f\n    return 1\n\n\n#~ above g\ndef g():\n    #~ inside g\n    return 2\n";

  it("follows a function moved within the file", async () => {
    const f = "def f():\n    return 1\n";
    const g = "def g():\n    return 2\n";
    const placed = await recordAndChange(TWO, (s) => s.replace(f + "\n\n", "").replace(g, g + "\n\n" + f));
    expect(placed.unplaced).toEqual([]);
    expect(placed.source).toMatch(
      /^#~[0-9a-z]{4} above g\ndef g\(\):\n {4}#~[0-9a-z]{4} inside g\n {4}return 2\n\n\ndef f\(\):\n {4}#~[0-9a-z]{4} inside f\n {4}return 1\n$/,
    );
  });

  it("keeps comments of an unchanged function when a sibling changes, and orphans one on a changed statement", async () => {
    const placed = await recordAndChange(TWO, (s) => s.replace("return 1", "return 10"));
    expect(placed.source).toMatch(/\n#~[0-9a-z]{4} above g\n/);
    expect(placed.source).toMatch(/\n {4}#~[0-9a-z]{4} inside g\n/);
    expect(placed.source).toMatch(/^def f\(\):\n {4}return 10\n/);
    expect(placed.unplaced).toHaveLength(1);
    expect(placed.stale).toEqual([]);
  });

  it("ignores what a formatter changes", async () => {
    const working = "#~ why\nx = foo(a,b)\n\n\ndef f():\n    #~ quoted\n    return 'q'\n";
    const placed = await recordAndChange(working, (s) => s.replace("foo(a,b)", "foo( a, b )").replace("'q'", '"q"').replace("\n\n\n", "\n\n\n\n"));
    expect(placed.unplaced).toEqual([]);
    expect(placed.source).toMatch(/#~[0-9a-z]{4} why\nx = foo\( a, b \)/);
    expect(placed.source).toMatch(/#~[0-9a-z]{4} quoted\n {4}return "q"/);
  });

  // The Python pairs of normalization.test.ts, checked here against the placed text.
  const PYTHON_FORMATTER_PAIRS: [string, string][] = [
    ["x = foo(a,b)\n", "x   =   foo( a, b )\n"],
    ["x = foo(a, b)\n", "x = foo(\n    a,\n    b,\n)\n"],
    ["s = 'q'\n", 's = "q"\n'],
    ["s = U'q'\n", 's = "q"\n'],
    ["return a and b\n", "return (\n    a and b\n)\n"],
    ["if (x):\n    pass\n", "if x:\n    pass\n"],
    ["n = 0XAB + 1E5\n", "n = 0xab + 1e5\n"],
    ["x = 1\n", "x = 1  # inline note\n"],
  ];

  it.each(PYTHON_FORMATTER_PAIRS)("places a comment across a formatter's rewrite of %j", async (before, after) => {
    const { recorded } = await roundTrip("a.py", `#~ why\n${before}`);
    const placed = await placeComments("a.py", after, recorded.sidecar);
    expect(placed.unplaced).toEqual([]);
    expect(placed.source).toMatch(new RegExp(`^#~[0-9a-z]{4} why\\n${after.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  });

  it("places a comment inside a function across the blank lines a formatter adds", async () => {
    const { recorded } = await roundTrip("a.py", "def f():\n    #~ why\n    x = 1\n");
    const placed = await placeComments("a.py", "def f():\n\n\n    x = 1\n", recorded.sidecar);
    expect(placed.source).toMatch(/^def f\(\):\n\n\n {4}#~[0-9a-z]{4} why\n {4}x = 1\n$/);
  });

  it("puts a comment back above the right one of two identical statements", async () => {
    const working = "def f():\n    x()\n    #~ the second call\n    x()\n";
    const placed = await recordAndChange(working, (s) => s.replace("def f():\n", "def f():\n"));
    expect(placed.source).toMatch(/x\(\)\n {4}#~[0-9a-z]{4} the second call\n {4}x\(\)\n$/);
  });
});

describe("changed declarations", () => {
  const SETTLE_F = "def settle(order):\n    validate(order)\n    #~ the write is idempotent\n    ledger.write(order)  #~ keyed on order.id\n    notify(order)\n";

  async function change(working: string, edit: (stripped: string) => string) {
    const { recorded, stripped } = await roundTrip("a.py", working);
    const bodyOf = (id: string) => recorded.sidecar.entries.find((e) => e.id === id)!.body;
    const placed = await placeComments("a.py", edit(stripped), recorded.sidecar);
    return { recorded, placed, stale: placed.stale.map((s) => bodyOf(s.id)), unplaced: placed.unplaced.map(bodyOf) };
  }

  it("keeps a comment on its statement when other statements change, and marks it stale", async () => {
    const { placed, stale } = await change(SETTLE_F, (s) => s.replace("    validate(order)\n", "    validate(order)\n    audit(order)\n"));
    expect(placed.source).toMatch(/ {4}audit\(order\)\n {4}#~[0-9a-z]{4} \[stale\?\] the write is idempotent\n {4}ledger\.write\(order\) {2}#~[0-9a-z]{4} \[stale\?\] keyed on order\.id\n/);
    expect(stale).toEqual(["the write is idempotent", "keyed on order.id"]);
  });

  // Moving it to the start of the replacement was wrong in 34% and 38% of replayed moves (design.md § Anchoring).
  it("orphans a comment whose statement was replaced, and keeps the rest of the function's", async () => {
    const { placed, unplaced, stale } = await change(SETTLE_F, (s) => s.replace("ledger.write(order)", "ledger.put(order)"));
    expect(unplaced).toEqual(["the write is idempotent", "keyed on order.id"]);
    expect(stale).toEqual([]);
    expect(placed.source).not.toContain("#~");
  });

  it("follows a statement moved within its function (Alt+Down), marked stale", async () => {
    const { placed, unplaced, stale } = await change(SETTLE_F, (s) => s.replace("    ledger.write(order)\n    notify(order)\n", "    notify(order)\n    ledger.write(order)\n"));
    expect(unplaced).toEqual([]);
    expect(stale).toEqual(["the write is idempotent", "keyed on order.id"]);
    expect(placed.source).toMatch(/ {4}notify\(order\)\n {4}#~[0-9a-z]{4} \[stale\?\] the write is idempotent\n {4}ledger\.write\(order\) {2}#~[0-9a-z]{4} \[stale\?\] keyed on order\.id\n/);
  });

  it("does not follow a moved statement that appears twice in its function", async () => {
    const twice = "def settle(order):\n    #~ the write is idempotent\n    ledger.write(order)\n    notify(order)\n    ledger.write(order)\n";
    const { unplaced } = await change(twice, (s) => s.replace("    ledger.write(order)\n    notify(order)\n", "    notify(order)\n    ledger.write(order)\n"));
    expect(unplaced).toEqual(["the write is idempotent"]);
  });

  it("orphans a comment whose statement was deleted with nothing in its place", async () => {
    const { placed, unplaced } = await change(SETTLE_F, (s) => s.replace("    ledger.write(order)\n", ""));
    expect(unplaced).toEqual(["the write is idempotent", "keyed on order.id"]);
    expect(placed.source).not.toContain("#~");
  });

  it("follows a renamed function or class with an unchanged body, not stale", async () => {
    const working = "class Ledger:\n    def write(self):\n        #~ one row per call\n        return 1\n\n\n" + SETTLE_F;
    const { placed, stale, unplaced } = await change(working, (s) => s.replace("def settle", "def settle_order").replace("class Ledger", "class Journal"));
    expect(unplaced).toEqual([]);
    expect(stale).toEqual([]);
    expect(placed.source).toContain("def settle_order(order):\n    validate(order)\n    #~");
    expect(placed.source).toMatch(/class Journal:\n {4}def write\(self\):\n {8}#~[0-9a-z]{4} one row per call\n/);
  });

  it("follows a function renamed and edited when most of its statements survive", async () => {
    const renamed = await change(SETTLE_F, (s) => s.replace("def settle", "def settle_order").replace("notify(order)", "notify(order, now)"));
    expect(renamed.unplaced).toEqual([]);
    expect(renamed.stale).toEqual(["the write is idempotent", "keyed on order.id"]);
    const rewritten = await change(SETTLE_F, (s) => s.replace("def settle", "def settle_order").replace("validate(order)", "check(order)").replace("notify(order)", "notify(order, now)"));
    expect(rewritten.unplaced).toEqual(["the write is idempotent", "keyed on order.id"]);
  });

  it("re-records a stale comment only where the function was edited, or on confirm", async () => {
    const { recorded, stripped } = await roundTrip("a.py", SETTLE_F);
    const owners = stripped.replace("    validate(order)\n", "    validate(order)\n    audit(order)\n");
    const shown = (await placeComments("a.py", owners, recorded.sidecar)).source;

    const untouched = await recordComments("a.py", shown, recorded.sidecar, { baseline: owners });
    expect(untouched.sidecarChanged).toBe(false);
    expect(untouched.source).toBe(shown);

    const edited = shown.replace("    notify(order)\n", "    notify(order)\n    done(order)\n");
    const seen = await recordComments("a.py", edited, recorded.sidecar, { baseline: owners });
    expect(seen.sidecarChanged).toBe(true);
    expect(seen.source).not.toContain("[stale?]");
    expect((await placeComments("a.py", await stripComments("a.py", seen.source), seen.sidecar)).stale).toEqual([]);

    const [first] = recorded.sidecar.entries.map((e) => e.id);
    const confirmed = await recordComments("a.py", shown, recorded.sidecar, { baseline: owners, confirm: new Set([first!]) });
    const after = await placeComments("a.py", owners, confirmed.sidecar);
    expect(after.stale.map((s) => s.id)).not.toContain(first);
    expect(after.stale).toHaveLength(1);
  });

  it("keeps a comment above a declaration whose signature changed, marked stale", async () => {
    const python = await change("#~ settles one order\n@retry\ndef settle(order):\n    pass\n", (s) => s.replace("settle(order)", "settle(order, now)"));
    expect(python.placed.source).toMatch(/^#~[0-9a-z]{4} \[stale\?\] settles one order\n@retry\ndef settle\(order, now\):/);
    const { recorded, stripped } = await roundTrip("a.ts", "//~ settles one order\nexport const settle = (order: Order) => {\n  go(order);\n};\n");
    const ts = await placeComments("a.ts", stripped.replace("(order: Order)", "(order: Order, now: Date)"), recorded.sidecar);
    expect(ts.source).toMatch(/^\/\/~[0-9a-z]{4} \[stale\?\] settles one order\nexport const settle = \(order: Order, now: Date\)/);
    expect(recorded.sidecar.entries[0]!.meta.get("decl")).toBe("settle");
  });

  it("records statement hashes and the statement holding the anchor", async () => {
    const { recorded } = await roundTrip("a.py", SETTLE_F);
    expect(recorded.sidecar.entries[0]!.meta.get("stmts")).toMatch(/^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/);
    expect(recorded.sidecar.entries.map((e) => e.meta.get("in"))).toEqual(["1", "1"]);
  });
});

describe("recordComments", () => {
  it("stamps ids, writes bodies with provenance, and re-records a moved comment", async () => {
    const meta = new Map([["by", "test"]]);
    const first = await recordComments("a.py", "#~ note\nx = 1\ny = 2\n", EMPTY, { meta });
    expect(first.source).toMatch(/^#~[0-9a-z]{4} note\n/);
    expect(first.sidecar.entries[0]!.meta.get("by")).toBe("test");
    const id = first.sidecar.entries[0]!.id;
    const moved = await recordComments("a.py", `x = 1\n#~${id} note\ny = 2\n`, first.sidecar);
    expect(moved.sidecarChanged).toBe(true);
    expect(moved.sidecar.entries).toHaveLength(1);
    expect((await placeComments("a.py", "x = 1\ny = 2\n", moved.sidecar)).source).toBe(`x = 1\n#~${id} note\ny = 2\n`);
  });

  it("removes an entry whose comment was seen on disk and is gone, and keeps one never placed", async () => {
    const { recorded } = await roundTrip("a.py", "def f():\n    #~ one\n    return 1\n\n\ndef g():\n    #~ two\n    return 2\n");
    const [one, two] = recorded.sidecar.entries.map((e) => e.id);
    const withoutOne = recorded.source.replace(/ {4}#~[0-9a-z]{4} one\n/, "");
    const deleted = await recordComments("a.py", withoutOne, recorded.sidecar, { seen: new Set([one!, two!]) });
    expect(deleted.deleted).toEqual([one]);
    expect(deleted.sidecar.entries.map((e) => e.body)).toEqual(["two"]);

    // A cherry-pick brought `one` into the sidecar without placing it: not a deletion.
    const kept = await recordComments("a.py", withoutOne, recorded.sidecar, { seen: new Set([two!]) });
    expect(kept.deleted).toEqual([]);
    expect(kept.sidecar.entries.map((e) => e.body)).toEqual(["one", "two"]);
  });

  it("with knownOnly, ignores a comment whose id the sidecar lacks and still records new ones", async () => {
    const { recorded } = await roundTrip("a.py", "#~ known\nx = 1\n");
    const [known] = recorded.sidecar.entries.map((e) => e.id);
    const working = `#~${known} known\nx = 1\n#~zz99 from another commit\ny = 2\n#~ fresh\nz = 3\n`;
    const result = await recordComments("a.py", working, recorded.sidecar, { knownOnly: true });
    expect(result.sidecar.entries.map((e) => e.body)).toEqual(["known", "fresh"]);
    expect(result.ids).toEqual([known, result.sidecar.entries[1]!.id]);
    expect(result.source).toContain("#~zz99 from another commit\n");
  });
});

const TYPESCRIPT = [
  'import { ledger } from "./ledger";',
  "",
  "//~ settles one order; safe to retry",
  "export function settle(order: Order): void {",
  "  //~ retries are safe: the write is idempotent",
  "  ledger.write(order.id); //~ keyed on order.id",
  "  order.items.forEach((item) => {",
  "    //~ inside a callback, so it belongs to settle",
  "    notify(item);",
  "  });",
  "  //~ nothing after notify on purpose",
  "}",
  "",
  "export const refund = async (order: Order) => {",
  "  //~ reverse before notifying",
  "  await ledger.reverse(order.id);",
  "};",
  "",
  "export class Ledger {",
  "  //~ one per process",
  "  static instance?: Ledger;",
  "",
  "  write(id: string): void {",
  "    function check() {",
  "      //~ inside a nested function",
  "      return id.length > 0;",
  "    }",
  "    check();",
  "  }",
  "",
  "  handler = () => {",
  "    //~ a field bound to an arrow function",
  "    return 1;",
  "  };",
  "}",
  "",
  "namespace Tools {",
  "  //~ in a namespace",
  "  export const x = 1;",
  "}",
  "",
].join("\n");

const TSX = [
  "export function App({ items }: Props) {",
  "  //~ render note",
  "  return (",
  '    <ul className="list">',
  "      {items.map((item) => (",
  "        //~ keyed by id; index keys broke reordering",
  "        <li key={item.id}>{item.name}</li>",
  "      ))}",
  "      <li>",
  "        {/* a human JSX comment */}",
  "        tail //~ JSX text, not a comment",
  "      </li>",
  "    </ul>",
  "  );",
  "}",
  "",
].join("\n");

const JAVASCRIPT = [
  "const Ledger = class {",
  "  //~ a class expression bound to a name",
  "  run() {",
  "    return 1; //~ trailing in a method",
  "  }",
  "};",
  "",
  "module.exports.handle = function (req) {",
  "  //~ an assigned function expression",
  "  return Ledger;",
  "};",
  "",
  "function* ids() {",
  "  //~ a generator",
  "  yield 1;",
  "}",
  "",
].join("\n");

const CSHARP = [
  "using System;",
  "",
  "namespace Shop.Orders",
  "{",
  "    //~ one ledger per process",
  "    public class Ledger",
  "    {",
  "        //~ cached count",
  "        public int Size",
  "        {",
  "            get",
  "            {",
  "                //~ inside a getter",
  "                return count;",
  "            }",
  "        }",
  "",
  "        public int Double => count * 2; //~ an expression-bodied property",
  "",
  "        //~ an expression-bodied method",
  "        int Triple() => count * 3;",
  "",
  "        [Obsolete]",
  "        public void Write(string id)",
  "        {",
  "            bool Check()",
  "            {",
  "                //~ inside a local function",
  "                return id.Length > 0;",
  "            }",
  "            Check();",
  "        }",
  "    }",
  "}",
  "",
].join("\n");

const JAVA = [
  "package shop;",
  "",
  "//~ one ledger per process",
  "public class Ledger {",
  "    //~ cached count",
  "    private int count;",
  "",
  "    @Override",
  "    public String toString() {",
  "        Runnable r = () -> {",
  "            //~ inside a lambda, so it belongs to toString",
  "            log();",
  "        };",
  '        return "Ledger";',
  "    }",
  "",
  "    class Entry {",
  "        void touch() {",
  "            count++; //~ an inner class method",
  "        }",
  "    }",
  "}",
  "",
].join("\n");

const KOTLIN = [
  "package shop",
  "",
  "//~ one ledger per process",
  "class Ledger(private val store: Store) {",
  "    //~ cached count",
  "    private var count = 0",
  "",
  "    constructor() : this(Store()) {",
  "        //~ a secondary constructor has no name, so it belongs to Ledger",
  "        count = 1",
  "    }",
  "",
  "    override fun toString(): String {",
  "        val r = Runnable {",
  "            //~ inside a lambda, so it belongs to toString",
  "            log()",
  "        }",
  '        return "Ledger"',
  "    }",
  "",
  "    companion object {",
  "        fun make(): Ledger {",
  "            return Ledger() //~ an unnamed companion adds nothing to the path",
  "        }",
  "    }",
  "}",
  "",
  "object Registry {",
  "    fun find(id: Int): Ledger? {",
  "        return null //~ an object declaration names the path",
  "    }",
  "}",
  "",
].join("\n");

/** Each fixture, and the `scope` its comments record, in file order. */
const LANGUAGE_FIXTURES: [string, string, (string | undefined)[]][] = [
  ["a.ts", TYPESCRIPT, [undefined, "settle", "settle", "settle", "settle", "refund", "Ledger", "Ledger.write.check", "Ledger.handler", "Tools"]],
  ["a.tsx", TSX, ["App", "App"]],
  ["a.js", JAVASCRIPT, ["Ledger", "Ledger.run", "module.exports.handle", "ids"]],
  [
    "a.cs",
    CSHARP,
    ["Shop.Orders", "Shop.Orders.Ledger", "Shop.Orders.Ledger.Size", "Shop.Orders.Ledger", "Shop.Orders.Ledger", "Shop.Orders.Ledger.Write.Check"],
  ],
  ["a.java", JAVA, [undefined, "Ledger", "Ledger.toString", "Ledger.Entry.touch"]],
  ["a.kt", KOTLIN, [undefined, "Ledger", "Ledger", "Ledger.toString", "Ledger.make", "Registry.find"]],
];

describe("anchoring in every language", () => {
  it.each(LANGUAGE_FIXTURES)("restores %s exactly, LF and CRLF", async (path, working) => {
    await expectExact(path, working);
    await expectExact(path, working.replaceAll("\n", "\r\n"));
  });

  it.each(LANGUAGE_FIXTURES)("records the enclosing named declaration as scope in %s", async (path, working, scopes) => {
    const { recorded } = await roundTrip(path, working);
    expect(recorded.sidecar.entries.map((e) => e.meta.get("scope"))).toEqual(scopes);
  });

  it("keeps JSX text that looks like a comment in the stripped file", async () => {
    const { stripped } = await roundTrip("a.tsx", TSX);
    expect(stripped).toContain("tail //~ JSX text, not a comment");
    expect(stripped).not.toContain("keyed by id");
  });

  it("anchors the comments of a default-exported anonymous function at module level", async () => {
    const working = "export default function () {\n  //~ note\n  go();\n}\n";
    await expectExact("a.ts", working);
    const { recorded } = await roundTrip("a.ts", working);
    expect(recorded.sidecar.entries[0]!.meta.get("scope")).toBeUndefined();
  });

  it("anchors C# types to their names under a file-scoped namespace", async () => {
    const { recorded } = await roundTrip("a.cs", "namespace Shop;\n\npublic class A\n{\n    void M()\n    {\n        //~ note\n        Go();\n    }\n}\n");
    expect(recorded.sidecar.entries[0]!.meta.get("scope")).toBe("A.M");
  });

  // Each edit changes one statement of one declaration: comments on that statement (a callback
  // or lambda is part of the statement holding it) become orphans, the declaration's other
  // comments turn stale, and every other comment stays as it was.
  const EDITS: [string, string, string, string, string[], string[]][] = [
    ["a.ts", TYPESCRIPT, "return 1;", "return 2;", [], ["a field bound to an arrow function"]],
    [
      "a.ts",
      TYPESCRIPT,
      "notify(item);",
      "notify(item, 1);",
      ["retries are safe: the write is idempotent", "keyed on order.id"],
      ["inside a callback, so it belongs to settle", "nothing after notify on purpose"],
    ],
    ["a.js", JAVASCRIPT, "return Ledger;", "return null;", [], ["an assigned function expression"]],
    ["a.cs", CSHARP, "return count;", "return 0;", [], ["inside a getter"]],
    ["a.java", JAVA, "log();", "log(1);", [], ["inside a lambda, so it belongs to toString"]],
    ["a.kt", KOTLIN, "log()", "log(1)", [], ["inside a lambda, so it belongs to toString"]],
  ];

  it.each(EDITS)("in %s, changing `%s` affects only the comments inside that declaration", async (path, working, from, to, stale, orphaned) => {
    const { recorded, stripped } = await roundTrip(path, working);
    const placed = await placeComments(path, stripped.replace(from, to), recorded.sidecar);
    const bodyOf = (id: string) => recorded.sidecar.entries.find((e) => e.id === id)!.body;
    expect(placed.stale.map((s) => bodyOf(s.id))).toEqual(stale);
    expect(placed.unplaced.map(bodyOf)).toEqual(orphaned);
  });

  it("follows a function moved within a TypeScript file", async () => {
    const { recorded, stripped } = await roundTrip("a.ts", TYPESCRIPT);
    const refund = stripped.slice(stripped.indexOf("export const refund"), stripped.indexOf("export class"));
    const moved = stripped.replace(refund, "").replace("export function settle", refund + "export function settle");
    const placed = await placeComments("a.ts", moved, recorded.sidecar);
    expect(placed.unplaced).toEqual([]);
    expect(placed.source).toMatch(/export const refund = async \(order: Order\) => \{\n {2}\/\/~[0-9a-z]{4} reverse before notifying\n/);
  });

  // Formatter pairs as in normalization.test.ts; the C#, Java, and Kotlin ones sit inside a method, whose body hash
  // must survive them too.
  const FORMATTER_PAIRS: [string, string, string][] = [
    ["a.ts", "//~ why\nconst f = y => y\n", "const f = (y) => y;\n"],
    ["a.ts", "//~ why\nconst o = {a:1,b:[1,2,],}\n", "const o = { a: 1, b: [1, 2] };\n"],
    ["a.js", "//~ why\ncall('a', b)\n", 'call(\n  "a",\n  b,\n);\n'],
    ["a.tsx", "//~ why\nconst v = <div>{x}</div>\n", "const v = (\n  <div>{x}</div>\n);\n"],
    ["a.cs", "class C {\n  void M() {\n    //~ why\n    int x=1;\n  }\n}\n", "class C\n{\n  void M()\n  {\n    int x = 1;\n  }\n}\n"],
    ["a.java", "class C {\n  void m() {\n    //~ why\n    int x=foo(a,b);\n  }\n}\n", "class C {\n  void m() {\n    int x = foo(\n        a, b);\n  }\n}\n"],
    ["a.kt", "class C {\n  fun m() {\n    //~ why\n    val x=foo(a,b)\n  }\n}\n", "class C {\n    fun m() {\n        val x = foo(\n            a,\n            b,\n        )\n    }\n}\n"],
  ];

  it.each(FORMATTER_PAIRS)("places a comment across a formatter's rewrite (%s: %j)", async (path, before, after) => {
    const { recorded } = await roundTrip(path, before);
    const placed = await placeComments(path, after, recorded.sidecar);
    expect(placed.unplaced).toEqual([]);
    expect(placed.source).toMatch(/\/\/~[0-9a-z]{4} why\n/);
  });

  it("names only node types that exist in each grammar", async () => {
    await Parser.init();
    for (const spec of LANGUAGES) {
      const language = await Language.load(resolveWasm(spec));
      for (const type of [...spec.functionTypes, ...spec.namespaceTypes]) expect(language.idForNodeType(type, true), `${spec.id}: ${type}`).toBeTruthy();
    }
  });
});

describe("round trip property", () => {
  // Lines at two indents inside a function and at module level; comments share their neighbours' terminator.
  const statement = fc.constantFrom("x = 1", "call(a, b)", "return x", 'print("#~ string")', "pass");
  const comment = fc.constantFrom("#~ note", "#~ another note", "# human");
  const bodyLine = fc.oneof(
    { weight: 3, arbitrary: statement.map((s) => `    ${s}`) },
    { weight: 2, arbitrary: comment.map((c) => `    ${c}`) },
    { weight: 1, arbitrary: statement.map((s) => `    ${s}  #~ trailing`) },
    { weight: 1, arbitrary: fc.constant("") },
  );
  const fn = fc.tuple(fc.constantFrom("f", "g", "h"), fc.array(bodyLine, { minLength: 1, maxLength: 6 })).map(([name, lines]) => [`def ${name}():`, "    pass", ...lines]);
  const top = fc.oneof(fn, comment.map((c) => [c]), fc.constant([""]), statement.filter((s) => s !== "return x").map((s) => [s]));

  it("placeComments(stripComments(x)) restores x after recordComments", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(top, { minLength: 1, maxLength: 6 }), fc.constantFrom("\n", "\r\n"), fc.boolean(), async (blocks, eol, terminated) => {
        // A file of nothing but AI comments strips to empty, which cannot keep CRLF (design.md § Anchoring).
        const working = ["import os", ...blocks.flat()].join(eol) + (terminated ? eol : "");
        const { recorded, stripped, placed } = await roundTrip("p.py", working);
        expect(stripped).not.toMatch(/#~ (note|another|trailing)/);
        expect(placed.source).toBe(recorded.source);
      }),
      { numRuns: 300 },
    );
  });
});

describe("edge cases", () => {
  it("keeps the line break when a stale tag is all that is left of a comment", async () => {
    const { recorded, stripped } = await roundTrip("a.py", "def f():\n    #~ note\n    a()\n    b()\n");
    const placed = await placeComments("a.py", stripped.replace("b()\n", "b()\n    c()\n"), recorded.sidecar);
    const id = recorded.sidecar.entries[0]!.id;
    const edited = placed.source.replace(" note", "");
    expect(edited).toBe(`def f():\n    #~${id} [stale?]\n    a()\n    b()\n    c()\n`);
    const again = await recordComments("a.py", edited, recorded.sidecar);
    expect(again.source).toBe(`def f():\n    #~${id}\n    a()\n    b()\n    c()\n`);
  });

  it("places a trailing comment whose row lies past the end of the file", async () => {
    const { recorded, stripped } = await roundTrip("a.py", "x = 1\n#~ note\n");
    const [entry] = recorded.sidecar.entries;
    for (const [key, value] of Object.entries({ pos: "row", skip: "99", gap: "2s" })) entry!.meta.set(key, value);
    entry!.meta.delete("eof");
    const placed = await placeComments("a.py", stripped, recorded.sidecar);
    expect(placed.unplaced).toEqual([]);
    expect(placed.source).toContain(`#~${entry!.id} note`);
  });
});
