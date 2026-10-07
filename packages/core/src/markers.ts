import type { LanguageSpec } from "./languages.js";
import { lineIndexAt, splitLines, type Line } from "./lines.js";
import { commentsIn, parseWith, type CommentSpan } from "./parser.js";

export const ID_PATTERN = "[0-9a-z]{4}";

/** Smudge puts this before a possibly stale body; every reader strips it, so it never reaches a blob or sidecar. */
export const STALE_TAG = "[stale?]";

/**
 * `new`: a sigil comment with text and no id yet. `expanded`: one with an id and its text,
 * as an agent worktree shows it. `bare`: an id with no text, which only a hand edit leaves.
 */
export type MarkerKind = "new" | "expanded" | "bare";

/** A sigil comment: one own-line block or one trailing comment. */
export interface Marker {
  kind: MarkerKind;
  placement: "own-line" | "trailing";
  /** Id as written in the source; absent on a new comment. */
  id: string | undefined;
  /** Body as written, block lines joined with `\n`; absent on a bare one. */
  text: string | undefined;
  /** Offset of the sigil. */
  start: number;
  /** Offset just past the block's last comment, before that line's terminator. */
  end: number;
  /** Leading whitespace of an own-line comment; continuation lines repeat it. */
  indent: string;
  /** Whether the text carried `STALE_TAG`; `text` never includes it. */
  staleTag: boolean;
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

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Finds sigil comments via the grammar's comment nodes, so a sigil inside a string is
 * never one. Consecutive own-line sigil lines at one indent form a block whose first line
 * carries the id; a bare one never absorbs the lines below it, which could belong to a
 * neighboring new comment.
 */
export async function findMarkers(spec: LanguageSpec, source: string): Promise<Marker[]> {
  if (!source.includes(spec.lineSigil)) return [];
  return parseWith(spec, source, (root) => markersFrom(spec, source, splitLines(source), commentsIn(spec, root)));
}

/** Sigil comments among `comments`, for callers that hold the parse tree themselves. */
export function markersFrom(spec: LanguageSpec, source: string, lines: Line[], comments: readonly CommentSpan[]): Marker[] {
  const sigils = sigilComments(spec, source, lines, comments);
  const markers: Marker[] = [];
  let start = 0;
  while (start < sigils.length) {
    const block = blockAt(sigils, start);
    start += block.length;
    const marker = markerOf(block);
    if (marker) markers.push(marker);
  }
  return markers;
}

function sigilComments(spec: LanguageSpec, source: string, lines: Line[], comments: readonly CommentSpan[]): SigilComment[] {
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
  return sigils;
}

/**
 * The sigils from `start` that form one comment: an own-line one with text takes the lines
 * right below it at its indent, up to one that carries an id.
 */
function blockAt(sigils: SigilComment[], start: number): SigilComment[] {
  const first = sigils[start]!;
  const block = [first];
  if (first.indent === undefined || !first.text) return block;
  for (let k = start + 1; k < sigils.length; k++) {
    const next = sigils[k]!;
    if (next.id || next.indent !== first.indent || next.row !== block.at(-1)!.row + 1) break;
    block.push(next);
  }
  return block;
}

/** The marker a block forms; none for a lone sigil with neither id nor text. */
function markerOf(block: SigilComment[]): Marker | undefined {
  const first = block[0]!;
  if (!first.id && !first.text) return undefined;
  const bodyLines = block.map((s) => s.text);
  while (bodyLines.length > 1 && !bodyLines.at(-1)) bodyLines.pop();
  return {
    kind: markerKind(first),
    placement: first.indent === undefined ? "trailing" : "own-line",
    id: first.id,
    text: first.text ? bodyLines.join("\n") : undefined,
    start: first.start,
    end: block.at(-1)!.end,
    indent: first.indent ?? "",
    staleTag: first.staleTag,
  };
}

function markerKind(first: SigilComment): MarkerKind {
  if (!first.text) return "bare";
  return first.id ? "expanded" : "new";
}
