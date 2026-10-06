import { existsSync } from "node:fs";
import path from "node:path";
import { BRAND, SIDECAR_ROOT, findMarkers, languageForPath, parseSidecar, placeComments, sidecarPathFor, type Sidecar, type SidecarEntry } from "@cairn-comments/core";
import { decodeExact, readSidecar, writeSidecar } from "./files.js";
import { indexBlobs, managedFiles, stage, stagedFiles, stagedRenames, toRepoPath, trackedFiles } from "./git.js";

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
  const sources = managedFiles(root, sourcesToCheck(root, named, options.staged, tracked));
  const sidecars = sidecarsToCheck(root, named, sources, options.staged, tracked);
  const index = new Index(root, [...sources, ...sidecars, ...[...sidecars].map(sourceOf)]);

  const problems: Problem[] = await leaks(index, sources);
  const fixes: Fix[] = [];
  const gone = [...sidecars].filter((s) => index.has(s) && !index.has(sourceOf(s)));
  if (gone.length) {
    const found = await followGoneSources(root, index, gone, tracked, options.staged);
    problems.push(...found.problems);
    fixes.push(...found.fixes);
  }
  if (options.orphans || options.prune) {
    const orphans = await unplacedEntries(index, sidecars);
    if (options.fix && options.prune) fixes.push(...orphans.map((o): Fix => ({ kind: "pruned-unplaced", id: o.id, from: o.file })));
    else problems.push(...orphans);
  }

  if (!options.fix) return { problems: sortProblems([...problems, ...unappliedFixes(fixes)]), fixes: [] };
  await applyFixes(root, fixes, (sidecar) => index.sidecar(sidecar));
  return { problems: sortProblems(problems), fixes };
}

function sourcesToCheck(root: string, named: string[], staged: boolean, tracked: string[]): string[] {
  if (named.length) return named;
  return staged ? stagedFiles(root) : tracked;
}

/**
 * The sidecars of the named files and of `sources`; on a full check every tracked sidecar,
 * and in a commit the staged sidecar changes and the sidecars of staged deletions.
 */
function sidecarsToCheck(root: string, named: string[], sources: string[], staged: boolean, tracked: string[]): Set<string> {
  const sidecars = new Set(!named.length && !staged ? tracked.filter(isSidecarPath) : []);
  for (const f of named) sidecars.add(isSidecarPath(f) ? f : sidecarPathFor(f));
  for (const f of sources) sidecars.add(sidecarPathFor(f));
  if (staged) {
    for (const f of stagedFiles(root, "ACMD").filter(isSidecarPath)) sidecars.add(f);
    for (const f of managedFiles(root, stagedFiles(root, "D"))) sidecars.add(sidecarPathFor(f));
  }
  return sidecars;
}

/** Without `--fix`, a sidecar `--fix` would move or remove is reported, with what the fix would do. */
function unappliedFixes(fixes: Fix[]): Problem[] {
  const problems: Problem[] = [];
  for (const f of fixes) {
    if (f.kind === "pruned-unplaced") continue;
    const hint = f.kind === "relocated" ? `\`${BRAND} check --fix\` moves it to ${f.to}` : `\`${BRAND} check --fix\` removes it`;
    problems.push({ kind: "missing-source", file: f.from, id: f.id, source: sourceOf(f.from), hint });
  }
  return problems;
}

/** Index blobs by path, loaded in batches as the check needs them. */
class Index {
  private readonly blobs: Map<string, Buffer>;

  constructor(
    private readonly root: string,
    files: string[],
  ) {
    this.blobs = indexBlobs(root, files);
  }

  load(files: string[]): void {
    for (const [f, b] of indexBlobs(this.root, files.filter((f) => !this.blobs.has(f)))) this.blobs.set(f, b);
  }

  has(file: string): boolean {
    return this.blobs.has(file);
  }

  text(file: string): string | undefined {
    const bytes = this.blobs.get(file);
    return bytes && decodeExact(bytes);
  }

