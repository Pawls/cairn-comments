import { describe, expect, it } from "vitest";
import type { CommentSite } from "@cairn-comments/core";
import { copiedSites, shiftSites, type Change, type LineShape } from "../src/tracking.js";

const own = (row: number): CommentSite => ({ id: `o${row}`, row, kind: "own" });
const trail = (row: number): CommentSite => ({ id: `t${row}`, row, kind: "trail" });
const at = (line: number, character: number) => ({ line, character });
const change = (start: [number, number], end: [number, number], text: string): Change => ({ start: at(...start), end: at(...end), text });
const rows = (sites: CommentSite[]) => sites.map((s) => [s.id, s.row]);

/** The document every change event is reported against. */
const DOC = [
  "def settle(order):",
  "    ledger.write(order.id)",
  "    notify(order)",
  "    return order",
  "",
  "",
  "def refund(order):",
  "    if order.closed:",
  "        return None",
  "    return order",
].join("\n");
/** The position after the last character of `row`. */
const END = (row: number): [number, number] => [row, DOC.split("\n")[row]!.length];

describe("shiftSites", () => {
  it("moves sites below a line inserted above them", () => {
    expect(rows(shiftSites([own(3), trail(3)], [change([1, 5], [1, 5], "\n    x = 1")], DOC))).toEqual([
      ["o3", 4],
      ["t3", 4],
    ]);
  });

  it("moves an own-line comment with its line when a line is inserted at its start", () => {
    expect(rows(shiftSites([own(3)], [change([3, 0], [3, 0], "x = 1\r\n")], DOC))).toEqual([["o3", 4]]);
  });

  it("leaves sites alone for an edit on or after their line", () => {
    expect(rows(shiftSites([own(3), trail(3)], [change([3, 4], [3, 9], "renamed"), change([5, 0], [7, 0], "")], DOC))).toEqual([
      ["o3", 3],
      ["t3", 3],
    ]);
  });

  it("follows lines joined into the line above", () => {
    expect(rows(shiftSites([own(3), trail(3)], [change([2, 10], [3, 0], "")], DOC))).toEqual([
      ["o3", 2],
      ["t3", 2],
    ]);
  });

  it("drops a site whose line was deleted with the code around it", () => {
    expect(rows(shiftSites([own(3), trail(3), own(6)], [change([2, 0], [4, 0], "")], DOC))).toEqual([["o6", 4]]);
  });

  it("drops a site whose line went with a replacement of the lines around it", () => {
    expect(rows(shiftSites([own(3), trail(3)], [change([2, 4], [5, 0], "x = 1\ny = 2\n")], DOC))).toEqual([]);
  });

  it("drops the sites of a line deleted whole, from its start through its break", () => {
    // Ctrl+X with no selection, or a highlighted line cut with its break.
    expect(rows(shiftSites([own(3), trail(3), own(4)], [change([3, 0], [4, 0], "")], DOC))).toEqual([["o4", 3]]);
  });

  it("drops the sites of a line whose code was cut from its first non-blank character", () => {
    // A highlight that leaves out the indentation, then Ctrl+X: only whitespace is left.
    expect(rows(shiftSites([own(3), trail(3)], [change([3, 4], END(3), "")], DOC))).toEqual([]);
  });

  it("drops the sites on the first and last lines of a block cut from its first non-blank character", () => {
    const sites = [own(1), trail(1), own(2), own(3), trail(3), own(7)];
    expect(rows(shiftSites(sites, [change([1, 4], END(3), "")], DOC))).toEqual([["o7", 5]]);
  });

  it("keeps the sites of a line that lost part of its code", () => {
    expect(rows(shiftSites([own(3), trail(3)], [change([3, 4], [3, 10], "")], DOC))).toEqual([
      ["o3", 3],
      ["t3", 3],
    ]);
  });

  it("keeps a trailing comment when the next line joins its line", () => {
    expect(rows(shiftSites([trail(3)], [change([3, 12], [4, 4], " ")], DOC))).toEqual([["t3", 3]]);
  });

  it("keeps a trailing comment on its line when a line is inserted after it", () => {
    expect(rows(shiftSites([trail(3)], [change(END(3), END(3), "\n    log(order)")], DOC))).toEqual([["t3", 3]]);
  });

  it("swaps the sites of two lines when Alt+Down moves the first below the second", () => {
    // VS Code deletes the line below (with the break before it) and inserts it above the moved line.
    const swap = [change([1, 26], [2, 17], ""), change([1, 0], [1, 0], "    notify(order)\n")];
    expect(rows(shiftSites([own(1), trail(1), own(2), trail(2)], swap, DOC))).toEqual([
      ["o1", 2],
      ["t1", 2],
      ["o2", 1],
      ["t2", 1],
    ]);
  });

  it("swaps the sites of two lines when Alt+Up moves the second above the first", () => {
    // VS Code deletes the line above (with its break) and inserts it after the moved line.
    const swap = [change([1, 0], [2, 0], ""), change([2, 17], [2, 17], "\n    ledger.write(order.id)")];
    expect(rows(shiftSites([own(1), trail(1), own(2), trail(2)], swap, DOC))).toEqual([
      ["o1", 2],
      ["t1", 2],
      ["o2", 1],
      ["t2", 1],
    ]);
  });

  it("follows a moved line that the move re-indented", () => {
    const swap = [change([1, 26], [2, 17], ""), change([1, 0], [1, 0], "        notify(order)\n")];
    expect(rows(shiftSites([own(2)], swap, DOC))).toEqual([["o2", 1]]);
  });

  it("drops a deleted line's sites when the event inserted its text more than once", () => {
    const twice = [change([2, 0], [3, 0], ""), change([4, 0], [4, 0], "    notify(order)\n    notify(order)\n")];
    expect(rows(shiftSites([own(2)], twice, DOC))).toEqual([]);
  });

  it("applies a multi-cursor event against the document before it", () => {
    const edits = [change([1, 0], [1, 0], "a\n"), change([5, 0], [5, 0], "b\n")];
    expect(rows(shiftSites([own(3), own(8)], edits, DOC))).toEqual([
      ["o3", 4],
      ["o8", 10],
    ]);
  });
});

describe("copiedSites", () => {
  const shapes: LineShape[] = [
    { indent: 0, length: 18 },
    { indent: 4, length: 26 },
    { indent: 4, length: 17 },
  ];
  const line = (row: number) => shapes[row];

  it("carries comments on whole copied lines", () => {
    const sites = [own(0), own(1), trail(1), own(2)];
    expect(copiedSites(sites, at(0, 0), at(3, 0), line)).toEqual(sites);
  });

  it("counts a line copied from its first non-blank character", () => {
    expect(copiedSites([own(1), trail(1)], at(1, 4), at(1, 26), line)).toEqual([own(1), trail(1)]);
  });

  it("leaves a trailing comment behind when its line is copied in part", () => {
    expect(copiedSites([own(1), trail(1)], at(1, 4), at(1, 10), line)).toEqual([own(1)]);
  });

  it("leaves comments outside the copy behind", () => {
    expect(copiedSites([own(0), own(1), own(2)], at(0, 5), at(2, 4), line)).toEqual([own(1)]);
  });
});
