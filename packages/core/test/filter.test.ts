import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bodiesOf, clean, parseSidecar, smudge, sync, type Sidecar } from "../src/index.js";

const EMPTY: Sidecar = { preamble: "", entries: [] };
const withEol = (lf: string, eol: string) => lf.replaceAll("\n", eol);
/** Alternates terminators so every other line ends differently. */
const mixed = (lf: string) => lf.split("\n").map((l, i, all) => (i === all.length - 1 ? l : l + (i % 2 ? "\n" : "\r\n"))).join("");

const EXPANDED = [
  "def settle(order):",
  "    #~ retries are safe: ledger write is idempotent",
  "    #~ second line of the same note",
  "    ledger.write(order.id)  #~ keyed on order.id",
  '    log("#~ not a comment")',
  "    notify(order)",
  "",
].join("\n");

describe("clean", () => {
  it("collapses every form to a bare marker and drops continuation lines", async () => {
    const out = await clean("src/settle.py", EXPANDED);
    expect(out).toMatch(
      /^def settle\(order\):\n {4}#~[0-9a-z]{4}\n {4}ledger\.write\(order\.id\) {2}#~[0-9a-z]{4}\n {4}log\("#~ not a comment"\)\n {4}notify\(order\)\n$/,
    );
  });

  it("assigns ids deterministically from path, text, and occurrence", async () => {
    const source = "#~ same\nx = 1\n#~ same\n";
    const a = await clean("a.py", source);
    expect(await clean("a.py", source)).toBe(a);
    expect(await clean("b.py", source)).not.toBe(a);
    const [first, second] = [...a.matchAll(/#~([0-9a-z]{4})/g)].map((m) => m[1]);
    expect(first).not.toBe(second);
  });

  it("keeps an existing id and re-identifies a pasted copy whose text was edited", async () => {
    const out = await clean("a.py", "#~a1b2 original\nx = 1\n#~a1b2 original\ny = 2\n#~a1b2 edited copy\n");
    const ids = [...out.matchAll(/#~([0-9a-z]{4})/g)].map((m) => m[1]);
    expect(ids.slice(0, 2)).toEqual(["a1b2", "a1b2"]);
    expect(ids[2]).not.toBe("a1b2");
  });

  it("passes through unsupported paths, marker-free sources, and empty input", async () => {
    expect(await clean("notes.txt", "#~ hello\n")).toBe("#~ hello\n");
    expect(await clean("a.py", "x = 1\r\n")).toBe("x = 1\r\n");
    expect(await clean("a.py", "")).toBe("");
  });
});

describe("smudge", () => {
  it("expands bare markers and leaves unknown ids bare", async () => {
    const bodies = new Map([
      ["a1b2", "first\n\nthird"],
      ["c3d4", "two\nlines"],
    ]);
    const out = await smudge("a.py", "if x:\n    #~a1b2\n    y = 1  #~c3d4\n    #~zzzz\n", bodies);
    expect(out).toBe("if x:\n    #~a1b2 first\n    #~\n    #~ third\n    y = 1  #~c3d4 two lines\n    #~zzzz\n");
  });

  it("expands a marker on an unterminated last line without adding a final terminator", async () => {
    const out = await smudge("a.py", "x = 1\r\n#~a1b2", new Map([["a1b2", "one\ntwo"]]));
    expect(out).toBe("x = 1\r\n#~a1b2 one\r\n#~ two");
    expect(await clean("a.py", out)).toBe("x = 1\r\n#~a1b2");
  });
});

describe("sync", () => {
  it("stamps ids, records bodies, and agrees with clean", async () => {
    const result = await sync("src/settle.py", EXPANDED, EMPTY);
    expect(result.sourceChanged).toBe(true);
    expect(result.sidecarChanged).toBe(true);
    expect(await clean("src/settle.py", result.source)).toBe(await clean("src/settle.py", EXPANDED));
    expect(result.sidecar.entries.map((e) => e.body)).toEqual([
      "retries are safe: ledger write is idempotent\nsecond line of the same note",
      "keyed on order.id",
    ]);
    const again = await sync("src/settle.py", result.source, result.sidecar);
    expect(again.sourceChanged || again.sidecarChanged).toBe(false);
  });

  it("updates an edited body in place and appends new entries after existing ones", async () => {
    const sidecar = parseSidecar("## a1b2\nold\n\n## c3d4\nkept\n");
    const result = await sync("a.py", "#~ brand new\nx = 1\n#~a1b2 edited\ny = 2  #~c3d4\n", sidecar);
    expect(result.sidecar.entries.map((e) => [e.id === "a1b2" || e.id === "c3d4" ? e.id : "new", e.body])).toEqual([
      ["a1b2", "edited"],
      ["c3d4", "kept"],
      ["new", "brand new"],
    ]);
  });

  it("does not flatten a multi-line body shown on a trailing marker", async () => {
    const sidecar = (await sync("a.py", "x = 1  #~c3d4\n", parseSidecar("## c3d4\nline one\nline two\n"))).sidecar;
    const source = await smudge("a.py", "x = 1  #~c3d4\n", bodiesOf(sidecar));
    expect((await sync("a.py", source, sidecar)).sidecarChanged).toBe(false);
  });

  it("leaves a collapsed file and its sidecar untouched once the entry has an anchor", async () => {
    const first = await sync("a.py", "#~a1b2\nx = 1\n", parseSidecar("## a1b2\nbody\n"));
    expect(first).toMatchObject({ sourceChanged: false, sidecarChanged: true });
    expect(first.sidecar.entries[0]!.meta.get("anchor")).toMatch(/^[0-9a-f]{8}$/);
    expect(await sync("a.py", "#~a1b2\nx = 1\n", first.sidecar)).toMatchObject({ sourceChanged: false, sidecarChanged: false });
  });
});

describe("line terminators", () => {
  const variants: [string, (lf: string) => string][] = [
    ["LF", (s) => s],
    ["CRLF", (s) => withEol(s, "\r\n")],
    ["mixed", mixed],
  ];

  for (const [name, convert] of variants) {
    it(`clean, smudge, and sync preserve every untouched terminator (${name})`, async () => {
      const source = convert(EXPANDED);
      const stamped = await sync("src/settle.py", source, EMPTY);
      const cleaned = await clean("src/settle.py", source);
      const smudged = await smudge("src/settle.py", cleaned, bodiesOf(stamped.sidecar));

      // Dropping the markers' own text must leave the original lines, terminators included.
      const strip = (s: string) => s.replace(/#~[^\r\n]*/g, "#~");
      const withoutContinuation = strip(source).replace(/ {4}#~\r?\n( {4}#~\r?\n)/, "$1");
      expect(strip(cleaned)).toBe(withoutContinuation);
      expect(strip(stamped.source)).toBe(strip(source));
      // Inside a block smudge repeats the marker line's terminator, so mixed input only matches modulo EOL.
      if (name === "mixed") expect(smudged.replaceAll("\r\n", "\n")).toBe(stamped.source.replaceAll("\r\n", "\n"));
      else expect(smudged).toBe(stamped.source);
      expect(await clean("src/settle.py", smudged)).toBe(cleaned);
    });
  }
});

describe("round trip per language", () => {
  const cases: [string, string, string][] = [
    [
      "TypeScript",
      "src/settle.ts",
      ["function settle(order) {", "    //~ retries are safe", "    ledger.write(order.id);  //~ keyed on order.id", '    log("//~ not a comment");', "}", ""].join("\n"),
    ],
    [
      "JavaScript",
      "src/settle.js",
      ["function settle(order) {", "    //~ retries are safe", "    ledger.write(order.id);  //~ keyed on order.id", "}", ""].join("\n"),
    ],
    [
      "C#",
      "src/Settle.cs",
      ["void Settle(Order order) {", "    //~ retries are safe", "    ledger.Write(order.Id);  //~ keyed on order.id", "}", ""].join("\n"),
    ],
    [
      "Java",
      "src/Settle.java",
      ["void settle(Order order) {", "    //~ retries are safe", "    ledger.write(order.id);  //~ keyed on order.id", "}", ""].join("\n"),
    ],
    [
      "Kotlin",
      "src/Settle.kt",
      ["fun settle(order: Order) {", "    //~ retries are safe", "    ledger.write(order.id)  //~ keyed on order.id", '    log("//~ not a comment")', "}", ""].join("\n"),
    ],
  ];

  for (const [name, path, expanded] of cases) {
    it(`${name}: clean collapses, smudge expands, sync agrees with clean`, async () => {
      const stamped = await sync(path, expanded, EMPTY);
      expect(stamped.sourceChanged).toBe(true);
      expect(stamped.sidecarChanged).toBe(true);
      const cleaned = await clean(path, stamped.source);
      expect(cleaned).toMatch(/\/\/~[0-9a-z]{4}/);
      const smudged = await smudge(path, cleaned, bodiesOf(stamped.sidecar));
      expect(await clean(path, smudged)).toBe(cleaned);
      const again = await sync(path, smudged, stamped.sidecar);
      expect(again.sourceChanged || again.sidecarChanged).toBe(false);
    });
  }
});

describe("properties", () => {
  const line = fc.oneof(
    fc.constantFrom("x = 1", "def f():", "    return x", "", 's = "#~ in a string"', "# plain comment", "y = [1,"),
    fc.tuple(fc.constantFrom("", "    ", "x = 1  ", "foo()  "), fc.constantFrom("", "a1b2", "c3d4", "zz99"), fc.constantFrom("", " note", " another note", "  padded ", " #~ nested")).map(
      ([prefix, id, text]) => `${prefix}#~${id}${text}`,
    ),
  );
  const source = fc
    .array(fc.tuple(line, fc.constantFrom("\n", "\r\n")), { maxLength: 12 })
    .chain((lines) => fc.boolean().map((final) => lines.map(([l, eol], i) => (i === lines.length - 1 && !final ? l : l + eol)).join("")));
  const bodies = fc.dictionary(fc.constantFrom("a1b2", "c3d4", "zz99"), fc.array(fc.constantFrom("one", "", "two words", "  lead"), { minLength: 1, maxLength: 4 }).map((l) => l.join("\n")));

  it("clean is idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(source, async (x) => {
        const once = await clean("p.py", x);
        expect(await clean("p.py", once)).toBe(once);
      }),
    );
  });

  it("clean undoes smudge", async () => {
    await fc.assert(
      fc.asyncProperty(source, bodies, async (x, b) => {
        const once = await clean("p.py", x);
        const stored = new Map(Object.entries(b));
        // Deterministic ids are outside the dictionary's keys, so give one of them a body too.
        for (const m of once.matchAll(/#~([0-9a-z]{4})/g)) if (!stored.has(m[1]!)) stored.set(m[1]!, "auto\nbody");
        expect(await clean("p.py", await smudge("p.py", once, stored))).toBe(once);
      }),
    );
  });

  it("sync never changes what clean produces", async () => {
    await fc.assert(
      fc.asyncProperty(source, async (x) => {
        const synced = await sync("p.py", x, EMPTY);
        expect(await clean("p.py", synced.source)).toBe(await clean("p.py", x));
      }),
    );
  });
});
