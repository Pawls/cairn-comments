import { describe, expect, it } from "vitest";
import { STALE_TAG, clean, confirm, findMarkers, languageForPath, parseSidecar, smudge, staleMarkers, sync, anchorsOf, bodiesOf, type Sidecar } from "../src/index.js";

/** Anchor of the first marker in `source`. */
async function anchor(path: string, source: string): Promise<string | null | undefined> {
  const [first] = await findMarkers(languageForPath(path)!, source, { anchors: true });
  return first!.anchor;
}

/** Each pair differs only in what a formatter (black, prettier, dotnet format) changes. */
const FORMATTER_ONLY: [string, string, string][] = [
  ["a.py", "#~ab12\nx = foo(a,b)\n", "#~ab12\nx   =   foo( a, b )\n"],
  ["a.py", "#~ab12\nx = foo(a, b)\n", "#~ab12\nx = foo(\n    a,\n    b,\n)\n"],
  ["a.py", "#~ab12\ns = 'q'\n", '#~ab12\ns = "q"\n'],
  ["a.py", "#~ab12\ns = U'q'\n", '#~ab12\ns = "q"\n'],
  ["a.py", "#~ab12\nreturn a and b\n", "#~ab12\nreturn (\n    a and b\n)\n"],
  ["a.py", "#~ab12\nif (x):\n    pass\n", "#~ab12\nif x:\n    pass\n"],
  ["a.py", "#~ab12\nn = 0XAB + 1E5\n", "#~ab12\nn = 0xab + 1e5\n"],
  ["a.py", "#~ab12\nx = 1\n", "#~ab12\nx = 1  # inline note\n"],
  ["a.py", "def f():\n    #~ab12\n    x = 1\n", "def f():\n\n    #~ab12\n\n    x = 1\n"],
  ["a.ts", "//~ab12\nconst f = y => y\n", "//~ab12\nconst f = (y) => y;\n"],
  ["a.ts", "//~ab12\nconst o = {a:1,b:[1,2,],}\n", "//~ab12\nconst o = { a: 1, b: [1, 2] };\n"],
  ["a.ts", "//~ab12\nconst n = .5 + 1.50\n", "//~ab12\nconst n = 0.5 + 1.5;\n"],
  ["a.js", "//~ab12\ncall('a', b)\n", '//~ab12\ncall(\n  "a",\n  b,\n);\n'],
  ["a.tsx", "//~ab12\nconst v = <div>{x}</div>\n", "//~ab12\nconst v = (\n  <div>{x}</div>\n);\n"],
  ["a.cs", "class C {\n  //~ab12\n  void M() { int x=1; }\n}\n", "class C\n{\n  //~ab12\n  void M()\n  {\n    int x = 1;\n  }\n}\n"],
  ["a.java", "class C {\n  //~ab12\n  int x=foo(a,b);\n}\n", "class C {\n  //~ab12\n  int x = foo(\n      a, b);\n}\n"],
];

/** Each pair is a real change to the anchored code. */
const REAL_CHANGES: [string, string, string][] = [
  ["a.py", "#~ab12\nx = foo(a, b)\n", "#~ab12\nx = foo(a, c)\n"],
  ["a.py", "#~ab12\ns = 'q'\n", "#~ab12\ns = 'r'\n"],
  ["a.py", "#~ab12\nx = (a + b) * c\n", "#~ab12\nx = a + b * c\n"],
  ["a.py", "#~ab12\nx = 1,\n", "#~ab12\nx = 1\n"],
  ["a.py", "#~ab12\ndef f(a):\n    pass\n", "#~ab12\ndef f(a, b):\n    pass\n"],
  ["a.py", "#~ab12\nfor x in y:\n    a()\n", "#~ab12\nfor x in y:\n    b()\n"],
  ["a.py", "#~ab12\n@cache\ndef f():\n    pass\n", "#~ab12\n@lru\ndef f():\n    pass\n"],
  ["a.ts", "//~ab12\nconst f = (y: number) => y;\n", "//~ab12\nconst f = (y: string) => y;\n"],
  ["a.ts", "//~ab12\nconst f = () => a();\n", "//~ab12\nconst f = () => b();\n"],
  ["a.cs", "class C {\n  //~ab12\n  int x = 1;\n}\n", "class C {\n  //~ab12\n  int x = 2;\n}\n"],
  ["a.java", "class C {\n  //~ab12\n  @A void m() {}\n}\n", "class C {\n  //~ab12\n  @B void m() {}\n}\n"],
];

