/**
 * Anchoring replay (design.md § Anchoring, "Measured"): at commit N of a repository's
 * first-parent history, a synthetic comment goes above every function and before the
 * middle top-level statement of its body. The sidecar recorded then is placed against each
 * of N+1..N+steps, as an owner's commits would reach an agent worktree that never edits
 * those functions, and every placement is classified. Run through `npm run replay`, which
 * builds first.
 *
 *   node scripts/replay-anchoring.ts --repo <path> [--windows 8] [--steps 20] [--sample 50] [--paths <prefix>]
 *
 * `--sample` prints that many diff placements at the last step, old and new code side by
 * side, for a reader to judge.
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import type { Node } from "web-tree-sitter";
import { languageForPath, placeComments, recordComments, type LanguageSpec, type Sidecar } from "../packages/core/dist/index.js";
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

function git(...argv: string[]): string {
  return execFileSync("git", argv, { cwd: REPO, maxBuffer: 1 << 30 }).toString("utf8");
}

/** Blobs by `rev:path`, read in one `git cat-file --batch`; missing ones are absent. */
function blobs(specs: string[]): Map<string, string> {
  const found = new Map<string, string>();
  if (!specs.length) return found;
  const out = execFileSync("git", ["cat-file", "--batch"], { cwd: REPO, input: specs.map((s) => s + "\n").join(""), maxBuffer: 1 << 30 });
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

/** Where the synthetic comments go: above each function's first line, and before the middle statement of its body. */
async function withSyntheticComments(spec: LanguageSpec, source: string): Promise<string> {
  const lines = source.split("\n");
  const inserts = new Map<number, string>();
  await parseWith(spec, source, (root) => {
    let k = 0;
    for (const fn of root.descendantsOfType([...spec.functionTypes])) {
      if (!fn) continue;
      const head = fn.parent?.type === "decorated_definition" ? fn.parent : fn;
      const body = fn.childForFieldName("body");
      const statements = body?.namedChildren.filter((c): c is Node => !!c && !spec.commentTypes.includes(c.type)) ?? [];
      const indentOf = (row: number) => /^[ \t]*/.exec(lines[row] ?? "")![0];
      // Only lines a comment can sit above: the node starts the line's code.
      const startsLine = (n: Node) => indentOf(n.startPosition.row).length === n.startPosition.column;
      if (startsLine(head) && !inserts.has(head.startPosition.row)) {
        inserts.set(head.startPosition.row, `${indentOf(head.startPosition.row)}${spec.lineSigil} synthetic above ${k}`);
      }
      const middle = statements[Math.floor(statements.length / 2)];
      if (middle && statements.length > 1 && startsLine(middle) && !inserts.has(middle.startPosition.row)) {
        inserts.set(middle.startPosition.row, `${indentOf(middle.startPosition.row)}${spec.lineSigil} synthetic inside ${k}`);
      }
      k++;
    }
  });
  const out: string[] = [];
  lines.forEach((line, row) => {
    const comment = inserts.get(row);
    if (comment !== undefined) out.push(comment);
    out.push(line);
  });
  return out.join("\n");
}

/** The code line right after the comment with `id` in `source`. */
function codeAfter(source: string, sigil: string, id: string): string {
  const lines = source.split("\n");
  const at = lines.findIndex((l) => l.trimStart().startsWith(sigil + id) || l.includes(" " + sigil + id));
  if (at < 0) return "?";
  if (!lines[at]!.trimStart().startsWith(sigil)) return lines[at]!.slice(0, lines[at]!.indexOf(sigil + id)).trim();
  for (let r = at + 1; r < lines.length; r++) if (lines[r]!.trim() && !lines[r]!.trimStart().startsWith(sigil)) return lines[r]!.trim();
  return "(end)";
}

type Outcome = "exact" | "diff" | "rename" | "orphan" | "deleted";
const empty = (): Record<Outcome, number> => ({ exact: 0, diff: 0, rename: 0, orphan: 0, deleted: 0 });
/** Outcomes over every comment, and per kind (`above`, `inside`) over comments in files that changed. */
const totals = { all: empty(), changed: empty(), above: empty(), inside: empty() };
const diffSamples: { file: string; window: string; kind: string; before: string; after: string; moved: boolean }[] = [];
const renames: { file: string; from: string; to: string }[] = [];
const orphans: { file: string; kind: string; scope: string; before: string; kept: boolean }[] = [];

const history = git("rev-list", "--first-parent", "--reverse", "HEAD").trim().split("\n");
const last = history.length - STEPS - 1;
if (last < 0) throw new Error(`history has ${history.length} commits; need more than ${STEPS}`);
const count = Math.min(Number(args.windows), last + 1);
const starts = [...new Set(Array.from({ length: count }, (_, i) => Math.round((i * last) / Math.max(count - 1, 1))))];

for (const start of starts) {
  const base = history[start]!;
  const final = history[start + STEPS]!;
  const files = git("ls-tree", "-r", "--name-only", base)
    .trim()
    .split("\n")
    .filter((f) => f.startsWith(args.paths) && languageForPath(f)?.functionTypes.length);
  const texts = blobs([...files.map((f) => `${base}:${f}`), ...files.map((f) => `${final}:${f}`)]);
  for (const file of files) {
    const spec = languageForPath(file)!;
    const text = texts.get(`${base}:${file}`);
    if (text === undefined || text.includes("\r")) continue;
    const recorded = await recordComments(file, await withSyntheticComments(spec, text), { preamble: "", entries: [] });
    const sidecar: Sidecar = recorded.sidecar;
    if (!sidecar.entries.length) continue;
    const now = texts.get(`${final}:${file}`);
    const changed = now !== text;
    const tally = (outcome: Outcome, kind: string) => {
      totals.all[outcome]++;
      if (!changed) return;
      totals.changed[outcome]++;
      totals[kind === "above" ? "above" : "inside"][outcome]++;
    };
    const kindOf = (body: string) => body.split(" ")[1]!;
    if (now === undefined) {
      for (const entry of sidecar.entries) tally("deleted", kindOf(entry.body));
      continue;
    }
    const placed = await placeComments(file, now, sidecar);
    const stale = new Set(placed.stale.map((s) => s.id));
    const renamed = new Set(placed.renamed);
    for (const entry of sidecar.entries) {
      const kind = kindOf(entry.body);
      if (placed.unplaced.includes(entry.id)) {
        tally("orphan", kind);
        const before = codeAfter(recorded.source, spec.lineSigil, entry.id);
        orphans.push({ file, kind, scope: entry.meta.get("scope") ?? "(module)", before, kept: now.includes(before) });
      }
      else if (renamed.has(entry.id)) {
        tally("rename", kind);
        renames.push({ file, from: entry.meta.get("scope") ?? "", to: codeAfter(placed.source, spec.lineSigil, entry.id) });
      } else if (stale.has(entry.id)) {
        tally("diff", kind);
        const before = codeAfter(recorded.source, spec.lineSigil, entry.id);
        const after = codeAfter(placed.source, spec.lineSigil, entry.id);
        diffSamples.push({ file, window: base.slice(0, 7), kind, before, after, moved: before !== after });
      } else tally("exact", kind);
    }
  }
}

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
for (let i = 0; i < Math.min(12, kept.length); i++) {
  const o = kept[Math.floor((i * kept.length) / Math.min(12, kept.length))]!;
  console.log(`  ${o.file} (${o.kind}, scope ${o.scope}): ${o.before}`);
}

// Every nth diff placement, so the sample spreads over windows and files.
const take = Math.min(Number(args.sample), diffSamples.length);
console.log(`\nsample of ${take} diff placements (old code | new code; = when unchanged):`);
for (let i = 0; i < take; i++) {
  const s = diffSamples[Math.floor((i * diffSamples.length) / take)]!;
  console.log(`  [${i + 1}] ${s.window} ${s.file} (${s.kind})\n      old: ${s.before}\n      new: ${s.moved ? s.after : "="}`);
}
