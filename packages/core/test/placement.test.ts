import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { placeComments, recordComments, stripComments, type Sidecar } from "../src/index.js";

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
  // A sigil comment starts a line or follows whitespace; the one inside a string literal stays.
  expect(stripped).not.toMatch(/(^|[ \t])#~/m);
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
});

describe("placeComments after recordComments", () => {
  it("restores a file exactly: blocks, trailing, class members, decorators, duplicate names", async () => {
    await expectExact("a.py", SETTLE);
  });

  it("restores CRLF files and an unterminated last line", async () => {
    await expectExact("a.py", SETTLE.replaceAll("\n", "\r\n"));
    await expectExact("a.py", "x = 1\n#~ end");
    await expectExact("a.py", "x = 1\r\n#~ end");
  });

  it("keeps the order of blocks that land on one line", async () => {
    await expectExact("a.py", "def f():\n    #~ first\n    #~a1b2 second\n    x = 1\n");
    await expectExact("a.py", "def f():\n    if x:\n        a()\n        #~ inner\n    #~ outer\ndef g():\n    pass\n");
  });

  it("restores comments at the top of a file and in a file with no code", async () => {
    await expectExact("a.py", "#~ about this module\nimport os\n");
    await expectExact("a.py", "# license\n\n#~ only a note\n");
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

  it("keeps comments of an unchanged function when a sibling changes, and drops those inside the changed one", async () => {
    const placed = await recordAndChange(TWO, (s) => s.replace("return 1", "return 10"));
    expect(placed.source).toContain("above g");
    expect(placed.source).toContain("inside g");
    expect(placed.source).not.toContain("inside f");
    expect(placed.unplaced).toHaveLength(1);
  });

  it("ignores what a formatter changes", async () => {
    const working = "#~ why\nx = foo(a,b)\n\n\ndef f():\n    #~ quoted\n    return 'q'\n";
    const placed = await recordAndChange(working, (s) => s.replace("foo(a,b)", "foo( a, b )").replace("'q'", '"q"').replace("\n\n\n", "\n\n\n\n"));
    expect(placed.unplaced).toEqual([]);
    expect(placed.source).toMatch(/#~[0-9a-z]{4} why\nx = foo\( a, b \)/);
    expect(placed.source).toMatch(/#~[0-9a-z]{4} quoted\n {4}return "q"/);
  });

  // The Python pairs of stale.test.ts's FORMATTER_ONLY (A7), with a comment in place of the bare marker.
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
      fc.asyncProperty(fc.array(top, { minLength: 1, maxLength: 6 }), fc.constantFrom("\n", "\r\n"), async (blocks, eol) => {
        // A file of nothing but AI comments strips to empty, which cannot keep CRLF (design.md § Anchoring).
        const working = ["import os", ...blocks.flat()].join(eol) + eol;
        const { recorded, stripped, placed } = await roundTrip("p.py", working);
        expect(stripped).not.toMatch(/#~ (note|another|trailing)/);
        expect(placed.source).toBe(recorded.source);
      }),
      { numRuns: 300 },
    );
  });
});