describe("anchors", () => {
  it.each(FORMATTER_ONLY)("ignores a formatter-only change (%s: %j)", async (path, before, after) => {
    const a = await anchor(path, before);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(await anchor(path, after)).toBe(a);
  });

  it.each(REAL_CHANGES)("sees a real change (%s: %j)", async (path, before, after) => {
    expect(await anchor(path, after)).not.toBe(await anchor(path, before));
  });

  it("tracks a declaration's signature, not its body", async () => {
    const before = "#~ab12\nclass Ledger:\n    def write(self):\n        pass\n";
    const after = "#~ab12\nclass Ledger:\n    def write(self):\n        return 1\n";
    expect(await anchor("a.py", after)).toBe(await anchor("a.py", before));
    const ts = (body: string) => `//~ab12\nexport function k(a: number) {\n  ${body}\n}\n`;
    expect(await anchor("a.ts", ts("return a;"))).toBe(await anchor("a.ts", ts("return a + 1;")));
    const bound = (body: string) => `//~ab12\nexport const k = (a: number) => {\n  ${body}\n};\n`;
    expect(await anchor("a.ts", bound("return a;"))).toBe(await anchor("a.ts", bound("return a + 1;")));
    const assigned = (body: string) => `//~ab12\nexports.k = function (a) {\n  ${body}\n};\n`;
    expect(await anchor("a.js", assigned("return a;"))).toBe(await anchor("a.js", assigned("return a + 1;")));
    const property = (body: string) => `class C {\n  //~ab12\n  int P { get { ${body} } }\n}\n`;
    expect(await anchor("a.cs", property("return 1;"))).toBe(await anchor("a.cs", property("return 2;")));
  });

  it("counts a callback's body and an arrow function's expression body", async () => {
    const callback = (body: string) => `//~ab12\nitems.forEach((a) => {\n  ${body}\n});\n`;
    expect(await anchor("a.ts", callback("use(a);"))).not.toBe(await anchor("a.ts", callback("drop(a);")));
    expect(await anchor("a.ts", "//~ab12\nconst k = (a) => a;\n")).not.toBe(await anchor("a.ts", "//~ab12\nconst k = (a) => a + 1;\n"));
  });

  it("anchors a comment above a block's first statement to that statement", async () => {
    const f = (stmt: string) => `def f():\n    #~ab12\n    ${stmt}\n    y = 2\n`;
    expect(await anchor("a.py", f("x = 1"))).not.toBe(await anchor("a.py", f("x = 2")));
    expect(await anchor("a.py", "def f():\n    #~ab12\n    x = 1\n    y = 2\n")).toBe(await anchor("a.py", "def f():\n    #~ab12\n    x = 1\n    y = 3\n"));
  });

  it("has no anchor for the last comment of a block or the end of the file", async () => {
    expect(await anchor("a.py", "def f():\n    x = 1\n    #~ab12\ny = 2\n")).toBeNull();
    expect(await anchor("a.py", "x = 1\n#~ab12\n")).toBeNull();
    expect(await anchor("a.ts", "function f() {\n  x();\n  //~ab12\n}\n")).toBeNull();
  });

  it("anchors a trailing comment to the code before it on its line", async () => {
    const a = await anchor("a.py", "x = foo(1)  #~ab12\ny = 2\n");
    expect(await anchor("a.py", "x = foo( 1 )  #~ab12\ny = 3\n")).toBe(a);
    expect(await anchor("a.py", "x = foo(2)  #~ab12\ny = 2\n")).not.toBe(a);
    expect(await anchor("a.py", "f(a,\n  b)  #~ab12\n")).not.toBe(await anchor("a.py", "f(a,\n  c)  #~ab12\n"));
  });
});

/** Writes `body` for the expanded comment in `source` and returns the resulting sidecar. */
async function written(path: string, source: string): Promise<Sidecar> {
  return (await sync(path, source, { preamble: "", entries: [] })).sidecar;
}

