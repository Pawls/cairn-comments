/**
 * Filter overhead benchmark (plan A4): a generated repo of marked source files, timed for
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
const MARKERS_PER_FILE = 6;

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/cli/dist/main.js");
const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "slopstash-bench-")));
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

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** Collapsed sources plus sidecars, as they sit in blobs; half Python, half TypeScript. */
function generate(root: string): void {
  let serial = 0;
  for (let i = 0; i < FILES; i++) {
    const python = i % 2 === 0;
    const sigil = python ? "#~" : "//~";
    const file = `src/m${Math.floor(i / 100)}/f${i}.${python ? "py" : "ts"}`;
    const lines: string[] = [];
    const bodies: string[] = [];
    for (let j = 0; j < MARKERS_PER_FILE / 2; j++) {
      const own = (serial++).toString(36).padStart(4, "0");
      const trailing = (serial++).toString(36).padStart(4, "0");
      bodies.push(`## ${own}\nwhy step ${j} of file ${i} runs before the next one\nand what breaks if it does not\n`);
      bodies.push(`## ${trailing}\nthe value ${j} is load-bearing\n`);
      if (python) {
        lines.push(`def step_${j}(x):`, `    ${sigil}${own}`, `    y = x + ${j}`, `    return y  ${sigil}${trailing}`, "", "");
      } else {
        lines.push(`export function step${j}(x: number): number {`, `  ${sigil}${own}`, `  const y = x + ${j};`, `  return y; ${sigil}${trailing}`, "}", "");
      }
    }
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), lines.join("\n"));
    mkdirSync(path.dirname(path.join(root, ".agents/comments", file)), { recursive: true });
    writeFileSync(path.join(root, ".agents/comments", `${file}.md`), bodies.join("\n"));
  }
}

type Mode = "off" | "one-shot" | "process";

/** Repo-wide config for a mode; `init` writes it exactly as a user's repo would get it. */
function configure(repo: string, mode: Mode): void {
  if (mode === "off") {
    for (const key of ["clean", "process"]) spawnSync("git", ["config", "--unset", `filter.slopstash.${key}`], { cwd: repo, env });
  } else {
    cli(repo, "init", ...(mode === "one-shot" ? ["--one-shot"] : []));
  }
}

/** A worktree with the per-worktree config `worktree add` writes, then a timed checkout. */
function checkout(repo: string, mode: Mode, name: string): { wt: string; ms: number } {
  const wt = path.join(dir, name);
  git(repo, "worktree", "add", "-q", "--no-checkout", "--detach", wt);
  if (mode !== "off") {
    const command = git(repo, "config", "--get", "filter.slopstash.clean").trim().slice(0, -" clean %f".length);
    git(wt, "config", "--worktree", "filter.slopstash.smudge", `${command} smudge %f`);
    if (mode === "process") git(wt, "config", "--worktree", "filter.slopstash.process", `${command} filter-process --smudge`);
  }
  const ms = timed(() => git(wt, "reset", "--hard", "-q"));
  return { wt, ms };
}

const repo = path.join(dir, "repo");
mkdirSync(repo);
git(repo, "init", "-q");
generate(repo);
cli(repo, "init");
git(repo, "add", "-A");
git(repo, "commit", "-qm", "generated");

const results: Record<Mode, { checkout: number[]; firstStatus: number[]; warmStatus: number[] }> = {
  off: { checkout: [], firstStatus: [], warmStatus: [] },
  "one-shot": { checkout: [], firstStatus: [], warmStatus: [] },
  process: { checkout: [], firstStatus: [], warmStatus: [] },
};
let expanded = "";
for (const mode of ["off", "process", "one-shot"] as const) {
  configure(repo, mode);
  const runs = mode === "one-shot" ? ONE_SHOT_RUNS : RUNS;
  for (let r = 0; r < runs; r++) {
    const { wt, ms } = checkout(repo, mode, `${mode}-${r}`);
    results[mode].checkout.push(ms);
    // The first status after a checkout re-cleans racily clean entries and refreshes the
    // index. Entries stay racy while the index shares their mtime second, so "warm" is
    // measured after one more status issued a second later has settled them.
    results[mode].firstStatus.push(timed(() => git(wt, "status", "--porcelain")));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
    git(wt, "status", "--porcelain");
    const warm = [0, 1, 2].map(() => timed(() => git(wt, "status", "--porcelain")));
    results[mode].warmStatus.push(median(warm));
    const dirty = git(wt, "status", "--porcelain");
    if (dirty) throw new Error(`${mode}: worktree not clean after checkout:\n${dirty.slice(0, 500)}`);
    if (mode === "process" && r === 0) expanded = git(wt, "grep", "-c", "load-bearing", "--", "src/m0/f0.py").trim();
    git(repo, "worktree", "remove", "--force", wt);
  }
}
if (!expanded.endsWith(":3")) throw new Error(`process mode did not expand markers (grep: ${JSON.stringify(expanded)})`);

const fmt = (ms: number) => `${Math.round(ms)} ms`;
const off = { checkout: median(results.off.checkout), warm: median(results.off.warmStatus) };
console.log(`\n${FILES} files, ${MARKERS_PER_FILE} markers each, autocrlf=${args.autocrlf}, ${os.platform()} ${os.release()}, git ${git(repo, "--version").trim().split(" ")[2]}, node ${process.version}`);
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

if (args.keep) console.log(`kept ${dir}`);
else rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
