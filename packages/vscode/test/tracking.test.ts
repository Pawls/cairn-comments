import { describe, expect, it } from "vitest";
import type { CommentSite } from "@cairn-comments/core";
import { copiedSites, shiftSites, type Change, type LineShape } from "../src/tracking.js";

const own = (row: number): CommentSite => ({ id: `o${row}`, row, kind: "own" });
const trail = (row: number): CommentSite => ({ id: `t${row}`, row, kind: "trail" });
const at = (line: number, character: number) => ({ line, character });
const change = (start: [number, number], end: [number, number], text: string): Change => ({ start: at(...start), end: at(...end), text });
const rows = (sites: CommentSite[]) => sites.map((s) => [s.id, s.row]);

describe("shiftSites", () => {
  it("moves sites below a line inserted above them", () => {
    expect(rows(shiftSites([own(3), trail(3)], [change([1, 5], [1, 5], "\n    x = 1")]))).toEqual([
      ["o3", 4],
      ["t3", 4],
    ]);
  });

  it("moves an own-line comment with its line when a line is inserted at its start", () => {
    expect(rows(shiftSites([own(3)], [change([3, 0], [3, 0], "x = 1\r\n")]))).toEqual([["o3", 4]]);
  });

  it("leaves sites alone for an edit on or after their line", () => {
    expect(rows(shiftSites([own(3), trail(3)], [change([3, 4], [3, 9], "renamed"), change([5, 0], [7, 0], "")]))).toEqual([
      ["o3", 3],
      ["t3", 3],
    ]);
  });

  it("follows lines joined into the line above", () => {
    expect(rows(shiftSites([own(3), trail(3)], [change([2, 10], [3, 0], "")]))).toEqual([
      ["o3", 2],
      ["t3", 2],
    ]);
  });

  it("drops a site whose line was deleted with the code around it", () => {
    expect(rows(shiftSites([own(3), trail(3), own(6)], [change([2, 0], [4, 0], "")]))).toEqual([["o6", 4]]);
  });

  it("keeps a trailing comment when the next line joins its line", () => {
    expect(rows(shiftSites([trail(3)], [change([3, 12], [4, 4], " ")]))).toEqual([["t3", 3]]);
  });

  it("applies a multi-cursor event against the document before it", () => {
    const edits = [change([1, 0], [1, 0], "a\n"), change([5, 0], [5, 0], "b\n")];
    expect(rows(shiftSites([own(3), own(8)], edits))).toEqual([
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