describe("staleness", () => {
  const BEFORE = "def settle(order):\n    #~ab12 retries are safe\n    ledger.write(order.id)\n";
  const CODE_CHANGED = "def settle(order):\n    #~ab12 retries are safe\n    ledger.append(order.id)\n";

  it("records the anchor when a body is written, and keeps it while the body is unchanged", async () => {
    const sidecar = await written("a.py", BEFORE);
    expect(sidecar.entries[0]!.meta.get("anchor")).toMatch(/^[0-9a-f]{8}$/);
    const after = await sync("a.py", CODE_CHANGED, sidecar);
    expect(after.sidecarChanged).toBe(false);
    expect((await staleMarkers("a.py", CODE_CHANGED, sidecar)).map((s) => s.id)).toEqual(["ab12"]);
    expect(await staleMarkers("a.py", "def settle(order):\n    #~ab12\n    ledger.append(order.id)\n", sidecar)).toHaveLength(1);
  });

  it("is not stale after a whitespace-only change", async () => {
    const sidecar = await written("a.py", BEFORE);
    const reindented = "def settle(order):\n    #~ab12 retries are safe\n    ledger.write( order.id )   \n";
    expect(await staleMarkers("a.py", reindented, sidecar)).toEqual([]);
  });

  it("clears when the body is edited", async () => {
    const sidecar = await written("a.py", BEFORE);
    const edited = CODE_CHANGED.replace("retries are safe", "appends are safe");
    expect(await staleMarkers("a.py", edited, sidecar)).toEqual([]);
    const synced = await sync("a.py", edited, sidecar);
    expect(await staleMarkers("a.py", edited, synced.sidecar)).toEqual([]);
  });

  it("clears on confirm without touching the body", async () => {
    const sidecar = await written("a.py", BEFORE);
    const result = await confirm("a.py", CODE_CHANGED, sidecar, ["ab12", "zz99"]);
    expect(result.changed).toBe(true);
    expect(result.missing).toEqual(["zz99"]);
    expect(bodiesOf(result.sidecar)).toEqual(bodiesOf(sidecar));
    expect(await staleMarkers("a.py", CODE_CHANGED, result.sidecar)).toEqual([]);
    expect((await confirm("a.py", CODE_CHANGED, result.sidecar, ["ab12"])).changed).toBe(false);
  });

  it("smudge tags a stale body; sync and clean never keep the tag", async () => {
    const sidecar = await written("a.py", BEFORE);
    const collapsed = await clean("a.py", CODE_CHANGED);
    const smudged = await smudge("a.py", collapsed, bodiesOf(sidecar), anchorsOf(sidecar));
    expect(smudged).toBe(`def settle(order):\n    #~ab12 ${STALE_TAG} retries are safe\n    ledger.append(order.id)\n`);
    expect(await clean("a.py", smudged)).toBe(collapsed);
    const synced = await sync("a.py", smudged, sidecar);
    expect(synced.sidecarChanged).toBe(false);
    expect(synced.source).toBe(smudged);
    // Without anchors (an older sidecar) nothing is tagged.
    expect(await smudge("a.py", collapsed, bodiesOf(sidecar))).not.toContain(STALE_TAG);
  });

  it("smudge adds and removes the tag on an expanded comment in place", async () => {
    const sidecar = await written("a.py", BEFORE);
    const tagged = await smudge("a.py", CODE_CHANGED, bodiesOf(sidecar), anchorsOf(sidecar));
    expect(tagged).toContain(`#~ab12 ${STALE_TAG} retries are safe`);
    const confirmed = (await confirm("a.py", tagged, sidecar, ["ab12"])).sidecar;
    expect(await smudge("a.py", tagged, bodiesOf(confirmed), anchorsOf(confirmed))).toBe(CODE_CHANGED);
  });

  it("tags a trailing marker and keeps CRLF terminators", async () => {
    const before = "x = foo(1)  #~cd34 one\r\ny = 2\r\n";
    const sidecar = await written("a.py", before);
    const changed = await clean("a.py", "x = foo(2)  #~cd34 one\r\ny = 2\r\n");
    expect(await smudge("a.py", changed, bodiesOf(sidecar), anchorsOf(sidecar))).toBe(`x = foo(2)  #~cd34 ${STALE_TAG} one\r\ny = 2\r\n`);
  });

  it("does not read a new comment that starts with the tag as tagged", async () => {
    const [m] = await findMarkers(languageForPath("a.py")!, `#~ ${STALE_TAG} literally\nx = 1\n`);
    expect(m).toMatchObject({ kind: "new", staleTag: false, text: `${STALE_TAG} literally` });
  });

  it("an entry written before anchors existed gets its anchor on the next sync and is not stale", async () => {
    const legacy = parseSidecar("## ab12\nretries are safe\n");
    expect(await staleMarkers("a.py", CODE_CHANGED, legacy)).toEqual([]);
    const synced = await sync("a.py", await clean("a.py", CODE_CHANGED), legacy);
    expect(synced.sidecar.entries[0]!.meta.has("anchor")).toBe(true);
    expect(await staleMarkers("a.py", CODE_CHANGED, synced.sidecar)).toEqual([]);
  });
});
