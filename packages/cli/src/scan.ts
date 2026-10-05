import { existsSync } from "node:fs";
import path from "node:path";
import {
  BRAND,
  DETECTORS,
  FILTER_DRIVER,
  SCAN_IGNORE,
  SIDECAR_ROOT,
  analyzeSource,
  appendIgnore,
  convertDemoted,
  demoteTarget,
  languageForPath,
  parseIgnore,
  parseSidecar,
  recordLiterals,
  scanSource,
  serializeSidecar,
  sidecarPathFor,
  type IgnoreEntry,
  type ScannedComment,
  type Sidecar,
} from "@cairn-comments/core";
import { collapseFiles, decodeExact, syncFiles } from "./files.js";
import { readWorkFile, writeWorkFile } from "./workfiles.js";
import { managedFiles, smudges, toRepoPath, trackedFiles } from "./git.js";

/** One entry of `scan --json`; `scan --apply` reads the same shape back. */
export interface ReviewEntry {
  file: string;
  line: number;
  endLine: number;
  fingerprint: string;
  score: number;
  detectors: string[];
  text: string;
  /** false rejects the comment: `--apply` records it in the ignore file instead. */
  accept: boolean;
}

export interface Review {
  version: 1;
  comments: ReviewEntry[];
}

export interface ApplyReport {
  converted: ReviewEntry[];
  ignored: ReviewEntry[];
  /** Listed comments no longer found as written, so left alone. */
  stale: ReviewEntry[];
  files: string[];
}

function emptyReport(): ApplyReport {
  return { converted: [], ignored: [], stale: [], files: [] };
}

function readIgnore(root: string): Map<string, Set<string>> {
  const file = path.join(root, SCAN_IGNORE);
  return parseIgnore(readWorkFile(file)?.toString("utf8") ?? "");
}

/** Named files, or every tracked file in a scanned language outside the tool's own folder. */
export function scanTargets(root: string, files: string[]): string[] {
  const candidates = files.length ? files.map((f) => toRepoPath(root, f)) : trackedFiles(root);
  const toolFolder = `${path.posix.dirname(SIDECAR_ROOT)}/`;
  return candidates.filter((f) => languageForPath(f) && !f.startsWith(toolFolder) && existsSync(path.join(root, f)));
}

function readSource(root: string, file: string): string | undefined {
  const bytes = readWorkFile(path.join(root, file));
  return bytes && decodeExact(bytes);
}

function toEntry(file: string, c: ScannedComment): ReviewEntry {
  return {
    file,
    line: c.line,
    endLine: c.endLine,
    fingerprint: c.fingerprint,
    score: Math.round(c.score * 100) / 100,
    detectors: c.findings.map((f) => f.detector),
    text: c.text,
    accept: true,
  };
}

/**
 * Likely AI comments, minus the ones already rejected. `all` also runs the detectors
 * that ship disabled.
 */
export async function scan(root: string, files: string[], options: { all?: boolean } = {}): Promise<Review> {
  const ignored = readIgnore(root);
  const comments: ReviewEntry[] = [];
  for (const file of scanTargets(root, files)) {
    const source = readSource(root, file);
    if (source === undefined) continue;
    for (const c of await scanSource(file, source, options.all ? { detectors: DETECTORS } : {})) {
      if (!ignored.get(file)?.has(c.fingerprint)) comments.push(toEntry(file, c));
    }
  }
  return { version: 1, comments };
}

export function formatReview(review: Review): string {
  const lines = review.comments.map(
    (c) => `${c.file}:${c.line}  ${c.score.toFixed(2)}  ${c.detectors.join(",")}  ${c.text.split("\n")[0]}`,
  );
  const files = new Set(review.comments.map((c) => c.file)).size;
  lines.push(`${review.comments.length} likely AI comment(s) in ${files} file(s)`);
  return lines.join("\n") + "\n";
}

function requireManaged(root: string, files: string[]): void {
  const managed = new Set(managedFiles(root, files));
  const missing = files.filter((f) => !managed.has(f));
  if (missing.length) {
    throw new Error(`not under the ${FILTER_DRIVER} filter (run \`${BRAND} init\` first): ${missing.join(", ")}`);
  }
}

/**
 * Converts each file's chosen comments to sigil comments, then runs `sync` (and, outside
 * an agent worktree, `collapse`), so bodies land in sidecars and `git status` shows only
 * the marker edits, the sidecars, and the ignore file.
 */
async function convertAndSync(root: string, chosen: Map<string, ScannedComment[]>): Promise<string[]> {
  const written: string[] = [];
  const literals = new Map<string, Map<string, string>>();
  for (const [file, comments] of chosen) {
    if (!comments.length) continue;
    const absolute = path.join(root, file);
    const source = readSource(root, file)!;
    const converted = convertDemoted(file, source, comments, new Set(readSidecar(root, file).entries.map((e) => e.id)));
    writeWorkFile(absolute, converted.source);
    if (converted.literals.size) literals.set(file, converted.literals);
    written.push(file);
  }
  if (smudges(root)) await syncFiles(root, written, { add: false });
  else await collapseFiles(root, written);
  // A demoted string's quotes go on the entry sync just made for it.
  for (const [file, ids] of literals) {
    writeWorkFile(path.join(root, sidecarPathFor(file)), serializeSidecar(recordLiterals(readSidecar(root, file), ids)));
  }
  return written;
}

