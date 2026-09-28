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

/** Where a line's code starts and ends: after its indentation, before any trailing whitespace. */
export interface LineShape {
  indent: number;
  length: number;
}

export function shapeOf(line: string): LineShape {
  const content = line.trimEnd();
  return { indent: content.length - content.trimStart().length, length: content.length };
}

/**
 * The row a site moves to after `change`, or undefined when the code it sits against was
 * deleted. An own-line comment moves with the first character of its row, a trailing one
 * with the end of its row's code. `shape` describes the row before the change.
 */
function shiftRow(site: CommentSite, change: Change, shape: LineShape): number | undefined {
  const delta = change.text.split("\n").length - 1 - (change.end.line - change.start.line);
  const row = site.row;
  const lineStart = { line: row, character: 0 };
  const codeStart = { line: row, character: shape.indent };
  const codeEnd = { line: row, character: shape.length };
  // A change from the start of the line into a later one replaces the whole line.
  if (change.start.line === row && change.start.character === 0 && change.end.line > row) return undefined;
  // One that covers the line's code and leaves only whitespace deletes it, as a cut of a
  // highlight that left out the indentation does.
  const hasCode = shape.indent < shape.length;
  const coversCode = hasCode && atOrBefore(change.start, codeStart) && atOrBefore(codeEnd, change.end);
  if (coversCode && !change.text.trim()) return undefined;
  if (site.kind === "own") {
    if (atOrBefore(change.end, lineStart)) return row + delta;
    if (atOrBefore(lineStart, change.start)) return row;
    return undefined;
  }
  // Text added or removed after the code, such as a line inserted at its end, leaves it in place.
  if (atOrBefore(codeEnd, change.start)) return row;
  if (change.end.line <= row) return row + delta;
  if (change.start.line >= row) return row;
  return undefined;
}

/** A whole line the event inserted, at its row in the document after the event. */
interface InsertedLine {
  row: number;
  text: string;
}

/**
 * The lines the event inserted whole, with nothing but whitespace around them on their
 * rows. A change's text starts on `start`'s line and ends on `end`'s, so its first and
 * last lines share a row with what stood there.
 */
function insertedLines(changes: readonly Change[], before: readonly string[]): InsertedLine[] {
  const ordered = [...changes].sort((a, b) => a.start.line - b.start.line || a.start.character - b.start.character);
  const inserted: InsertedLine[] = [];
  let shift = 0;
  for (const change of ordered) {
    const lines = change.text.split("\n");
    const prefix = (before[change.start.line] ?? "").slice(0, change.start.character);
    const suffix = (before[change.end.line] ?? "").slice(change.end.character);
    lines.forEach((text, i) => {
      const last = i === lines.length - 1;
      const whole = (i > 0 || !prefix.trim()) && (!last || !suffix.trim());
      if (whole && text.trim()) inserted.push({ row: change.start.line + shift + i, text: text.trim() });
    });
    shift += lines.length - 1 - (change.end.line - change.start.line);
  }
  return inserted;
}

/**
 * Sites after one change event against `before`, the document's text at the time. VS Code
 * reports every change against the document before the event, so applying them bottom-up
 * keeps each one's coordinates valid. A site whose line the event deleted follows that
 * line's text to a row the same event inserted, if exactly one has it: Alt+Up/Down move a
 * line by deleting the one it passes and inserting it on the other side of the selection.
 */
export function shiftSites(sites: readonly CommentSite[], changes: readonly Change[], before: string): CommentSite[] {
  const lines = before.split("\n");
  const ordered = [...changes].sort((a, b) => b.start.line - a.start.line || b.start.character - a.start.character);
  const inserted = insertedLines(changes, lines);
  const relocated = (site: CommentSite): CommentSite | undefined => {
    const text = lines[site.row]?.trim();
    const matches = inserted.filter((l) => l.text === text);
    return text && matches.length === 1 ? { ...site, row: matches[0]!.row } : undefined;
  };
  return sites.flatMap((site) => {
    const shape = shapeOf(lines[site.row] ?? "");
    let row: number | undefined = site.row;
    for (const change of ordered) {
      if (row === undefined) break;
      row = shiftRow({ ...site, row }, change, shape);
    }
    if (row !== undefined) return [{ ...site, row }];
    const moved = relocated(site);
    return moved ? [moved] : [];
  });
}

/**
 * Sites a copy of `start`..`end` carries: an own-line comment when the copy includes the
 * first non-blank character of its line, a trailing one when it includes that line's code.
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
