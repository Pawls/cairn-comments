/**
 * Filter overhead benchmark (design.md § Filter process): a generated repo of commented source files, timed for
 * a full checkout into a smudging worktree and for `git status`, with the filter off,
 * one-shot, and as a long-running process. Run through `npm run bench`, which builds first.
 *
 *   node scripts/bench.ts [--files 2000] [--runs 3] [--one-shot-runs 1] [--autocrlf] [--keep]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { recordComments, serializeSidecar, stripComments } from "../packages/core/dist/index.js";

const { values: args } = parseArgs({
  options: {
    files: { type: "string", default: "2000" },
    runs: { type: "string", default: "3" },
    "one-shot-runs": { type: "string", default: "1" },
    autocrlf: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
  },
});
const FILES = Number(args.files);
const RUNS = Number(args.runs);
const ONE_SHOT_RUNS = Number(args["one-shot-runs"]);
/** Each generated file holds this many functions, each with an own-line comment block and a trailing comment. */
const FUNCTIONS_PER_FILE = 3;
const COMMENTS_PER_FILE = FUNCTIONS_PER_FILE * 2;
/** Warm status is the median of this many `git status` runs. */
const WARM_STATUS_RUNS = 3;
/** Longer than the one-second mtime granularity of git's index (design.md § Filter process, "Racy entries"). */
const RACY_WAIT_MS = 1100;

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/cli/bundle/main.js");
const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "cairn-bench-")));
const globalConfig = path.join(dir, "gitconfig");
writeFileSync(
  globalConfig,
  `[user]\n\tname = bench\n\temail = bench@example.com\n[core]\n\tautocrlf = ${args.autocrlf}\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n`,
);
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: globalConfig,
  GIT_CONFIG_NOSYSTEM: "1",
};

function run(cwd: string, command: string, argv: string[]): string {
  const result = spawnSync(command, argv, { cwd, env, encoding: "utf8", maxBuffer: 1 << 28 });
  if (result.status !== 0) throw new Error(`${command} ${argv.join(" ")} failed:\n${result.stderr}`);
  return result.stdout;
}
const git = (cwd: string, ...argv: string[]) => run(cwd, "git", argv);
const cli = (cwd: string, ...argv: string[]) => run(cwd, process.execPath, [CLI, ...argv]);

function timed(fn: () => void): number {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** One function of a generated file: an own-line block of two comment lines, and a trailing comment. */
function functionLines(python: boolean, fileIndex: number, step: number): string[] {
  const sigil = python ? "#~" : "//~";
  const why = `${sigil} why step ${step} of file ${fileIndex} runs before the next one`;
  const more = `${sigil} and what breaks if it does not`;
  const trailing = `${sigil} the value ${step} is load-bearing`;
  if (python) {
    return [`def step_${step}(x):`, `    ${why}`, `    ${more}`, `    y = x + ${step}`, `    return y  ${trailing}`, "", ""];
  }
  return [`export function step${step}(x: number): number {`, `  ${why}`, `  ${more}`, `  const y = x + ${step};`, `  return y; ${trailing}`, "}", ""];
}

/** Sources without their comments plus the sidecars `sync` records, as they sit in blobs; half Python, half TypeScript. */
async function generate(root: string): Promise<void> {
  for (let i = 0; i < FILES; i++) {
    const python = i % 2 === 0;
    const file = `src/m${Math.floor(i / 100)}/f${i}.${python ? "py" : "ts"}`;
    const lines = Array.from({ length: FUNCTIONS_PER_FILE }, (_, step) => functionLines(python, i, step)).flat();
    const recorded = await recordComments(file, lines.join("\n"), { preamble: "", entries: [] });
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), await stripComments(file, recorded.source));
    mkdirSync(path.dirname(path.join(root, ".agents/comments", file)), { recursive: true });
    writeFileSync(path.join(root, ".agents/comments", `${file}.md`), serializeSidecar(recorded.sidecar));
  }
}

type Mode = "off" | "one-shot" | "process";

/** Repo-wide config for a mode; `init` writes it exactly as a user's repo would get it. */
function configure(repo: string, mode: Mode): void {
  if (mode === "off") {
    for (const key of ["clean", "process"]) spawnSync("git", ["config", "--unset", `filter.cairn.${key}`], { cwd: repo, env });
  } else {
    cli(repo, "init", ...(mode === "one-shot" ? ["--one-shot"] : []));
  }
}

