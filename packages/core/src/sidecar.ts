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

const HEADING = new RegExp(`^## (${ID_PATTERN})\\s*$`);
const META = /^<!--(.*)-->\s*$/;
// A body line that would read back as structure gets one backslash on write.
const NEEDS_ESCAPE = new RegExp(`^\\\\*(?:## ${ID_PATTERN}\\s*$|<!--)`);
const ESCAPED = new RegExp(`^\\\\(\\\\*(?:## ${ID_PATTERN}\\s*$|<!--))`);

/** Repo-relative, forward-slash sidecar path for a repo-relative source path. */
export function sidecarPathFor(sourcePath: string): string {
  return `${SIDECAR_ROOT}/${sourcePath.replaceAll("\\", "/")}.md`;
}

export function normalizeBody(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trimEnd());
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.join("\n");
}

function parseMeta(inner: string): Map<string, string> {
  const meta = new Map<string, string>();
  for (const pair of inner.trim().split(/\s+/)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const value = pair.slice(eq + 1);
    try {
      meta.set(pair.slice(0, eq), decodeURIComponent(value));
    } catch {
      meta.set(pair.slice(0, eq), value);
    }
  }
  return meta;
}

export function parseSidecar(text: string): Sidecar {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const preamble: string[] = [];
  const byId = new Map<string, SidecarEntry>();
  let current: { entry: SidecarEntry; body: string[]; pastFirstLine: boolean } | undefined;

  const close = () => {
    if (!current) return;
    current.entry.body = normalizeBody(current.body.join("\n"));
    // A union merge can duplicate a heading; the later copy wins, in the earlier position.
    const earlier = byId.get(current.entry.id);
    if (earlier) Object.assign(earlier, current.entry);
    else byId.set(current.entry.id, current.entry);
  };

  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading) {
      close();
      current = { entry: { id: heading[1]!, meta: new Map(), body: "" }, body: [], pastFirstLine: false };
      continue;
    }
    if (!current) {
      preamble.push(line);
      continue;
    }
    const meta = current.pastFirstLine ? null : META.exec(line);
    current.pastFirstLine = true;
    if (meta) current.entry.meta = parseMeta(meta[1]!);
    else current.body.push(line.replace(ESCAPED, "$1"));
  }
  close();
  return { preamble: normalizeBody(preamble.join("\n")), entries: [...byId.values()] };
}

/** URI-encoded, except the characters of timestamps, model names, and paths, so the line stays readable. */
function encodeMetaValue(value: string): string {
  return encodeURIComponent(value).replace(/%(?:3A|2F|40|2C)/g, decodeURIComponent);
}

export function serializeSidecar(sidecar: Sidecar): string {
  const blocks: string[] = [];
  if (sidecar.preamble) blocks.push(sidecar.preamble + "\n");
  for (const entry of sidecar.entries) {
    let block = `## ${entry.id}\n`;
    if (entry.meta.size) {
      const pairs = [...entry.meta].map(([k, v]) => `${k}=${encodeMetaValue(v)}`);
      block += `<!-- ${pairs.join(" ")} -->\n`;
    }
    const body = entry.body.split("\n").map((l) => (NEEDS_ESCAPE.test(l) ? "\\" + l : l));
    if (entry.body) block += body.join("\n") + "\n";
    blocks.push(block);
  }
  return blocks.join("\n");
}

export function bodiesOf(sidecar: Sidecar): Map<string, string> {
  return new Map(sidecar.entries.map((e) => [e.id, e.body]));
}
