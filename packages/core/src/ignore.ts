import { BRAND } from "./brand.js";

// One rejected comment per line: `<path>\t<fingerprint>\t<text preview>`. Lines only ever
// append, so `merge=union` combines two branches' rejections without conflicts.
const HEADER = `# Comments \`${BRAND} scan\` will not propose again: <path> TAB <fingerprint> TAB <preview>.\n`;

export interface IgnoreEntry {
  file: string;
  fingerprint: string;
  preview: string;
}

/** Fingerprints per repo-relative path. Unparseable lines are skipped, never fatal. */
export function parseIgnore(text: string): Map<string, Set<string>> {
  const ignored = new Map<string, Set<string>>();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const [file, fingerprint] = line.split("\t");
    if (!file || !fingerprint) continue;
    let set = ignored.get(file);
    if (!set) ignored.set(file, (set = new Set()));
    set.add(fingerprint);
  }
  return ignored;
}

/** `existing` with the entries it lacks appended, as LF text. */
export function appendIgnore(existing: string, entries: readonly IgnoreEntry[]): string {
  const known = parseIgnore(existing);
  let out = existing || HEADER;
  if (!out.endsWith("\n")) out += "\n";
  for (const e of entries) {
    if (known.get(e.file)?.has(e.fingerprint)) continue;
    const preview = e.preview.split("\n")[0]!.replace(/\s+/g, " ").trim().slice(0, 72);
    out += `${e.file}\t${e.fingerprint}\t${preview}\n`;
    let set = known.get(e.file);
    if (!set) known.set(e.file, (set = new Set()));
    set.add(e.fingerprint);
  }
  return out;
}
