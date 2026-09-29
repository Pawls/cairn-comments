import { existsSync } from "node:fs";
import path from "node:path";
import { BRAND, SIDECAR_ROOT, findMarkers, languageForPath, parseSidecar, placeComments, sidecarPathFor, type Sidecar, type SidecarEntry } from "@cairn-comments/core";
import { decodeExact, readSidecar, writeSidecar } from "./files.js";
import { indexBlobs, managedFiles, stage, stagedFiles, toRepoPath, trackedFiles } from "./git.js";

export type Problem =
  /** A sigil comment that reached the index: a clone without the filter, or a failed `clean`. */
  | { kind: "expanded"; file: string; line: number; id?: string; text: string }
  /** An entry whose sidecar's source is not in the index: renamed or deleted. */
  | { kind: "missing-source"; file: string; id: string; source: string; hint?: string }
  /** An entry that no longer places in its source; `scope` is its last known declaration. */
  | { kind: "unplaced"; file: string; id: string; source: string; scope?: string; text: string };

export type Fix =
  | { kind: "relocated"; id: string; from: string; to: string }
  | { kind: "pruned"; id: string; from: string }
  | { kind: "pruned-unplaced"; id: string; from: string };

export interface CheckOptions {
  files: string[];
  /** Staged sources, their sidecars, and staged sidecar changes: what a commit is about to record. */
  staged: boolean;
  fix: boolean;
  /** Also list entries that no longer place in their source. */
  orphans?: boolean;
  /** With `fix`: remove those entries. Nothing else ever deletes them. */
  prune?: boolean;
}

export interface CheckReport {
  problems: Problem[];
  fixes: Fix[];
}

const PREFIX = `${SIDECAR_ROOT}/`;
const isSidecarPath = (p: string) => p.startsWith(PREFIX) && p.endsWith(".md");
const sourceOf = (sidecar: string) => sidecar.slice(PREFIX.length, -".md".length);
const lineAt = (text: string, offset: number) => text.slice(0, offset).split("\n").length;

/**
 * The guard for clones without the filter (design.md § Check). Reads the index, never the
 * working tree, so the pre-commit hook and CI judge exactly what is or will be committed.
 * `fix` moves a renamed file's sidecar to the file its comments now place in, removes a
 * deleted file's, and (with `prune`) drops entries that no longer place, then stages the
 * sidecars it changed.
 */
export async function check(root: string, options: CheckOptions): Promise<CheckReport> {
  const tracked = trackedFiles(root);
  const named = options.files.map((f) => toRepoPath(root, f));
  const sources = named.length ? managedFiles(root, named) : managedFiles(root, options.staged ? stagedFiles(root) : tracked);
  const sidecars = new Set<string>();
  if (!named.length && !options.staged) tracked.filter(isSidecarPath).forEach((s) => sidecars.add(s));
  for (const f of named) sidecars.add(isSidecarPath(f) ? f : sidecarPathFor(f));
  for (const f of sources) sidecars.add(sidecarPathFor(f));
  if (options.staged) {
    for (const f of stagedFiles(root, "ACMD")) if (isSidecarPath(f)) sidecars.add(f);
    for (const f of managedFiles(root, stagedFiles(root, "D"))) sidecars.add(sidecarPathFor(f));
  }

  const blobs = indexBlobs(root, [...sources, ...sidecars, ...[...sidecars].map(sourceOf)]);
  const textOf = (file: string) => {
    const bytes = blobs.get(file);
    return bytes && decodeExact(bytes);
  };
  const sidecarIn = (file: string): Sidecar => parseSidecar(blobs.get(file)?.toString("utf8") ?? "");

  const problems: Problem[] = [];
  for (const file of sources) {
    const spec = languageForPath(file);
    const text = textOf(file);
    if (!spec || text === undefined) continue;
    for (const m of await findMarkers(spec, text)) {
      problems.push({ kind: "expanded", file, line: lineAt(text, m.start), id: m.id, text: (m.text ?? "").split("\n")[0]! });
    }
  }

  const fixes: Fix[] = [];
  const gone = [...sidecars].filter((s) => blobs.has(s) && !blobs.has(sourceOf(s)));
  if (gone.length) {
    // A staged rename's new half is a staged addition; outside a commit, any file without a sidecar.
    const indexed = new Set(tracked);
    const candidates = managedFiles(root, options.staged ? stagedFiles(root, "A") : tracked).filter((f) => !indexed.has(sidecarPathFor(f)));
    for (const [f, b] of indexBlobs(root, candidates.filter((f) => !blobs.has(f)))) blobs.set(f, b);
    const claimed = new Set<string>();
    for (const sidecar of gone) {
      const entries = sidecarIn(sidecar).entries;
      const targets = await placesIn(sourceOf(sidecar), entries, candidates, textOf);
      const target = targets.length === 1 && !claimed.has(targets[0]!) ? targets[0] : undefined;
      if (target) claimed.add(target);
      for (const { id } of entries) {
        if (target) fixes.push({ kind: "relocated", id, from: sidecar, to: sidecarPathFor(target) });
        else if (!targets.length) fixes.push({ kind: "pruned", id, from: sidecar });
        else problems.push({ kind: "missing-source", file: sidecar, id, source: sourceOf(sidecar), hint: `its comments place in more than one file: ${targets.join(", ")}` });
      }
    }
  }

  if (options.orphans || options.prune) {
    for (const sidecar of sidecars) {
      const text = textOf(sourceOf(sidecar));
      if (!blobs.has(sidecar) || text === undefined) continue;
      const entries = sidecarIn(sidecar).entries;
      for (const id of (await placeComments(sourceOf(sidecar), text, { preamble: "", entries })).unplaced) {
        const entry = entries.find((e) => e.id === id)!;
        if (options.fix && options.prune) fixes.push({ kind: "pruned-unplaced", id, from: sidecar });
        else problems.push({ kind: "unplaced", file: sidecar, id, source: sourceOf(sidecar), scope: entry.meta.get("scope"), text: entry.body.split("\n")[0]! });
      }
    }
  }

  if (!options.fix) {
    for (const f of fixes) {
      if (f.kind === "pruned-unplaced") continue;
      const hint = f.kind === "relocated" ? `\`${BRAND} check --fix\` moves it to ${f.to}` : `\`${BRAND} check --fix\` removes it`;
      problems.push({ kind: "missing-source", file: f.from, id: f.id, source: sourceOf(f.from), hint });
    }
    return { problems: sortProblems(problems), fixes: [] };
  }
  await applyFixes(root, fixes, sidecarIn);
  return { problems: sortProblems(problems), fixes };
}

