import { describe, expect, it } from "vitest";
import { DETECTORS, analyzeSource, appendIgnore, convertComments, findMarkers, languageForPath, parseIgnore, scanSource } from "../src/index.js";

const unprotected = async (path: string, source: string) => (await analyzeSource(path, source)).filter((c) => !c.protected);
const convertAll = async (path: string, source: string) => convertComments(path, source, await unprotected(path, source));

describe("analyzeSource grouping", () => {
  it("groups consecutive own-line comments at one indent, split by indent, gaps, and pragmas", async () => {
    const source = "# one\n# two\n    # three\n\n# four\n# noqa: E501\n# five\nx = 1  # six\n";
    const groups = await analyzeSource("a.py", source);
    expect(groups.map((g) => [g.text, g.protected])).toEqual([
      ["one\ntwo", undefined],
      ["three", undefined],
      ["four", undefined],
      ["noqa: E501", "pragma"],
      ["five", undefined],
      ["six", undefined],
    ]);
    expect(groups.map((g) => [g.line, g.endLine, g.placement])).toEqual([
      [1, 2, "own-line"],
      [3, 3, "own-line"],
      [5, 5, "own-line"],
      [6, 6, "own-line"],
      [7, 7, "own-line"],
      [8, 8, "trailing"],
    ]);
  });

  it("skips sigil comments, sigils inside strings, and blank comment lines at a group's edges", async () => {
    const source = 's = "# Step 1: not a comment"\n#~ managed already\n#~ab12\n#\n# Step 1: load\n#\n';
    const groups = await analyzeSource("a.py", source);
    expect(groups.map((g) => g.text)).toEqual(["Step 1: load"]);
  });

  it("reports findings from enabled detectors only, unless asked for all", async () => {
    const source = "def f():\n    # Note that this is slow\n    pass\n";
    expect(await scanSource("a.py", source)).toEqual([]);
    const all = await scanSource("a.py", source, { detectors: DETECTORS });
    expect(all.map((c) => c.findings.map((f) => f.detector))).toEqual([["filler-opener"]]);
  });

  it("gives the same fingerprint to the same text regardless of position or spacing", async () => {
    const [a] = await analyzeSource("a.py", "# Step 1:  load\n");
    const [b] = await analyzeSource("a.py", "x = 1\n\n    # Step 1: load\n");
    expect(a!.fingerprint).toBe(b!.fingerprint);
    expect(a!.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("convertComments", () => {
  it("turns line comments into new sigil comments and touches nothing else", async () => {
    const source = "def f():\n    # Step 1: load\n    #\n    #   indented\n    x = 1  # NEW: counter\n";
    const out = await convertAll("a.py", source);
    expect(out).toBe("def f():\n    #~ Step 1: load\n    #~\n    #~   indented\n    x = 1  #~ NEW: counter\n");
    const markers = await findMarkers(languageForPath("a.py")!, out);
    expect(markers.map((m) => [m.kind, m.placement, m.text])).toEqual([
      ["new", "own-line", "Step 1: load\n\n  indented"],
      ["new", "trailing", "NEW: counter"],
    ]);
  });

  it("keeps every CRLF terminator", async () => {
    const source = "# Step 1: load\r\nx = 1\r\n# Step 2: save\r\n";
    expect(await convertAll("a.py", source)).toBe("#~ Step 1: load\r\nx = 1\r\n#~ Step 2: save\r\n");
  });

  it("rewrites an own-line block comment as sigil lines at its indent, and a trailing one as one line", async () => {
    const source = "function f() {\r\n  /*\r\n   * Step 1: fetch\r\n   *\r\n   * Step 2: filter\r\n   */\r\n  go(); /* Updated to\r\n   use go */\r\n}\r\n";
    const out = await convertAll("a.js", source);
    expect(out).toBe("function f() {\r\n  //~ Step 1: fetch\r\n  //~\r\n  //~ Step 2: filter\r\n  go(); //~ Updated to use go\r\n}\r\n");
    const markers = await findMarkers(languageForPath("a.js")!, out);
    expect(markers.map((m) => m.text)).toEqual(["Step 1: fetch\n\nStep 2: filter", "Updated to use go"]);
  });

  it("never converts a protected comment", async () => {
    const source = "/** doc */\nfunction f() {}\n// eslint-disable-next-line\ng(/* inline */ 1);\n";
    expect(await unprotected("a.js", source)).toEqual([]);
    const [doc] = await analyzeSource("a.js", source);
    expect(() => convertComments("a.js", source, [doc!])).toThrow(/protected comment \(doc\)/);
  });
});

describe("ignore file", () => {
  it("appends only unknown entries, one tab-separated line each, under a header", () => {
    const first = appendIgnore("", [{ file: "src/a.py", fingerprint: "0123abcd", preview: "Step 1:\tload\nmore" }]);
    expect(first).toMatch(/^# .*\nsrc\/a\.py\t0123abcd\tStep 1: load\n$/);
    const second = appendIgnore(first, [
      { file: "src/a.py", fingerprint: "0123abcd", preview: "again" },
      { file: "src/b.py", fingerprint: "ffff0000", preview: "x" },
    ]);
    expect(second).toBe(first + "src/b.py\tffff0000\tx\n");
    expect(parseIgnore(second)).toEqual(new Map([["src/a.py", new Set(["0123abcd"])], ["src/b.py", new Set(["ffff0000"])]]));
  });

  it("reads CRLF and union-merged duplicates", () => {
    const text = "# header\r\nsrc/a.py\t0123abcd\tx\r\nsrc/a.py\t0123abcd\tx\r\nnot a valid line\r\n";
    expect(parseIgnore(text)).toEqual(new Map([["src/a.py", new Set(["0123abcd"])]]));
  });
});
