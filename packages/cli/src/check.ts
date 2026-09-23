import { existsSync } from "node:fs";
import path from "node:path";
import { BRAND, LANGUAGES, SIDECAR_ROOT, findMarkers, languageForPath, parseSidecar, sidecarPathFor, type Marker, type Sidecar } from "@slopstash/core";
import { decodeExact, readSidecar, writeSidecar } from "./files.js";
import { grepTokens, ignoredByPattern, indexBlobs, managedFiles, stage, stagedFiles, toRepoPath, trackedFiles } from "./git.js";

export type Problem =
  /** A sigil comment whose text reached the index: a clone without the filter, or a failed `clean`. */
  | { kind: "expanded"; file: string; line: number; id?: string; text: string }
  | { kind: "missing-body"; file: string; line: number; id: string; sidecar: string }
  | { kind: "orphan-body"; file: string; id: string; source: string; hint?: string };

export type Fix = { kind: "relocated"; id: string; from: string; to: string } | { kind: "pruned"; id: string; from: string };

export interface CheckOptions {
  files: string[];
  /** Staged sources, their sidecars, and staged sidecar changes: what a commit is about to record. */
  staged: boolean;
  fix: boolean;
}

export interface CheckReport {
  problems: Problem[];
  fixes: Fix[];
}

interface Indexed {
  markers: Marker[];
  text: string;
}

const PREFIX = `${SIDECAR_ROOT}/`;
const isSidecarPath = (p: string) => p.startsWith(PREFIX) && p.endsWith(".md");
const sourceOf = (sidecar: string) => sidecar.slice(PREFIX.length, -".md".length);
const lineAt = (text: string, offset: number) => text.slice(0, offset).split("\n").length;
const SIGILS = [...new Set(LANGUAGES.map((l) => l.lineSigil))];

