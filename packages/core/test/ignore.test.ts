import { describe, expect, it } from "vitest";
import { appendIgnore, parseIgnore } from "../src/index.js";

describe("appendIgnore", () => {
  it("writes an entry repeated within one batch once", () => {
    const entry = { file: "src/a.py", fingerprint: "0123abcd", preview: "x" };
    const text = appendIgnore("", [entry, { ...entry, preview: "y" }]);
    expect(text.split("\n").filter((l) => l.startsWith("src/"))).toEqual(["src/a.py\t0123abcd\tx"]);
  });

  it("starts a new line after an existing file that lacks a final newline", () => {
    const text = appendIgnore("src/a.py\t0123abcd\tx", [{ file: "src/b.py", fingerprint: "ffff0000", preview: "y" }]);
    expect(text).toBe("src/a.py\t0123abcd\tx\nsrc/b.py\tffff0000\ty\n");
  });

  it("keeps the first line of a preview, collapses its whitespace, and cuts it at 72 characters", () => {
    const preview = `${"word  ".repeat(30)}\nsecond line`;
    const text = appendIgnore("", [{ file: "a.py", fingerprint: "00000000", preview }]);
    const written = text.split("\n").find((l) => l.startsWith("a.py"))!.split("\t")[2]!;
    expect(written).toBe("word ".repeat(30).trim().slice(0, 72));
    expect(written).toHaveLength(72);
  });

  it("round-trips through parseIgnore", () => {
    const text = appendIgnore("", [
      { file: "a.py", fingerprint: "00000000", preview: "p" },
      { file: "a.py", fingerprint: "11111111", preview: "q" },
    ]);
    expect(parseIgnore(text)).toEqual(new Map([["a.py", new Set(["00000000", "11111111"])]]));
  });
});
