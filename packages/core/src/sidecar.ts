import { SIDECAR_ROOT } from "./brand.js";
import { ID_PATTERN } from "./markers.js";

export interface SidecarEntry {
  id: string;
  /** Reserved per-entry metadata line: provenance and the staleness anchor. */
  meta: Map<string, string>;
  /** LF-joined, no leading or trailing blank lines. */
  body: string;
}

export interface Sidecar {
  /** Anything before the first entry heading, kept minus surrounding blank lines. */
  preamble: string;
  /** File order is preserved and new entries append, so rewrites diff minimally. */
  entries: SidecarEntry[];
}

const HEADING = new RegExp(String.raw`^## (${ID_PATTERN})\s*$`);
const META = /^<!--(.*)-->\s*$/;
// A body line that would read back as structure gets one backslash on write.
const NEEDS_ESCAPE = new RegExp(String.raw`^\\*(?:## ${ID_PATTERN}\s*$|<!--)`);
const ESCAPED = new RegExp(String.raw`^\\(\\*(?:## ${ID_PATTERN}\s*$|<!--))`);

/** Repo-relative, forward-slash sidecar path for a repo-relative source path. */
export function sidecarPathFor(sourcePath: string): string {
  return `${SIDECAR_ROOT}/${sourcePath.replaceAll("\\", "/")}.md`;
}

/** LF line ends, trailing spaces trimmed from every line, and no blank lines at either edge. */
export function normalizeBody(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trimEnd());
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines.at(-1)) lines.pop();
  return lines.join("\n");
}

function decodeMetaValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseMeta(inner: string): Map<string, string> {
  const meta = new Map<string, string>();
  for (const pair of inner.trim().split(/\s+/)) {
    const eq = pair.indexOf("=");
    if (eq > 0) meta.set(pair.slice(0, eq), decodeMetaValue(pair.slice(eq + 1)));
  }
  return meta;
}

/** The lines under one entry heading. */
interface Section {
  id: string;
  lines: string[];
}

/** Splits `lines` at the entry headings: what precedes the first one, then each heading's lines. */
function splitSections(lines: readonly string[]): { preamble: string[]; sections: Section[] } {
  const preamble: string[] = [];
  const sections: Section[] = [];
  let current: Section | undefined;
  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading) {
      current = { id: heading[1]!, lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  return { preamble, sections };
}

/** An entry from the lines under its heading: an optional metadata line, then the body. */
function readEntry(section: Section): SidecarEntry {
  const meta = META.exec(section.lines[0] ?? "");
  const bodyLines = meta ? section.lines.slice(1) : section.lines;
  const body = normalizeBody(bodyLines.map((l) => l.replace(ESCAPED, "$1")).join("\n"));
  return { id: section.id, meta: meta ? parseMeta(meta[1]!) : new Map(), body };
}

/** Reads LF or CRLF text. A heading repeated by a union merge keeps its later copy, in the earlier position. */
export function parseSidecar(text: string): Sidecar {
  const { preamble, sections } = splitSections(text.replace(/\r\n?/g, "\n").split("\n"));
  const byId = new Map<string, SidecarEntry>();
  for (const section of sections) byId.set(section.id, readEntry(section));
  return { preamble: normalizeBody(preamble.join("\n")), entries: [...byId.values()] };
}

/** URI-encoded, except the characters of timestamps, model names, and paths, so the line stays readable. */
function encodeMetaValue(value: string): string {
  return encodeURIComponent(value).replace(/%(?:3A|2F|40|2C)/g, decodeURIComponent);
}

function serializeEntry(entry: SidecarEntry): string {
  let block = `## ${entry.id}\n`;
  if (entry.meta.size) {
    const pairs = [...entry.meta].map(([k, v]) => `${k}=${encodeMetaValue(v)}`);
    block += `<!-- ${pairs.join(" ")} -->\n`;
  }
  if (entry.body) {
    const body = entry.body.split("\n").map((l) => (NEEDS_ESCAPE.test(l) ? "\\" + l : l));
    block += body.join("\n") + "\n";
  }
  return block;
}

/** Always LF, whatever line ends the text was read with. */
export function serializeSidecar(sidecar: Sidecar): string {
  const blocks = sidecar.entries.map(serializeEntry);
  if (sidecar.preamble) blocks.unshift(sidecar.preamble + "\n");
  return blocks.join("\n");
}

/** Each entry's body by id. */
export function bodiesOf(sidecar: Sidecar): Map<string, string> {
  return new Map(sidecar.entries.map((e) => [e.id, e.body]));
}
