import type { LanguageSpec } from "./languages.js";
import { anchorHash } from "./anchors.js";
import { lineIndexAt, splitLines, type Line } from "./lines.js";
import { commentsIn, parseWith, type CommentSpan } from "./parser.js";

export const ID_PATTERN = "[0-9a-z]{4}";

/** Smudge puts this before a possibly stale body; every reader strips it, so it never reaches a blob or sidecar. */
export const STALE_TAG = "[stale?]";

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
  /** Whether the expanded text carried `STALE_TAG`; `text` never includes it. */
  staleTag: boolean;
  /**
   * Hash of the anchored code (anchors.ts), or null when nothing is anchored. Undefined
   * unless `findMarkers` was asked for anchors, which staleness checks treat as unknown.
   */
  anchor?: string | null;
}

export interface FindOptions {
  anchors?: boolean;
}

interface SigilComment {
  id: string | undefined;
  text: string;
  staleTag: boolean;
  start: number;
  end: number;
  row: number;
  /** Line content before the comment, when it is all whitespace. */
  indent: string | undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds sigil comments via the grammar's comment nodes, so a sigil inside a string is
 * never a marker. Consecutive own-line sigil lines at one indent form a block whose first
 * line carries the id; a bare marker never absorbs following lines, because that would
 * let a neighbouring new comment overwrite its stored body.
 */
export async function findMarkers(spec: LanguageSpec, source: string, options: FindOptions = {}): Promise<Marker[]> {
  if (!source.includes(spec.lineSigil)) return [];
  return parseWith(spec, source, (root) => {
    const lines = splitLines(source);
    const markers = markersFrom(spec, source, lines, commentsIn(spec, root));
    if (options.anchors) {
      for (const m of markers) {
        const row = { first: lineIndexAt(lines, m.start), last: lineIndexAt(lines, m.end) };
        m.anchor = anchorHash(spec, root, source, lines, m, row) ?? null;
      }
    }
    return markers;
  });
}

function markersFrom(spec: LanguageSpec, source: string, lines: Line[], comments: readonly CommentSpan[]): Marker[] {
  const form = new RegExp(`^${escapeRegExp(spec.lineSigil)}(${ID_PATTERN})?(?: (.*))?$`, "s");
  const tagged = new RegExp(`^${escapeRegExp(STALE_TAG)}(?: |$)`);

  const sigils: SigilComment[] = [];
  for (const span of comments) {
    // Some grammars (Python's) let the comment token swallow the CR of a CRLF terminator.
    const raw = source.slice(span.start, span.end).replace(/\r$/, "");
    const m = form.exec(raw);
    if (!m) continue;
    const row = lineIndexAt(lines, span.start);
    const before = source.slice(lines[row]!.start, span.start);
    let text = (m[2] ?? "").trimEnd();
    const staleTag = !!m[1] && tagged.test(text);
    if (staleTag) text = text.slice(STALE_TAG.length + 1);
    sigils.push({
      id: m[1],
      text,
      staleTag,
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
      staleTag: first.staleTag,
    });
  }
  return markers;
}
