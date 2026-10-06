import { BRAND } from "./brand.js";

// One rejected comment per line: `<path>\t<fingerprint>\t<text preview>`. Lines only ever
// append, so `merge=union` combines two branches' rejections without conflicts.
const HEADER = `# Comments \`${BRAND} scan\` will not propose again: <path> TAB <fingerprint> TAB <preview>.\n`;

/** The longest preview written, so a line stays readable. */
const PREVIEW_LENGTH = 72;

export interface IgnoreEntry {
  file: string;
  fingerprint: string;
  preview: string;
}

type Ignored = Map<string, Set<string>>;

function remember(ignored: Ignored, file: string, fingerprint: string): void {
  let fingerprints = ignored.get(file);
  if (!fingerprints) {
    fingerprints = new Set();
    ignored.set(file, fingerprints);
  }
  fingerprints.add(fingerprint);
}

/** Fingerprints per repo-relative path. Unparseable lines are skipped, never fatal. */
export function parseIgnore(text: string): Map<string, Set<string>> {
  const ignored: Ignored = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const [file, fingerprint] = line.split("\t");
    if (file && fingerprint) remember(ignored, file, fingerprint);
  }
  return ignored;
}

function previewOf(text: string): string {
  return text.split("\n")[0]!.replace(/\s+/g, " ").trim().slice(0, PREVIEW_LENGTH);
}

/** `existing` with the entries it lacks appended. The lines added end in LF; `existing` is kept as it is. */
export function appendIgnore(existing: string, entries: readonly IgnoreEntry[]): string {
  const known = parseIgnore(existing);
  let out = existing || HEADER;
  if (!out.endsWith("\n")) out += "\n";
  for (const e of entries) {
    if (known.get(e.file)?.has(e.fingerprint)) continue;
    out += `${e.file}\t${e.fingerprint}\t${previewOf(e.preview)}\n`;
    remember(known, e.file, e.fingerprint);
  }
  return out;
}