/**
 * The candidates in `source`'s language where any of `entries` anchored to code places:
 * where a renamed source went. A comment kept by line number alone (`pos=row`) places in
 * any file, so it says nothing.
 */
async function placesIn(source: string, entries: SidecarEntry[], candidates: string[], textOf: (file: string) => string | undefined): Promise<string[]> {
  const anchored = entries.filter((e) => e.meta.has("pos") && e.meta.get("pos") !== "row");
  if (!anchored.length) return [];
  const found: string[] = [];
  for (const candidate of candidates) {
    const text = textOf(candidate);
    if (text === undefined || languageForPath(candidate) !== languageForPath(source)) continue;
    if ((await placeComments(candidate, text, { preamble: "", entries: anchored })).placed.length) found.push(candidate);
  }
  return found;
}

function sortProblems(problems: Problem[]): Problem[] {
  const key = (p: Problem) => `${p.file}\0${String("line" in p ? p.line : 0).padStart(9, "0")}\0${p.id ?? ""}`;
  return problems.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Edits the working sidecars (falling back to the staged entry) and stages every one it touched. */
async function applyFixes(root: string, fixes: Fix[], staged: (sidecar: string) => Sidecar): Promise<void> {
  if (!fixes.length) return;
  const working = new Map<string, Sidecar>();
  const get = async (sidecar: string) => {
    let s = working.get(sidecar);
    if (!s) working.set(sidecar, (s = await readSidecar(root, sourceOf(sidecar))));
    return s;
  };
  for (const fix of fixes) {
    const from = await get(fix.from);
    const entry = from.entries.find((e) => e.id === fix.id) ?? staged(fix.from).entries.find((e) => e.id === fix.id);
    from.entries = from.entries.filter((e) => e.id !== fix.id);
    if (fix.kind === "relocated" && entry) {
      const to = await get(fix.to);
      if (!to.entries.some((e) => e.id === fix.id && e.body)) to.entries = [...to.entries.filter((e) => e.id !== fix.id), entry];
    }
  }
  for (const [sidecar, content] of working) writeSidecar(root, sourceOf(sidecar), content);
  const tracked = new Set(trackedFiles(root));
  stage(root, [...working.keys()].filter((s) => existsSync(path.join(root, s)) || tracked.has(s)));
}

export function formatCheck(report: CheckReport): string {
  const lines: string[] = [];
  for (const f of report.fixes) {
    if (f.kind === "relocated") lines.push(`relocated ${f.id}: ${f.from} -> ${f.to}`);
    else if (f.kind === "pruned") lines.push(`removed ${f.id} from ${f.from}: ${sourceOf(f.from)} is gone`);
    else lines.push(`removed ${f.id} from ${f.from}: it no longer places in ${sourceOf(f.from)}`);
  }
  for (const p of report.problems) {
    if (p.kind === "expanded" && !p.text) {
      lines.push(`${p.file}:${p.line}: sigil comment committed (${p.id})`);
    } else if (p.kind === "expanded") {
      lines.push(`${p.file}:${p.line}: comment committed with its text${p.id ? ` (${p.id})` : ""}: ${p.text}`);
    } else if (p.kind === "missing-source") lines.push(`${p.file}: ${p.id} has no source; ${p.source} is gone${p.hint ? ` (${p.hint})` : ""}`);
    else lines.push(`${p.file}: ${p.id} no longer places in ${p.source}${p.scope ? ` (last in ${p.scope})` : ""}: ${p.text}`);
  }
  if (report.problems.some((p) => p.kind === "expanded")) {
    lines.push(`hint: this clone commits without the filter; run \`${BRAND} init\`, then \`${BRAND} collapse\` and commit the result`);
  }
  return lines.map((l) => l + "\n").join("");
}
