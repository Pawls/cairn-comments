export interface Line {
  /** Offset of the first character of the line. */
  start: number;
  /** Offset just past the content, before the terminator. */
  contentEnd: number;
  /** Offset just past the terminator (`\n`, `\r\n`, or nothing at EOF). */
  end: number;
}

export function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start < source.length) {
    const nl = source.indexOf("\n", start);
    if (nl === -1) {
      lines.push({ start, contentEnd: source.length, end: source.length });
      break;
    }
    const contentEnd = nl > start && source[nl - 1] === "\r" ? nl - 1 : nl;
    lines.push({ start, contentEnd, end: nl + 1 });
    start = nl + 1;
  }
  return lines;
}

/** Index of the line holding `offset`. */
export function lineIndexAt(lines: Line[], offset: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid]!.start <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The terminator most lines use; LF when the text has none. */
export function dominantEol(source: string): "\n" | "\r\n" {
  let crlf = 0;
  let lf = 0;
  for (const line of splitLines(source)) {
    const width = line.end - line.contentEnd;
    if (width === 2) crlf++;
    else if (width === 1) lf++;
  }
  return crlf > lf ? "\r\n" : "\n";
}

export interface Splice {
  start: number;
  end: number;
  text: string;
}

/** Applies non-overlapping replacements; everything outside them is copied untouched. */
export function applySplices(source: string, splices: Splice[]): string {
  const ordered = [...splices].sort((a, b) => a.start - b.start);
  let out = "";
  let at = 0;
  for (const s of ordered) {
    out += source.slice(at, s.start) + s.text;
    at = s.end;
  }
  return out + source.slice(at);
}