/** A worktree with the per-worktree config `worktree add` writes, then a timed checkout. */
function checkout(repo: string, mode: Mode, name: string): { wt: string; ms: number } {
  const wt = path.join(dir, name);
  git(repo, "worktree", "add", "-q", "--no-checkout", "--detach", wt);
  if (mode !== "off") {
    const command = git(repo, "config", "--get", "filter.cairn.clean").trim().slice(0, -" clean %f".length);
    git(wt, "config", "--worktree", "filter.cairn.smudge", `${command} smudge %f`);
    if (mode === "process") git(wt, "config", "--worktree", "filter.cairn.process", `${command} filter-process --smudge`);
  }
  const ms = timed(() => git(wt, "reset", "--hard", "-q"));
  return { wt, ms };
}

/** Milliseconds per run of each measurement, and in process mode what `git grep` found in the first checkout. */
interface Timings {
  checkout: number[];
  firstStatus: number[];
  warmStatus: number[];
  expanded?: string;
}

const emptyTimings = (): Timings => ({ checkout: [], firstStatus: [], warmStatus: [] });

/** One checkout and the status runs after it, recorded into `into`; the worktree is removed afterwards. */
function measureRun(repo: string, mode: Mode, runIndex: number, into: Timings): void {
  const { wt, ms } = checkout(repo, mode, `${mode}-${runIndex}`);
  into.checkout.push(ms);
  // The first status after a checkout re-cleans racily clean entries and refreshes the
  // index. Entries stay racy while the index shares their mtime second, so "warm" is
  // measured after one more status issued a second later has settled them.
  into.firstStatus.push(timed(() => git(wt, "status", "--porcelain")));
  sleepSync(RACY_WAIT_MS);
  git(wt, "status", "--porcelain");
  const warm = Array.from({ length: WARM_STATUS_RUNS }, () => timed(() => git(wt, "status", "--porcelain")));
  into.warmStatus.push(median(warm));
  const dirty = git(wt, "status", "--porcelain");
  if (dirty) throw new Error(`${mode}: worktree not clean after checkout:\n${dirty.slice(0, 500)}`);
  if (mode === "process" && runIndex === 0) into.expanded = git(wt, "grep", "-c", "load-bearing", "--", "src/m0/f0.py").trim();
  git(repo, "worktree", "remove", "--force", wt);
}

const fmt = (ms: number) => `${Math.round(ms)} ms`;

function printReport(repo: string, results: Record<Mode, Timings>): void {
  const off = { checkout: median(results.off.checkout), warm: median(results.off.warmStatus) };
  const gitVersion = git(repo, "--version").trim().split(" ")[2];
  console.log(
    `\n${FILES} files, ${COMMENTS_PER_FILE} comments each, autocrlf=${args.autocrlf}, ${os.platform()} ${os.release()}, git ${gitVersion}, node ${process.version}`,
  );
  console.log("medians; runs: off/process " + RUNS + ", one-shot " + ONE_SHOT_RUNS + "\n");
  console.log("| mode | checkout | vs off | first status | warm status | warm vs off |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const mode of ["off", "one-shot", "process"] as const) {
    if (!results[mode].checkout.length) continue;
    const c = median(results[mode].checkout);
    const w = median(results[mode].warmStatus);
    const pct = `${c >= off.checkout ? "+" : ""}${Math.round(((c - off.checkout) / off.checkout) * 100)}%`;
    console.log(`| ${mode} | ${fmt(c)} | ${pct} | ${fmt(median(results[mode].firstStatus))} | ${fmt(w)} | +${fmt(w - off.warm)} |`);
  }
  const processCheckout = median(results.process.checkout);
  const withinCheckout = processCheckout <= off.checkout * 1.2;
  const withinStatus = median(results.process.warmStatus) - off.warm < 1000;
  console.log(`\nbudget: checkout under +20%: ${withinCheckout ? "PASS" : "FAIL"}; warm status under +1 s: ${withinStatus ? "PASS" : "FAIL"}`);
}

const repo = path.join(dir, "repo");
mkdirSync(repo);
git(repo, "init", "-q");
await generate(repo);
cli(repo, "init");
git(repo, "add", "-A");
git(repo, "commit", "-qm", "generated");

const results: Record<Mode, Timings> = { off: emptyTimings(), "one-shot": emptyTimings(), process: emptyTimings() };
for (const mode of ["off", "process", "one-shot"] as const) {
  configure(repo, mode);
  const runs = mode === "one-shot" ? ONE_SHOT_RUNS : RUNS;
  for (let runIndex = 0; runIndex < runs; runIndex++) measureRun(repo, mode, runIndex, results[mode]);
}
// Each function's trailing comment is the one `git grep` counts in the first process-mode checkout.
const expanded = results.process.expanded ?? "";
if (!expanded.endsWith(`:${FUNCTIONS_PER_FILE}`)) {
  throw new Error(`process mode did not place the comments (grep: ${JSON.stringify(expanded)})`);
}

printReport(repo, results);

if (args.keep) console.log(`kept ${dir}`);
else rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
