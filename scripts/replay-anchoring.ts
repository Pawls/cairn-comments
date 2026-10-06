/**
 * Anchoring replay (design.md § Anchoring, "Measured"): at commit N of a repository's
 * first-parent history from `HEAD`, a synthetic comment goes above each function that starts
 * its line and before the middle statement of its body (when the body has more than one).
 * The sidecar recorded then is placed against the source at N+steps, as an owner's commits
 * would reach an agent worktree that never edits those functions, and every comment is
 * classified. N takes `--windows` values spread evenly over the history. A run reads the
 * repository's current `HEAD`, so compare runs against a fixed clone. Run through
 * `npm run replay`, which builds first.
 *
 *   node scripts/replay-anchoring.ts --repo <path> [--windows 8] [--steps 20] [--sample 50] [--paths <prefix>]
 *
 * `--sample` prints that many diff placements, old and new code side by side, for a reader
 * to judge.
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import type { Node } from "web-tree-sitter";
import {
  languageForPath,
  placeComments,
  recordComments,
  type LanguageSpec,
  type Sidecar,
} from "../packages/core/dist/index.js";
import { parseWith } from "../packages/core/dist/parser.js";

const { values: args } = parseArgs({
  options: {
    repo: { type: "string" },
    windows: { type: "string", default: "8" },
    steps: { type: "string", default: "20" },
    sample: { type: "string", default: "50" },
    paths: { type: "string", default: "" },
  },
});
if (!args.repo) throw new Error("--repo <path> is required");
const REPO = args.repo;
const STEPS = Number(args.steps);
const PATH_PREFIX = args.paths ?? "";
/** Output cap for git commands that print whole blobs or the whole history (1 GiB). */
const MAX_OUTPUT = 1 << 30;

function git(...argv: string[]): string {
  return execFileSync("git", argv, { cwd: REPO, maxBuffer: MAX_OUTPUT }).toString("utf8");
}

/** Blobs by `rev:path`, read in one `git cat-file --batch`; missing ones are absent. */
function blobs(specs: string[]): Map<string, string> {
  const found = new Map<string, string>();
  if (!specs.length) return found;
  const input = specs.map((s) => s + "\n").join("");
  const out = execFileSync("git", ["cat-file", "--batch"], { cwd: REPO, input, maxBuffer: MAX_OUTPUT });
  let at = 0;
  for (const spec of specs) {
    const eol = out.indexOf(10, at);
    const header = out.subarray(at, eol).toString("utf8");
    at = eol + 1;
    if (header.endsWith(" missing")) continue;
    const size = Number(header.split(" ")[2]);
    found.set(spec, out.subarray(at, at + size).toString("utf8"));
    at += size + 1;
  }
  return found;
}

const indentOf = (line: string | undefined) => /^[ \t]*/.exec(line ?? "")?.[0] ?? "";

/** The synthetic comment line to insert before each row, by row. */
function syntheticInserts(root: Node, spec: LanguageSpec, lines: string[]): Map<number, string> {
  const inserts = new Map<number, string>();
  /** Only lines a comment can sit above: the node starts the line's code. */
  const startsLine = (node: Node) => indentOf(lines[node.startPosition.row]).length === node.startPosition.column;
  const insertBefore = (node: Node, text: string) => {
    const row = node.startPosition.row;
    if (!startsLine(node) || inserts.has(row)) return;
    inserts.set(row, `${indentOf(lines[row])}${spec.lineSigil} ${text}`);
  };
  const functions = root.descendantsOfType([...spec.functionTypes]).filter((fn): fn is Node => fn !== null);
  for (const [k, fn] of functions.entries()) {
    const head = fn.parent?.type === "decorated_definition" ? fn.parent : fn;
    insertBefore(head, `synthetic above ${k}`);
    const body = fn.childForFieldName("body");
    const statements = body?.namedChildren.filter((c): c is Node => !!c && !spec.commentTypes.includes(c.type)) ?? [];
    const middle = statements[Math.floor(statements.length / 2)];
    if (middle && statements.length > 1) insertBefore(middle, `synthetic inside ${k}`);
  }
  return inserts;
}

/** `source` with a synthetic comment above each function and before the middle statement of its body. */
async function withSyntheticComments(spec: LanguageSpec, source: string): Promise<string> {
  const lines = source.split("\n");
  const inserts = await parseWith(spec, source, (root) => syntheticInserts(root, spec, lines));
  const out: string[] = [];
  for (const [row, line] of lines.entries()) {
    const comment = inserts.get(row);
    if (comment !== undefined) out.push(comment);
    out.push(line);
  }
  return out.join("\n");
}

/** The code line right after the comment with `id` in `source`. */
function codeAfter(source: string, sigil: string, id: string): string {
  const lines = source.split("\n");
  const at = lines.findIndex((l) => l.trimStart().startsWith(sigil + id) || l.includes(" " + sigil + id));
  const marked = lines[at]; // undefined when `at` is -1
  if (marked === undefined) return "?";
  if (!marked.trimStart().startsWith(sigil)) return marked.slice(0, marked.indexOf(sigil + id)).trim();
  for (const line of lines.slice(at + 1)) {
    const code = line.trim();
    if (code && !line.trimStart().startsWith(sigil)) return code;
  }
  return "(end)";
}

type Outcome = "exact" | "diff" | "rename" | "orphan" | "deleted";
const empty = (): Record<Outcome, number> => ({ exact: 0, diff: 0, rename: 0, orphan: 0, deleted: 0 });
/** Outcomes over every comment, and per kind (`above`, `inside`) over comments in files that changed. */
const totals = { all: empty(), changed: empty(), above: empty(), inside: empty() };
const diffSamples: { file: string; window: string; kind: string; before: string; after: string; moved: boolean }[] = [];
const renames: { file: string; from: string; to: string }[] = [];
const orphans: { file: string; kind: string; scope: string; before: string; kept: boolean }[] = [];

