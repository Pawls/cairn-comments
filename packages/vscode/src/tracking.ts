// Where markerless comments sit while the owner edits: no `vscode` import, so vitest covers
// it (test/tracking.test.ts). Rows are 0-based lines of the open document.
import type { CommentSite } from "@cairn-comments/core";

export interface Pos {
  line: number;
  character: number;
}

/** One entry of a document change event: `start`..`end` in the document before it, replaced by `text`. */
export interface Change {
  start: Pos;
  end: Pos;
  text: string;
}

const atOrBefore = (a: Pos, b: Pos) => a.line < b.line || (a.line === b.line && a.character <= b.character);

/**
 * The row a site moves to after `change`, or undefined when the code it sits against was
 * deleted. An own-line comment moves with the first character of its row, a trailing one
 * with the end of its row.
 */
function shiftRow(site: CommentSite, change: Change): number | undefined {
  const delta = change.text.split("\n").length - 1 - (change.end.line - change.start.line);
  const row = site.row;
  // A change from the start of the line into a later one replaces the whole line.
  if (change.start.line === row && change.start.character === 0 && change.end.line > row) return undefined;
  if (site.kind === "own") {
    const lineStart = { line: row, character: 0 };
    if (atOrBefore(change.end, lineStart)) return row + delta;
    if (atOrBefore(lineStart, change.start)) return row;
    return undefined;
  }
  if (change.end.line <= row) return row + delta;
  if (change.start.line >= row) return row;
  return undefined;
}

/**
 * Sites after one change event. VS Code reports every change against the document before
 * the event, so applying them bottom-up keeps each one's coordinates valid.
 */
export function shiftSites(sites: readonly CommentSite[], changes: readonly Change[]): CommentSite[] {
  const ordered = [...changes].sort((a, b) => b.start.line - a.start.line || b.start.character - a.start.character);
  let out = [...sites];
  for (const change of ordered) {
    out = out.flatMap((site) => {
      const row = shiftRow(site, change);
      return row === undefined ? [] : [{ ...site, row }];
    });
  }
  return out;
}

/** A line's leading whitespace and content length, as a copy sees it. */
export interface LineShape {
  indent: number;
  length: number;
}

/**
 * Sites a copy of `start`..`end` carries: an own-line comment when the copy includes the
 * first non-blank character of its line, a trailing one when it includes that whole line.
 */
export function copiedSites(sites: readonly CommentSite[], start: Pos, end: Pos, line: (row: number) => LineShape | undefined): CommentSite[] {
  return sites.filter((site) => {
    const shape = line(site.row);
    if (!shape) return false;
    const first = { line: site.row, character: shape.indent };
    if (!atOrBefore(start, first)) return false;
    if (site.kind === "own") return !atOrBefore(end, first);
    return atOrBefore({ line: site.row, character: shape.length }, end);
  });
}