function readSidecar(root: string, file: string): Sidecar {
  return parseSidecar(readWorkFile(path.join(root, sidecarPathFor(file)))?.toString("utf8") ?? "");
}

function recordIgnored(root: string, entries: IgnoreEntry[]): void {
  if (!entries.length) return;
  const file = path.join(root, SCAN_IGNORE);
  const existing = readWorkFile(file)?.toString("utf8") ?? "";
  const next = appendIgnore(existing, entries);
  if (next !== existing) writeWorkFile(file, next);
}

export function parseReview(text: string): Review {
  const review = JSON.parse(text) as Partial<Review>;
  if (review.version !== 1 || !Array.isArray(review.comments)) {
    throw new Error("not a scan review: expected {version: 1, comments: [...]}");
  }
  for (const c of review.comments) {
    if (typeof c.file !== "string" || typeof c.fingerprint !== "string" || typeof c.line !== "number") {
      throw new TypeError(`review entry needs file, line, and fingerprint: ${JSON.stringify(c)}`);
    }
    if (path.isAbsolute(c.file) || path.posix.normalize(c.file.replaceAll("\\", "/")).startsWith("../")) {
      throw new Error(`review entry points outside the repository: ${c.file}`);
    }
  }
  return review as Review;
}

/**
 * The comment with the entry's text nearest its listed line, skipping ones already
 * picked, so identical comments in one file stay distinct.
 */
function nearestMatch(
  available: ScannedComment[],
  entry: ReviewEntry,
  picked: ScannedComment[],
): ScannedComment | undefined {
  const distance = (c: ScannedComment) => Math.abs(c.line - entry.line);
  return available
    .filter((c) => c.fingerprint === entry.fingerprint && !picked.includes(c))
    .sort((a, b) => distance(a) - distance(b))[0];
}

/** Applies a reviewed list: accepted entries become sigil comments, rejected ones are ignored from now on. */
export async function applyReview(root: string, review: Review): Promise<ApplyReport> {
  const report = emptyReport();
  const byFile = new Map<string, ReviewEntry[]>();
  for (const e of review.comments) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
  const accepting = [...byFile].filter(([, es]) => es.some((e) => e.accept !== false)).map(([f]) => f);
  requireManaged(root, accepting);

  const chosen = new Map<string, ScannedComment[]>();
  const ignored: IgnoreEntry[] = [];
  for (const [file, entries] of byFile) {
    const source = existsSync(path.join(root, file)) ? readSource(root, file) : undefined;
    const available = source === undefined ? [] : (await analyzeSource(file, source)).filter((c) => !c.protected);
    const picks: ScannedComment[] = [];
    for (const entry of entries) {
      const match = nearestMatch(available, entry, picks);
      if (!match) {
        report.stale.push(entry);
      } else if (entry.accept === false) {
        ignored.push({ file, fingerprint: entry.fingerprint, preview: match.text });
        report.ignored.push(entry);
      } else {
        picks.push(match);
        report.converted.push(entry);
      }
    }
    chosen.set(file, picks);
  }
  recordIgnored(root, ignored);
  report.files = await convertAndSync(root, chosen);
  return report;
}

/** Every unprotected comment that is not already rejected, detectors or not. */
export async function markAll(root: string, files: string[]): Promise<ApplyReport> {
  const targets = scanTargets(root, files);
  requireManaged(root, targets);
  const ignored = readIgnore(root);
  const report = emptyReport();
  const chosen = new Map<string, ScannedComment[]>();
  for (const file of targets) {
    const source = readSource(root, file);
    if (source === undefined) continue;
    const rejected = ignored.get(file);
    const picks = (await analyzeSource(file, source)).filter((c) => !c.protected && !rejected?.has(c.fingerprint));
    chosen.set(file, picks);
    report.converted.push(...picks.map((c) => toEntry(file, c)));
  }
  report.files = await convertAndSync(root, chosen);
  return report;
}

/**
 * Moves the comments on the named 1-based lines into their sidecars: the explicit form of
 * `scan --apply` for one comment. Every target is checked before any file is written.
 */
export async function demote(root: string, targets: { file: string; line: number }[]): Promise<ApplyReport> {
  requireManaged(root, [...new Set(targets.map((t) => t.file))]);
  const report = emptyReport();
  const chosen = new Map<string, ScannedComment[]>();
  for (const { file, line } of targets) {
    const source = existsSync(path.join(root, file)) ? readSource(root, file) : undefined;
    const target = source === undefined ? "not a readable UTF-8 file" : await demoteTarget(file, source, line);
    if (typeof target === "string") throw new Error(`${file}:${line}: ${target}`);
    const picks = chosen.get(file) ?? [];
    if (picks.some((c) => c.start === target.start)) continue;
    picks.push(target);
    chosen.set(file, picks);
    report.converted.push(toEntry(file, target));
  }
  report.files = await convertAndSync(root, chosen);
  return report;
}

export function formatApply(report: ApplyReport): string {
  const out: string[] = [];
  // A pass that only ignored says so without a "converted 0" line.
  if (report.converted.length || !report.ignored.length) {
    out.push(`converted ${report.converted.length} comment(s) in ${report.files.length} file(s)`);
  }
  if (report.ignored.length) out.push(`ignored ${report.ignored.length} comment(s) in ${SCAN_IGNORE}`);
  for (const s of report.stale) out.push(`skipped ${s.file}:${s.line}: no longer matches the reviewed text`);
  return out.join("\n") + "\n";
}