function tally(outcome: Outcome, kind: string, fileChanged: boolean): void {
  totals.all[outcome]++;
  if (!fileChanged) return;
  totals.changed[outcome]++;
  totals[kind === "above" ? "above" : "inside"][outcome]++;
}

/** `above` or `inside`: a synthetic body reads `synthetic <kind> <n>`. */
const kindOf = (body: string) => body.split(" ")[1]!;

/** Places the sidecar recorded from `text` against `now` and files each comment under its outcome. */
async function replayFile(file: string, window: string, text: string, now: string | undefined): Promise<void> {
  const spec = languageForPath(file)!;
  const recorded = await recordComments(file, await withSyntheticComments(spec, text), { preamble: "", entries: [] });
  const sidecar: Sidecar = recorded.sidecar;
  if (!sidecar.entries.length) return;
  const fileChanged = now !== text;
  if (now === undefined) {
    for (const entry of sidecar.entries) tally("deleted", kindOf(entry.body), fileChanged);
    return;
  }
  const placed = await placeComments(file, now, sidecar);
  const stale = new Set(placed.stale.map((s) => s.id));
  const renamed = new Set(placed.renamed);
  for (const entry of sidecar.entries) {
    const kind = kindOf(entry.body);
    if (placed.unplaced.includes(entry.id)) {
      tally("orphan", kind, fileChanged);
      const before = codeAfter(recorded.source, spec.lineSigil, entry.id);
      orphans.push({ file, kind, scope: entry.meta.get("scope") ?? "(module)", before, kept: now.includes(before) });
    } else if (renamed.has(entry.id)) {
      tally("rename", kind, fileChanged);
      renames.push({ file, from: entry.meta.get("scope") ?? "", to: codeAfter(placed.source, spec.lineSigil, entry.id) });
    } else if (stale.has(entry.id)) {
      tally("diff", kind, fileChanged);
      const before = codeAfter(recorded.source, spec.lineSigil, entry.id);
      const after = codeAfter(placed.source, spec.lineSigil, entry.id);
      diffSamples.push({ file, window, kind, before, after, moved: before !== after });
    } else {
      tally("exact", kind, fileChanged);
    }
  }
}

/** Replays every file with functions as of commit `base` against the same file at `final`. */
async function replayWindow(base: string, final: string): Promise<void> {
  const files = git("ls-tree", "-r", "--name-only", base)
    .trim()
    .split("\n")
    .filter((f) => f.startsWith(PATH_PREFIX) && languageForPath(f)?.functionTypes.length);
  const texts = blobs([...files.map((f) => `${base}:${f}`), ...files.map((f) => `${final}:${f}`)]);
  for (const file of files) {
    const text = texts.get(`${base}:${file}`);
    if (text === undefined || text.includes("\r")) continue;
    await replayFile(file, base.slice(0, 7), text, texts.get(`${final}:${file}`));
  }
}

/** `count` items taken at even steps through `items` (all of them when there are fewer). */
function spread<T>(items: T[], count: number): T[] {
  const take = Math.min(count, items.length);
  return Array.from({ length: take }, (_, i) => items[Math.floor((i * items.length) / take)]!);
}

const history = git("rev-list", "--first-parent", "--reverse", "HEAD").trim().split("\n");
const last = history.length - STEPS - 1;
if (last < 0) throw new Error(`history has ${history.length} commits; need more than ${STEPS}`);
const count = Math.min(Number(args.windows), last + 1);
const starts = [...new Set(Array.from({ length: count }, (_, i) => Math.round((i * last) / Math.max(count - 1, 1))))];

for (const start of starts) await replayWindow(history[start]!, history[start + STEPS]!);

const share = (row: Record<Outcome, number>) => {
  const sum = Object.values(row).reduce((a, b) => a + b, 0);
  return Object.entries(row)
    .map(([k, v]) => `${k} ${v} (${sum ? ((100 * v) / sum).toFixed(1) : "0.0"}%)`)
    .join(", ");
};
console.log(`repo ${REPO}: ${starts.length} windows of ${STEPS} commits (${history.length} in history)`);
console.log(`all comments:            ${share(totals.all)}`);
console.log(`in files that changed:   ${share(totals.changed)}`);
console.log(`  above a function:      ${share(totals.above)}`);
console.log(`  inside a function:     ${share(totals.inside)}`);
const moved = diffSamples.filter((s) => s.moved);
console.log(`diff placements: ${diffSamples.length}, on a different line of code than recorded: ${moved.length}`);
console.log(`\nrename placements (${renames.length}):`);
for (const r of renames.slice(0, 20)) console.log(`  ${r.file}: ${r.from} -> ${r.to}`);

const kept = orphans.filter((o) => o.kept);
console.log(`\norphans: ${orphans.length}, whose recorded code line still exists verbatim: ${kept.length}`);
for (const o of spread(kept, 12)) console.log(`  ${o.file} (${o.kind}, scope ${o.scope}): ${o.before}`);

// Every nth diff placement, so the sample spreads over windows and files.
const sample = spread(diffSamples, Number(args.sample));
console.log(`\nsample of ${sample.length} diff placements (old code | new code; = when unchanged):`);
for (const [i, s] of sample.entries()) {
  console.log(`  [${i + 1}] ${s.window} ${s.file} (${s.kind})\n      old: ${s.before}\n      new: ${s.moved ? s.after : "="}`);
}