  sidecar(file: string): Sidecar {
    return parseSidecar(this.blobs.get(file)?.toString("utf8") ?? "");
  }
}

/** Sigil comments in the blobs of `sources`, with their text or not. */
async function leaks(index: Index, sources: string[]): Promise<Problem[]> {
  const found: Problem[] = [];
  for (const file of sources) {
    const spec = languageForPath(file);
    const text = index.text(file);
    if (!spec || text === undefined) continue;
    for (const m of await findMarkers(spec, text)) {
      found.push({ kind: "expanded", file, line: lineAt(text, m.start), id: m.id, text: (m.text ?? "").split("\n")[0]! });
    }
  }
  return found;
}

/**
 * Where each sidecar whose source left the index goes: to the file its source was renamed
 * to, or nowhere when the source was deleted. In a commit, git's rename detection says
 * where a source went; outside one, placement does.
 */
async function followGoneSources(root: string, index: Index, gone: string[], tracked: string[], staged: boolean): Promise<CheckReport> {
  const renames = staged ? stagedRenames(root) : undefined;
  const indexed = new Set(tracked);
  // A rename target may already have a sidecar, because sync recorded the comments shown in
  // its file; applying the fix merges the old entries into it. Outside a commit, the
  // candidates are the files without a tracked sidecar.
  const candidates = renames
    ? managedFiles(root, [...renames.values()])
    : managedFiles(root, tracked).filter((f) => !indexed.has(sidecarPathFor(f)));
  index.load(candidates);
  const report: CheckReport = { problems: [], fixes: [] };
  const claimed = new Set<string>();
  for (const sidecar of gone) {
    const source = sourceOf(sidecar);
    const entries = index.sidecar(sidecar).entries;
    const targets = renames ? candidates.filter((c) => c === renames.get(source)) : await placesIn(source, entries, candidates, index);
    const target = targets.length === 1 && !claimed.has(targets[0]!) ? targets[0] : undefined;
    if (target) claimed.add(target);
    reportGone(report, sidecar, entries, targets, target);
  }
  return report;
}

/** Each entry of a gone source's sidecar moves to `target`, goes with no target, or is a problem when several files claim it. */
function reportGone(report: CheckReport, sidecar: string, entries: SidecarEntry[], targets: string[], target: string | undefined): void {
  const source = sourceOf(sidecar);
  for (const { id } of entries) {
    if (target) report.fixes.push({ kind: "relocated", id, from: sidecar, to: sidecarPathFor(target) });
    else if (!targets.length) report.fixes.push({ kind: "pruned", id, from: sidecar });
    else report.problems.push({ kind: "missing-source", file: sidecar, id, source, hint: `its comments place in more than one file: ${targets.join(", ")}` });
  }
}

type Unplaced = Extract<Problem, { kind: "unplaced" }>;

/** Entries of `sidecars` that no longer place in their source's blob. */
async function unplacedEntries(index: Index, sidecars: Iterable<string>): Promise<Unplaced[]> {
  const found: Unplaced[] = [];
  for (const sidecar of sidecars) {
    const source = sourceOf(sidecar);
    const text = index.text(source);
    if (!index.has(sidecar) || text === undefined) continue;
    const entries = index.sidecar(sidecar).entries;
    for (const id of (await placeComments(source, text, { preamble: "", entries })).unplaced) {
      const entry = entries.find((e) => e.id === id)!;
      found.push({ kind: "unplaced", file: sidecar, id, source, scope: entry.meta.get("scope"), text: entry.body.split("\n")[0]! });
    }
  }
  return found;
}

/**
 * The candidates in `source`'s language where most of `entries` anchored to code place:
 * where a renamed source went. A comment kept by line number alone (`pos=row`) places in
 * any file, so it says nothing.
 */
