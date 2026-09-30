import { describe, expect, it } from "vitest";
import { STALE_TAG, findMarkers, languageForPath, placeComments, recordComments, stripComments } from "../src/index.js";

/**
 * How a comment recorded above or beside the first code in `before` places once the code
 * reads `after`: on its node as recorded (`exact`), placed but flagged (`stale`), or not at
 * all (`lost`). Both sources hold the comment as `#~ note` (`//~ note`).
 */
async function survives(path: string, before: string, after: string): Promise<"exact" | "stale" | "lost"> {
  const recorded = await recordComments(path, before, { preamble: "", entries: [] });
  expect(recorded.sidecar.entries).toHaveLength(1);
  const placed = await placeComments(path, await stripComments(path, after), recorded.sidecar);
  if (!placed.placed.length) return "lost";
  return placed.stale.length ? "stale" : "exact";
}

/** Each pair differs only in what a formatter (black, prettier, dotnet format) changes. */
const FORMATTER_ONLY: [string, string, string][] = [
  ["a.py", "#~ note\nx = foo(a,b)\n", "#~ note\nx   =   foo( a, b )\n"],
  ["a.py", "#~ note\nx = foo(a, b)\n", "#~ note\nx = foo(\n    a,\n    b,\n)\n"],
  ["a.py", "#~ note\ns = 'q'\n", '#~ note\ns = "q"\n'],
  ["a.py", "#~ note\ns = U'q'\n", '#~ note\ns = "q"\n'],
  ["a.py", "#~ note\nreturn a and b\n", "#~ note\nreturn (\n    a and b\n)\n"],
  ["a.py", "#~ note\nif (x):\n    pass\n", "#~ note\nif x:\n    pass\n"],
  ["a.py", "#~ note\nn = 0XAB + 1E5\n", "#~ note\nn = 0xab + 1e5\n"],
  ["a.py", "#~ note\nx = 1\n", "#~ note\nx = 1  # inline note\n"],
  ["a.py", "def f():\n    #~ note\n    x = 1\n", "def f():\n\n    #~ note\n\n    x = 1\n"],
  ["a.ts", "//~ note\nconst f = y => y\n", "//~ note\nconst f = (y) => y;\n"],
  ["a.ts", "//~ note\nconst o = {a:1,b:[1,2,],}\n", "//~ note\nconst o = { a: 1, b: [1, 2] };\n"],
  ["a.ts", "//~ note\nconst n = .5 + 1.50\n", "//~ note\nconst n = 0.5 + 1.5;\n"],
  ["a.js", "//~ note\ncall('a', b)\n", '//~ note\ncall(\n  "a",\n  b,\n);\n'],
  ["a.tsx", "//~ note\nconst v = <div>{x}</div>\n", "//~ note\nconst v = (\n  <div>{x}</div>\n);\n"],
  ["a.cs", "class C {\n  //~ note\n  void M() { int x=1; }\n}\n", "class C\n{\n  //~ note\n  void M()\n  {\n    int x = 1;\n  }\n}\n"],
  ["a.java", "class C {\n  //~ note\n  int x=foo(a,b);\n}\n", "class C {\n  //~ note\n  int x = foo(\n      a, b);\n}\n"],
  ["a.kt", "class C {\n  //~ note\n  val x=foo(a,b)\n}\n", "class C {\n    //~ note\n    val x = foo(\n        a,\n        b,\n    )\n}\n"],
];

