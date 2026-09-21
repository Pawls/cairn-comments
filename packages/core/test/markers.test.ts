import { describe, expect, it } from "vitest";
import { findMarkers, languageForPath } from "../src/index.js";

const python = languageForPath("x.py")!;
const find = (source: string) => findMarkers(python, source);

describe("marker grammar (Python)", () => {
  it("parses a new own-line comment", async () => {
    const [m] = await find("x = 1\n    #~ retries are safe\ny = 2\n");
    expect(m).toMatchObject({ kind: "new", placement: "own-line", id: undefined, text: "retries are safe", indent: "    " });
  });

  it("parses an expanded trailing comment", async () => {
    const source = "ledger.write(order.id)  #~c3d4 keyed on order.id\n";
    const [m] = await find(source);
    expect(m).toMatchObject({ kind: "expanded", placement: "trailing", id: "c3d4", text: "keyed on order.id" });
    expect(source.slice(m!.start, m!.end)).toBe("#~c3d4 keyed on order.id");
  });

  it("parses bare markers, own-line and trailing", async () => {
    const markers = await find("#~a1b2\nx = 1  #~c3d4\n");
    expect(markers.map((m) => [m.kind, m.placement, m.id, m.text])).toEqual([
      ["bare", "own-line", "a1b2", undefined],
      ["bare", "trailing", "c3d4", undefined],
    ]);
  });

  it("joins consecutive own-line sigil lines into one block under the first line's id", async () => {
    const source = "def f():\n    #~a1b2 first\n    #~ second\n    #~\n    #~   indented third\n    return 1\n";
    const markers = await find(source);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ kind: "expanded", id: "a1b2", text: "first\nsecond\n\n  indented third" });
    expect(source.slice(markers[0]!.start, markers[0]!.end)).toBe(
      "#~a1b2 first\n    #~ second\n    #~\n    #~   indented third",
    );
  });

  it("ends a block at an id, an indent change, a gap, or a trailing comment", async () => {
    const markers = await find("#~ one\n#~c3d4 two\n    #~ three\n\n#~ four\nx = 1  #~ five\n#~ six\n");
    expect(markers.map((m) => m.text)).toEqual(["one", "two", "three", "four", "five", "six"]);
  });

  it("never lets a bare marker absorb the comment below it", async () => {
    const markers = await find("#~a1b2\n#~ a separate new comment\n");
    expect(markers.map((m) => [m.kind, m.text])).toEqual([
      ["bare", undefined],
      ["new", "a separate new comment"],
    ]);
  });

  it("ignores sigils inside strings", async () => {
    const source = [
      's = "#~ not a comment"',
      "t = '#~a1b2'",
      'u = """',
      "#~ still a string",
      '"""',
      'v = f"{x}  #~c3d4 nope"',
      "w = 1  #~ real",
      "",
    ].join("\n");
    const markers = await find(source);
    expect(markers.map((m) => m.text)).toEqual(["real"]);
  });

  it("ignores ordinary comments and malformed sigils", async () => {
    expect(await find("# ~ spaced\n#~\n#~abc short id\n#~abcde long id\n#~\ttabbed\n#! shebang\n")).toEqual([]);
  });

  it("excludes the CR of a CRLF terminator from the marker", async () => {
    const source = "x = 1  #~a1b2 body\r\n#~ next\r\n";
    const markers = await find(source);
    expect(markers.map((m) => [m.text, source.slice(m.end, m.end + 2)])).toEqual([
      ["body", "\r\n"],
      ["next", "\r\n"],
    ]);
  });

  it("reports string offsets for sources with astral and multi-byte characters", async () => {
    const source = 'name = "𝒳 é"  #~ naïve café 🙂\n';
    const [m] = await find(source);
    expect(source.slice(m!.start, m!.end)).toBe("#~ naïve café 🙂");
  });

  it("still finds markers in a file with syntax errors", async () => {
    const markers = await find("def broken(:\n    #~ note\n    return\n");
    expect(markers.map((m) => m.text)).toEqual(["note"]);
  });
});
