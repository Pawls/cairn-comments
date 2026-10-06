import { describe, expect, it } from "vitest";
import { resolveIds } from "../src/index.js";
import { freshId } from "../src/ids.js";
import type { Marker } from "../src/markers.js";

function marker(id: string | undefined, text: string | undefined): Marker {
  return { kind: id ? "expanded" : "new", placement: "own-line", id, text, start: 0, end: 0, indent: "", staleTag: false };
}

describe("freshId", () => {
  it("returns a four-character id and adds it to the taken set", () => {
    const taken = new Set<string>();
    const id = freshId("a.py", "note", taken);
    expect(id).toMatch(/^[0-9a-z]{4}$/);
    expect(taken).toEqual(new Set([id]));
  });

  it("is deterministic in (path, text) and moves past an id already taken", () => {
    const first = freshId("a.py", "note", new Set());
    expect(freshId("a.py", "note", new Set())).toBe(first);
    const second = freshId("a.py", "note", new Set([first]));
    expect(second).not.toBe(first);
    expect(freshId("b.py", "note", new Set())).not.toBe(first);
  });
});

describe("resolveIds", () => {
  it("keeps the id a marker already has", () => {
    expect(resolveIds("a.py", [marker("ab12", "note"), marker("cd34", undefined)])).toEqual(["ab12", "cd34"]);
  });

  it("gives the same ids when the same markers are resolved twice", () => {
    const markers = [marker(undefined, "note"), marker(undefined, "other")];
    expect(resolveIds("a.py", markers)).toEqual(resolveIds("a.py", markers));
  });

  it("gives two new comments with the same text different ids", () => {
    const [first, second] = resolveIds("a.py", [marker(undefined, "same"), marker(undefined, "same")]);
    expect(first).not.toBe(second);
  });

  it("treats a bare marker's missing text as an empty body", () => {
    const [id] = resolveIds("a.py", [marker(undefined, undefined)]);
    expect(id).toBe(resolveIds("a.py", [marker(undefined, "")])[0]);
  });

  it("does not hand a new comment an id another marker in the file already holds", () => {
    const alone = resolveIds("a.py", [marker(undefined, "note")])[0]!;
    const [kept, fresh] = resolveIds("a.py", [marker(alone, "elsewhere"), marker(undefined, "note")]);
    expect(kept).toBe(alone);
    expect(fresh).not.toBe(alone);
  });

  it("keeps an id repeated with the same text, even when one copy is flattened onto a line", () => {
    expect(resolveIds("a.py", [marker("ab12", "one\ntwo"), marker("ab12", "one two")])).toEqual(["ab12", "ab12"]);
  });

  it("re-identifies a comment that reuses an earlier id with different text", () => {
    const [first, second] = resolveIds("a.py", [marker("ab12", "one"), marker("ab12", "edited")]);
    expect(first).toBe("ab12");
    expect(second).not.toBe("ab12");
    expect(second).toMatch(/^[0-9a-z]{4}$/);
  });
});