/**
 * The guard for clones without the filter (design.md § Check). Reads the index, never the
 * working tree, so the pre-commit hook and CI judge exactly what is or will be committed.
 * `fix` moves an orphaned body to the one file whose marker lacks it (a rename) and
 * removes bodies no marker references anywhere, then stages the sidecars it changed.
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
  const load = (files: Iterable<string>) => {
    const missing = [...files].filter((f) => !blobs.has(f));
    for (const [f, b] of indexBlobs(root, missing)) blobs.set(f, b);
  };
  const parsed = new Map<string, Promise<Indexed | undefined>>();
  const indexed = (file: string): Promise<Indexed | undefined> => {
    let p = parsed.get(file);
    if (!p) {
      p = (async () => {
        const spec = languageForPath(file);
        const bytes = blobs.get(file);
        const text = bytes && decodeExact(bytes);
        if (!spec || text === undefined) return undefined;
        return { text, markers: await findMarkers(spec, text) };
      })();
      parsed.set(file, p);
    }
    return p;
  };
  const sidecarIn = (file: string): Sidecar => parseSidecar(blobs.get(file)?.toString("utf8") ?? "");
  const hasBody = (sidecar: string, id: string) => sidecarIn(sidecar).entries.some((e) => e.id === id && e.body);
  const markerIds = async (file: string) => new Set((await indexed(file))?.markers.flatMap((m) => (m.id ? [m.id] : [])) ?? []);

  const problems: Problem[] = [];
  // Zero-trace mode (design.md § Decisions): with the folder ignored, markers dangle by choice.
  const bodiesKept = !ignoredByPattern(root, `${PREFIX}x.md`);
  const missing: Extract<Problem, { kind: "missing-body" }>[] = [];
  for (const file of sources) {
    const found = await indexed(file);
    if (!found) continue;
    for (const m of found.markers) {
      const line = lineAt(found.text, m.start);
      if (m.kind !== "bare") problems.push({ kind: "expanded", file, line, id: m.id, text: m.text!.split("\n")[0]! });
      else if (bodiesKept && !hasBody(sidecarPathFor(file), m.id!)) {
        missing.push({ kind: "missing-body", file, line, id: m.id!, sidecar: sidecarPathFor(file) });
      }
    }
  }
  if (!bodiesKept) return { problems, fixes: [] };

  const orphans: { sidecar: string; id: string }[] = [];
  const orphansIn = async (sidecar: string) => {
    const ids = await markerIds(sourceOf(sidecar));
    return sidecarIn(sidecar).entries.filter((e) => !ids.has(e.id)).map((e) => ({ sidecar, id: e.id }));
  };
  for (const sidecar of sidecars) if (blobs.has(sidecar)) orphans.push(...(await orphansIn(sidecar)));

  // A body renamed away can sit in a sidecar outside the scope; look it up by id.
  const unmatched = [...new Set(missing.filter((m) => !orphans.some((o) => o.id === m.id)).map((m) => m.id))];
  const elsewhere = grepTokens(root, unmatched.map((id) => `## ${id}`), true);
  const extra = [...new Set([...elsewhere.values()].flatMap((s) => [...s]))].filter((s) => isSidecarPath(s) && !sidecars.has(s));
  load([...extra, ...extra.map(sourceOf)]);
  for (const sidecar of extra) orphans.push(...(await orphansIn(sidecar)).filter((o) => unmatched.includes(o.id)));

  // Where each orphan's id is a marker now: in the index, then anywhere in the working tree.
  const tokens = (id: string) => SIGILS.map((s) => s + id);
  const orphanIds = [...new Set(orphans.map((o) => o.id))];
  const inIndex = grepTokens(root, orphanIds.flatMap(tokens), true);
  const inWorktree = grepTokens(root, orphanIds.flatMap(tokens), false);
  const filesWith = (found: Map<string, Set<string>>, id: string) => [...new Set(tokens(id).flatMap((t) => [...(found.get(t) ?? [])]))];
  const referencing = [...new Set(orphanIds.flatMap((id) => filesWith(inIndex, id)))];
  load(managedFiles(root, referencing).flatMap((f) => [f, sidecarPathFor(f)]));

  const fixes: Fix[] = [];
  const claimed = new Set<string>();
  for (const orphan of orphans) {
    const holders: string[] = [];
    const lacking: string[] = [];
    for (const f of managedFiles(root, filesWith(inIndex, orphan.id))) {
      if (!(await markerIds(f)).has(orphan.id)) continue;
      holders.push(f);
      if (!hasBody(sidecarPathFor(f), orphan.id)) lacking.push(f);
    }
    const rivals = orphans.filter((o) => o.id === orphan.id).length;
    const report = (hint?: string) => {
      if (sidecars.has(orphan.sidecar)) problems.push({ kind: "orphan-body", file: orphan.sidecar, id: orphan.id, source: sourceOf(orphan.sidecar), hint });
    };
    if (lacking.length === 1 && rivals === 1) {
      fixes.push({ kind: "relocated", id: orphan.id, from: orphan.sidecar, to: sidecarPathFor(lacking[0]!) });
      claimed.add(`${lacking[0]}\0${orphan.id}`);
    } else if (lacking.length) report(`ambiguous: markers in ${lacking.join(", ")} and ${rivals} bodies with this id`);
    else if (!holders.length && managedFiles(root, filesWith(inWorktree, orphan.id)).length) {
      report(`referenced in the working tree by ${managedFiles(root, filesWith(inWorktree, orphan.id)).join(", ")}; stage it`);
    } else if (sidecars.has(orphan.sidecar)) fixes.push({ kind: "pruned", id: orphan.id, from: orphan.sidecar });
  }
  problems.push(...missing.filter((m) => !claimed.has(`${m.file}\0${m.id}`)));

  if (!options.fix) {
    for (const f of fixes) {
      if (f.kind === "relocated") {
        if (sidecars.has(f.from)) problems.push({ kind: "orphan-body", file: f.from, id: f.id, source: sourceOf(f.from), hint: `\`${BRAND} check --fix\` moves it to ${f.to}` });
        // The target is outside the checked scope when only the old side was named or staged.
        const target = missing.find((m) => m.id === f.id && sidecarPathFor(m.file) === f.to);
        if (target) problems.push(target);
      } else problems.push({ kind: "orphan-body", file: f.from, id: f.id, source: sourceOf(f.from), hint: `\`${BRAND} check --fix\` removes it` });
    }
    return { problems: sortProblems(problems), fixes: [] };
  }
  await applyFixes(root, fixes, sidecarIn);
  return { problems: sortProblems(problems), fixes };
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
    lines.push(f.kind === "relocated" ? `relocated ${f.id}: ${f.from} -> ${f.to}` : `removed ${f.id} from ${f.from}: its marker is gone from ${sourceOf(f.from)}`);
  }
  for (const p of report.problems) {
    if (p.kind === "expanded") {
      lines.push(`${p.file}:${p.line}: comment committed with its text${p.id ? ` (${p.id})` : ""}: ${p.text}`);
    } else if (p.kind === "missing-body") lines.push(`${p.file}:${p.line}: marker ${p.id} has no body in ${p.sidecar}`);
    else lines.push(`${p.file}: body ${p.id} has no marker in ${p.source}${p.hint ? ` (${p.hint})` : ""}`);
  }
  if (report.problems.some((p) => p.kind === "expanded")) {
    lines.push(`hint: this clone commits without the filter; run \`${BRAND} init\`, then \`${BRAND} collapse\` and commit the result`);
  }
  return lines.map((l) => l + "\n").join("");
}
