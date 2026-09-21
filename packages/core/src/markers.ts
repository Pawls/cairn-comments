import type { LanguageSpec } from "./languages.js";
import { splitLines, type Line } from "./lines.js";
import { findComments } from "./parser.js";

export const ID_PATTERN = "[0-9a-z]{4}";

export type MarkerKind = "new" | "expanded" | "bare";

export interface Marker {
  kind: MarkerKind;
  placement: "own-line" | "trailing";
  /** Id as written in the source; absent on a new comment. */
  id: string | undefined;
  /** Body as written, block lines joined with `\n`; absent on a bare marker. */
  text: string | undefined;
  /** Offset of the sigil. */
  start: number;
  /** Offset just past the block's last comment, before that line's terminator. */
  end: number;
  /** Leading whitespace of an own-line marker; continuation lines repeat it. */
  indent: string;
}

interface SigilComment {
  id: string | undefined;
  text: string;
  start: number;
  end: number;
  row: number;
  /** Line content before the comment, when it is all whitespace. */
  indent: string | undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineIndexAt(lines: Line[], offset: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid]!.start <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Finds sigil comments via the grammar's comment nodes, so a sigil inside a string is
 * never a marker. Consecutive own-line sigil lines at one indent form a block whose first
 * line carries the id; a bare marker never absorbs following lines, because that would
 * let a neighbouring new comment overwrite its stored body.
 */
export async function findMarkers(spec: LanguageSpec, source: string): Promise<Marker[]> {
  if (!source.includes(spec.lineSigil)) return [];
  const form = new RegExp(`^${escapeRegExp(spec.lineSigil)}(${ID_PATTERN})?(?: (.*))?$`, "s");
  const lines = splitLines(source);

  const sigils: SigilComment[] = [];
  for (const span of await findComments(spec, source)) {
    // Some grammars (Python's) let the comment token swallow the CR of a CRLF terminator.
    const raw = source.slice(span.start, span.end).replace(/\r$/, "");
    const m = form.exec(raw);
    if (!m) continue;
    const row = lineIndexAt(lines, span.start);
    const before = source.slice(lines[row]!.start, span.start);
    sigils.push({
      id: m[1],
      text: (m[2] ?? "").trimEnd(),
      start: span.start,
      end: span.start + raw.length,
      row,
      indent: /^[ \t]*$/.test(before) ? before : undefined,
    });
  }

  const markers: Marker[] = [];
  for (let i = 0; i < sigils.length; i++) {
    const first = sigils[i]!;
    if (!first.id && !first.text) continue;
    const ownLine = first.indent !== undefined;
    const bodyLines = [first.text];
    let last = first;
    if (ownLine && first.text) {
      for (let next = sigils[i + 1]; next; next = sigils[i + 1]) {
        if (next.id || next.indent !== first.indent || next.row !== last.row + 1) break;
        bodyLines.push(next.text);
        last = next;
        i++;
      }
    }
    while (bodyLines.length > 1 && !bodyLines[bodyLines.length - 1]) bodyLines.pop();
    markers.push({
      kind: first.text ? (first.id ? "expanded" : "new") : "bare",
      placement: ownLine ? "own-line" : "trailing",
      id: first.id,
      text: first.text ? bodyLines.join("\n") : undefined,
      start: first.start,
      end: last.end,
      indent: first.indent ?? "",
    });
  }
  return markers;
}
