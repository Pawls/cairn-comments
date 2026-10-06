import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { convertComments, newComments } from "@cairn-comments/core";
import { collapseFiles, decodeExact, syncFiles } from "./files.js";
import { changedFiles, indexBlob, managedFiles, smudges } from "./git.js";
import { isScannable } from "./scan.js";

/** Who wrote a comment, recorded on the sidecar entry's metadata line. */
export interface Provenance {
  /** Harness name, e.g. `claude-code`. */
  by?: string;
  model?: string;
  session?: string;
  /** ISO 8601 UTC, to the second; defaults to now. */
  at?: string;
}

/** Metadata keys in a fixed order, empty values left out. */
export function provenanceMeta(p: Provenance): Map<string, string> {
  const at = p.at ?? new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const pairs: [string, string | undefined][] = [
    ["by", p.by],
    ["model", p.model],
    ["session", p.session],
    ["at", at],
  ];
  return new Map(pairs.filter((kv): kv is [string, string] => !!kv[1]));
}

export interface TagReport {
  tagged: number;
  files: string[];
}

/**
 * The generic post-edit command: every new unprotected comment in `files` (new against
 * the index; design.md § Hook adapters) becomes a sigil comment, then the files sync, so
 * bodies reach the sidecar with `provenance` on each entry this run creates or edits.
 * Outside an agent worktree the files are collapsed as well, as `scan --apply` does.
 * Files outside the filter are skipped, so a harness hook can call this for any edit.
 */
export async function tag(root: string, files: string[], provenance: Provenance = {}): Promise<TagReport> {
  const targets = managedFiles(
    root,
    [...new Set(files)].filter((f) => isScannable(root, f)),
  );
  let tagged = 0;
  for (const file of targets) {
    const absolute = path.join(root, file);
    const source = decodeExact(readFileSync(absolute));
    if (source === undefined) continue;
    const blob = indexBlob(root, file);
    const baseline = blob === undefined ? "" : decodeExact(blob);
    if (baseline === undefined) continue;
    const fresh = await newComments(file, source, baseline);
    if (!fresh.length) continue;
    writeFileSync(absolute, convertComments(file, source, fresh));
    tagged += fresh.length;
  }
  // Every target syncs, not only the tagged ones: an agent may have written sigil comments itself.
  const meta = provenanceMeta(provenance);
  if (smudges(root)) await syncFiles(root, targets, { add: false, meta });
  else await collapseFiles(root, targets, { meta });
  return { tagged, files: targets };
}

/** `tag --changed`: working-tree edits and untracked files, plus any named ones. */
export function tagTargets(root: string, named: string[], changed: boolean): string[] {
  return changed ? [...named, ...changedFiles(root)] : named;
}