async function placesIn(source: string, entries: SidecarEntry[], candidates: string[], index: Index): Promise<string[]> {
  const anchored = entries.filter((e) => e.meta.has("pos") && e.meta.get("pos") !== "row");
  if (!anchored.length) return [];
  const found: string[] = [];
  for (const candidate of candidates) {
    const text = index.text(candidate);
    if (text === undefined || languageForPath(candidate) !== languageForPath(source)) continue;
    const placed = (await placeComments(candidate, text, { preamble: "", entries: anchored })).placed.length;
    if (placed * 2 > anchored.length) found.push(candidate);
  }
  return found;
}

function sortProblems(problems: Problem[]): Problem[] {
  const key = (p: Problem) => `${p.file}\0${String("line" in p ? p.line : 0).padStart(9, "0")}\0${p.id ?? ""}`;
  return problems.sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    if (ka === kb) return 0;
    return ka < kb ? -1 : 1;
  });
}

/** The working copy of `sidecar`, read once and then edited in `working`. */
async function workingSidecar(root: string, working: Map<string, Sidecar>, sidecar: string): Promise<Sidecar> {
  const cached = working.get(sidecar);
  if (cached) return cached;
  const read = await readSidecar(root, sourceOf(sidecar));
  working.set(sidecar, read);
  return read;
}

/** Edits the working sidecars (falling back to the staged entry) and stages every one it touched. */
async function applyFixes(root: string, fixes: Fix[], staged: (sidecar: string) => Sidecar): Promise<void> {
  if (!fixes.length) return;
  const working = new Map<string, Sidecar>();
  for (const fix of fixes) {
    const from = await workingSidecar(root, working, fix.from);
    const entry = from.entries.find((e) => e.id === fix.id) ?? staged(fix.from).entries.find((e) => e.id === fix.id);
    from.entries = from.entries.filter((e) => e.id !== fix.id);
    if (fix.kind !== "relocated" || !entry) continue;
    const to = await workingSidecar(root, working, fix.to);
    // An entry the target's own sync already recorded with a body wins over the moved one.
    if (!to.entries.some((e) => e.id === fix.id && e.body)) to.entries = [...to.entries.filter((e) => e.id !== fix.id), entry];
  }
  for (const [sidecar, content] of working) writeSidecar(root, sourceOf(sidecar), content);
  const tracked = new Set(trackedFiles(root));
  stage(root, [...working.keys()].filter((s) => existsSync(path.join(root, s)) || tracked.has(s)));
}

/** ` (text)`, or nothing when there is no text. */
const aside = (text: string | undefined) => (text ? " (" + text + ")" : "");

function formatFix(f: Fix): string {
  if (f.kind === "relocated") return `relocated ${f.id}: ${f.from} -> ${f.to}`;
  if (f.kind === "pruned") return `removed ${f.id} from ${f.from}: ${sourceOf(f.from)} is gone`;
  return `removed ${f.id} from ${f.from}: it no longer places in ${sourceOf(f.from)}`;
}

function formatProblem(p: Problem): string {
  if (p.kind === "expanded" && !p.text) return `${p.file}:${p.line}: sigil comment committed (${p.id})`;
  if (p.kind === "expanded") return `${p.file}:${p.line}: comment committed with its text${aside(p.id)}: ${p.text}`;
  if (p.kind === "missing-source") return `${p.file}: ${p.id} has no source; ${p.source} is gone${aside(p.hint)}`;
  return `${p.file}: ${p.id} no longer places in ${p.source}${aside(p.scope && "last in " + p.scope)}: ${p.text}`;
}

export function formatCheck(report: CheckReport): string {
  const lines = [...report.fixes.map(formatFix), ...report.problems.map(formatProblem)];
  if (report.problems.some((p) => p.kind === "expanded")) {
    lines.push(`hint: this clone commits without the filter; run \`${BRAND} init\`, then \`${BRAND} collapse\` and commit the result`);
  }
  return lines.map((l) => l + "\n").join("");
}