/** Each pair is a real change to the code the comment describes. */
const REAL_CHANGES: [string, string, string][] = [
  ["a.py", "#~ note\nx = foo(a, b)\n", "#~ note\nx = foo(a, c)\n"],
  ["a.py", "#~ note\ns = 'q'\n", "#~ note\ns = 'r'\n"],
  ["a.py", "#~ note\nx = (a + b) * c\n", "#~ note\nx = a + b * c\n"],
  ["a.py", "#~ note\nx = 1,\n", "#~ note\nx = 1\n"],
  ["a.py", "#~ note\ndef f(a):\n    pass\n", "#~ note\ndef f(a, b):\n    pass\n"],
  ["a.py", "#~ note\nfor x in y:\n    a()\n", "#~ note\nfor x in y:\n    b()\n"],
  ["a.py", "#~ note\n@cache\ndef f():\n    pass\n", "#~ note\n@lru\ndef f():\n    pass\n"],
  ["a.ts", "//~ note\nconst f = (y: number) => y;\n", "//~ note\nconst f = (y: string) => y;\n"],
  ["a.ts", "//~ note\nconst f = () => a();\n", "//~ note\nconst f = () => b();\n"],
  ["a.cs", "class C {\n  //~ note\n  int x = 1;\n}\n", "class C {\n  //~ note\n  int x = 2;\n}\n"],
  ["a.java", "class C {\n  //~ note\n  @A void m() {}\n}\n", "class C {\n  //~ note\n  @B void m() {}\n}\n"],
  ["a.kt", "//~ note\nfun f(a: Int) = a + 1\n", "//~ note\nfun f(a: Int) = a + 2\n"],
  ["a.kt", "//~ note\nfun f(a: Int) {}\n", "//~ note\nfun f(a: Long) {}\n"],
];

describe("what counts as a change to the code a comment describes", () => {
  it.each(FORMATTER_ONLY)("ignores a formatter-only change (%s: %j)", async (path, before, after) => {
    expect(await survives(path, before, after)).toBe("exact");
  });

  it.each(REAL_CHANGES)("sees a real change (%s: %j)", async (path, before, after) => {
    expect(await survives(path, before, after)).not.toBe("exact");
  });

  it("tracks a declaration's signature, not its body", async () => {
    const same = async (path: string, shape: (body: string) => string, before: string, after: string) =>
      expect(await survives(path, shape(before), shape(after))).toBe("exact");
    await same("a.py", (b) => `#~ note\nclass Ledger:\n    def write(self):\n        ${b}\n`, "pass", "return 1");
    await same("a.ts", (b) => `//~ note\nexport function k(a: number) {\n  ${b}\n}\n`, "return a;", "return a + 1;");
    await same("a.ts", (b) => `//~ note\nexport const k = (a: number) => {\n  ${b}\n};\n`, "return a;", "return a + 1;");
    await same("a.js", (b) => `//~ note\nexports.k = function (a) {\n  ${b}\n};\n`, "return a;", "return a + 1;");
    await same("a.cs", (b) => `class C {\n  //~ note\n  int P { get { ${b} } }\n}\n`, "return 1;", "return 2;");
    // Kotlin's bodies are unfielded children: `function_body`, `class_body`, a constructor's `block`.
    await same("a.kt", (b) => `//~ note\nfun k(a: Int): Int {\n    ${b}\n}\n`, "return a", "return a + 1");
    await same("a.kt", (b) => `//~ note\nclass K(val a: Int) {\n    ${b}\n}\n`, "fun f() = a", "fun g() = a");
    await same("a.kt", (b) => `//~ note\nobject K {\n    ${b}\n}\n`, "val a = 1", "val a = 2");
  });

  it("counts a callback's body and an arrow function's expression body", async () => {
    const callback = (body: string) => `//~ note\nitems.forEach((a) => {\n  ${body}\n});\n`;
    expect(await survives("a.ts", callback("use(a);"), callback("drop(a);"))).not.toBe("exact");
    expect(await survives("a.ts", "//~ note\nconst k = (a) => a;\n", "//~ note\nconst k = (a) => a + 1;\n")).not.toBe("exact");
  });

  it("keeps a trailing comment on the code before it on its line", async () => {
    expect(await survives("a.py", "x = foo(1)  #~ note\ny = 2\n", "x = foo( 1 )  #~ note\ny = 3\n")).toBe("exact");
    expect(await survives("a.py", "x = foo(1)  #~ note\ny = 2\n", "x = foo(2)  #~ note\ny = 2\n")).not.toBe("exact");
    expect(await survives("a.py", "f(a,\n  b)  #~ note\n", "f(a,\n  c)  #~ note\n")).not.toBe("exact");
  });
});

describe("the stale tag", () => {
  it("is not read as a tag on a new comment that starts with it", async () => {
    const [m] = await findMarkers(languageForPath("a.py")!, `#~ ${STALE_TAG} literally\nx = 1\n`);
    expect(m).toMatchObject({ kind: "new", staleTag: false, text: `${STALE_TAG} literally` });
  });
});
