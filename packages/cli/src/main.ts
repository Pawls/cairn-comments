#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { BRAND, SIDECAR_ROOT, STALE_TAG, mergeSidecars, parseSidecar, serializeSidecar } from "@cairn-comments/core";
import { check, formatCheck } from "./check.js";
import {
  collapseFiles,
  confirmIds,
  expandFiles,
  filterContent,
  filterMode,
  refreshFiles,
  promotableIds,
  promoteIds,
  readSidecar,
  selectFiles,
  staleIn,
  syncFiles,
} from "./files.js";
import { ADAPTERS } from "./adapters.js";
import { repoRoot, smudges, toRepoPath, trackedFiles } from "./git.js";
import { runHook } from "./hook.js";
import { agentsSnippet, planInit, planUninstall, runPlan } from "./init.js";
import { serveFilterProcess } from "./process.js";
import { applyReview, demote, formatApply, formatReview, markAll, parseReview, scan } from "./scan.js";
import { tag, tagTargets } from "./tag.js";
import { captureWrites, capturedWrites } from "./workfiles.js";
import { addWorktree } from "./worktree.js";

const USAGE = `usage: ${BRAND} <command>

  init [--command <cli>] [--one-shot] [--hooks <harness,...>] [--agents-md] [--dry-run]
                                configure the filter, merge driver, .gitattributes, and pre-commit
                                hook, printing each change; --one-shot runs a process per file
                                instead of one per git command; --hooks installs post-edit adapters
                                (${Object.keys(ADAPTERS).join(", ")}); --agents-md writes the sigil
                                convention into AGENTS.md; --dry-run prints without changing
  uninstall [--dry-run]         undo init, adapters and AGENTS.md included; sidecars stay
  worktree add <git args...>    add a worktree whose checkout shows full comments
  sync [--staged] [--add] [files...]
                                record where each comment sits and its text in the sidecars,
                                stamping ids onto new comments
  expand [files...]             place every comment in the working files
  collapse [files...]           remove the comments from the working files
  refresh                       in an agent worktree, place the comments of every file
                                with a sidecar (run by the post-checkout, post-merge,
                                post-commit, and post-rewrite hooks)
  scan [--json] [--all] [files...]
                                list likely AI comments; --all adds detectors that ship disabled
  scan --apply <review.json|->  convert the accepted comments of a reviewed \`scan --json\` list to
                                sigil comments and ignore the rejected ones, then sync
  scan --mark-all [files...]    convert every unprotected comment, detectors or not
  tag [--changed] [--by <harness>] [--model <m>] [--session <id>] [files...]
                                turn comments new since the index into sigil comments and sync,
                                recording the provenance given; --changed adds every edited file
  check [--staged] [--fix] [--json] [files...]
                                check what is committed (the index): sigil comments committed
                                in the code, and sidecars whose source is gone; --fix moves a
                                renamed file's sidecar and drops a deleted file's; exits 1
                                when problems remain
  check --stale [--json] [files...]
                                list comments whose code changed while their body did not;
                                exits 1 when any are found
  check --orphans [--json] [files...]
                                list comments that no longer place in their code, with their
                                last known declaration; exits 1 when any are found
  check --fix --prune [files...]
                                remove those comments from their sidecars
  confirm <id|file:id>...       accept the current code for a stale comment, clearing its flag
  promote <id|file:id>... | --all [files...]
                                turn AI comments into ordinary committed comments
  demote [--print] <file:line>...
                                move the ordinary comment on that line into the sidecar;
                                --print (here and on scan --apply) prints {report, files}
                                with each file's new contents instead of writing them
  hook <harness>                run a harness's post-edit hook payload (stdin) through \`tag\`
  agents-md                     print the sigil convention snippet for an agent instruction file
  clean <path>, smudge <path>   one-shot git filter endpoints (stdin to stdout)
  filter-process [--smudge]     git long-running filter process (filter.<driver>.process)
  merge-sidecar <O> <A> <B>     git merge driver for sidecars (merge.<driver>.driver)
`;

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/** Git runs filters from the worktree root and passes a root-relative path. */
async function runFilter(mode: "clean" | "smudge", file: string | undefined): Promise<void> {
  if (!file) throw new Error(`${mode} needs the path git passes as %f`);
  const output = await filterContent(mode, process.cwd(), file, await readStdin(), filterMode(process.cwd(), mode === "smudge"));
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(output, (err) => (err ? reject(err) : resolve()));
  });
}

async function runFilterProcess(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { smudge: { type: "boolean", default: false } } });
  const log = (message: string) => process.stderr.write(`${BRAND}: ${message}\n`);
  const root = process.cwd();
  return serveFilterProcess(process.stdin, process.stdout, { root, smudge: values.smudge, mode: filterMode(root, values.smudge), log });
}

async function runSync(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { staged: { type: "boolean", default: false }, add: { type: "boolean", default: false } },
  });
  const root = repoRoot();
  return syncFiles(root, selectFiles(root, { files: positionals, staged: values.staged }), { add: values.add });
}

async function runRewrite(args: string[], rewrite: (root: string, files: string[]) => Promise<void>): Promise<void> {
  const root = repoRoot();
  return rewrite(root, selectFiles(root, { files: args, staged: false }));
}

async function runScan(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      apply: { type: "string" },
      print: { type: "boolean", default: false },
      "mark-all": { type: "boolean", default: false },
    },
  });
  const root = repoRoot();
  if (values.apply !== undefined) {
    const text = values.apply === "-" ? (await readStdin()).toString("utf8") : readFileSync(values.apply, "utf8");
    await printingIf(values.print, root, async () => formatApply(await applyReview(root, parseReview(text))));
    return;
  }
  if (values["mark-all"]) {
    process.stdout.write(formatApply(await markAll(root, positionals)));
    return;
  }
  const review = await scan(root, positionals, { all: values.all });
  if (values.json) printJson(review);
  else process.stdout.write(formatReview(review));
}

async function runTag(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      changed: { type: "boolean", default: false },
      by: { type: "string" },
      model: { type: "string" },
      session: { type: "string" },
    },
  });
  const root = repoRoot();
  const named = positionals.map((f) => toRepoPath(root, f));
  const report = await tag(root, tagTargets(root, named, values.changed), values);
  console.log(`tagged ${report.tagged} comment(s); synced ${report.files.length} file(s)`);
}

async function runCheck(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      stale: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      staged: { type: "boolean", default: false },
      fix: { type: "boolean", default: false },
      orphans: { type: "boolean", default: false },
      prune: { type: "boolean", default: false },
    },
  });
  if (values.prune && !values.fix) throw new Error("--prune removes entries only together with --fix");
  const root = repoRoot();
  if (values.stale) return runStaleCheck(root, positionals, values.json);
  const report = await check(root, { files: positionals, staged: values.staged, fix: values.fix, orphans: values.orphans, prune: values.prune });
  if (values.json) printJson(report);
  else process.stdout.write(formatCheck(report));
  if (report.problems.length) process.exitCode = 1;
}

async function runStaleCheck(root: string, files: string[], json: boolean): Promise<void> {
  const stale = await staleIn(root, selectFiles(root, { files, staged: false }));
  const rows = stale.map((s) => ({ file: s.file, line: s.line, id: s.id, text: s.body }));
  if (json) {
    printJson(rows);
  } else {
    for (const r of rows) console.log(`${r.file}:${r.line}: ${r.id} ${STALE_TAG} ${r.text.split("\n")[0]}`);
  }
  if (rows.length) process.exitCode = 1;
}

/** `<file>:<id>`, or a bare id found in exactly one sidecar. */
async function locateId(root: string, arg: string): Promise<[string, string]> {
  const split = /^(.+):([0-9a-z]{4})$/.exec(arg);
  if (split) return [toRepoPath(root, split[1]!), split[2]!];
  const files: string[] = [];
  for (const file of selectFiles(root, { files: [], staged: false })) {
    if ((await readSidecar(root, file)).entries.some((e) => e.id === arg)) files.push(file);
  }
  if (files.length === 1) return [files[0]!, arg];
  if (!files.length) throw new Error(`no comment ${arg}`);
  throw new Error(`${arg} is in several files; name one as <file>:${arg}: ${files.join(", ")}`);
}

/** Ids named on the command line, grouped by the file that holds each. */
async function idsByFile(root: string, args: string[]): Promise<Map<string, string[]>> {
  const byFile = new Map<string, string[]>();
  for (const arg of args) {
    const [file, id] = await locateId(root, arg);
    byFile.set(file, [...(byFile.get(file) ?? []), id]);
  }
  return byFile;
}

type IdAction = (root: string, file: string, ids: string[], expand: boolean) => Promise<string[]>;

async function applyToIds(root: string, byFile: Map<string, string[]>, action: IdAction, done: string): Promise<void> {
  const expand = smudges(root);
  for (const [file, ids] of byFile) {
    const missing = await action(root, file, ids, expand);
    if (missing.length) throw new Error(`no comment ${missing.join(", ")} in ${file}`);
    console.log(`${done} ${ids.join(", ")} in ${file}`);
  }
}

async function runConfirm(args: string[]): Promise<void> {
  if (!args.length) throw new Error("confirm needs one or more ids (<id> or <file>:<id>)");
  const root = repoRoot();
  await applyToIds(root, await idsByFile(root, args), confirmIds, "confirmed");
}

async function runPromote(args: string[]): Promise<void> {
  if (!args.length) throw new Error("promote needs one or more ids (<id> or <file>:<id>)");
  const root = repoRoot();
  if (args[0] !== "--all") {
    await applyToIds(root, await idsByFile(root, args), promoteIds, "promoted");
    return;
  }
  const byFile = new Map<string, string[]>();
  for (const file of selectFiles(root, { files: args.slice(1), staged: false })) {
    const ids = await promotableIds(root, file);
    if (ids.length) byFile.set(file, ids);
  }
  if (!byFile.size) console.log("no AI comments to promote");
  await applyToIds(root, byFile, promoteIds, "promoted");
}

async function runDemote(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { print: { type: "boolean", default: false } } });
  if (!positionals.length) throw new Error("demote needs one or more <file>:<line>");
  const root = repoRoot();
  const targets = positionals.map((arg) => {
    const split = /^(.+):([1-9]\d*)$/.exec(arg);
    if (!split) throw new Error(`expected <file>:<line>, got ${arg}`);
    return { file: toRepoPath(root, split[1]!), line: Number(split[2]) };
  });
  await printingIf(values.print, root, async () => {
    const report = await demote(root, targets);
    return `demoted ${report.converted.length} comment(s) in ${report.files.length} file(s)\n`;
  });
}

/**
 * Runs a rewrite and prints its report. With `print`, nothing is written: stdout is
 * `{report, files}`, each file's new contents by repository path (null to delete it).
 */
async function printingIf(print: boolean, root: string, rewrite: () => Promise<string>): Promise<void> {
  if (!print) {
    process.stdout.write(await rewrite());
    return;
  }
  captureWrites();
  const report = await rewrite();
  printJson({ report, files: capturedWrites(root) });
}

async function runHookCommand(args: string[]): Promise<void> {
  if (!args[0]) throw new Error(`hook needs a harness: ${Object.keys(ADAPTERS).join(", ")}`);
  await runHook(args[0], (await readStdin()).toString("utf8"));
}

function runAgentsMd(): void {
  process.stdout.write(agentsSnippet());
}

function runInit(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      command: { type: "string" },
      "one-shot": { type: "boolean", default: false },
      hooks: { type: "string" },
      "agents-md": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const hooks = values.hooks?.split(",").map((h) => h.trim()).filter(Boolean);
  const options = { command: values.command, oneShot: values["one-shot"], hooks, agentsMd: values["agents-md"] };
  for (const line of runPlan(planInit(repoRoot(), options), values["dry-run"])) console.log(line);
}

function runUninstall(args: string[]): void {
  const { values } = parseArgs({ args, options: { "dry-run": { type: "boolean", default: false } } });
  const root = repoRoot();
  for (const line of runPlan(planUninstall(root), values["dry-run"])) console.log(line);
  const kept = trackedFiles(root).filter((f) => f.startsWith(`${SIDECAR_ROOT}/`)).length;
  if (kept) {
    console.log(
      `note: ${kept} sidecar file(s) under ${SIDECAR_ROOT}/ stay; ` +
        `\`${BRAND} promote --all\` before uninstalling turns them into ordinary comments`,
    );
  }
}

function runMergeSidecar(args: string[]): void {
  const [base, ours, theirs] = args;
  if (!base || !ours || !theirs) throw new Error("merge-sidecar needs the %O %A %B paths git passes");
  const read = (file: string) => parseSidecar(readFileSync(file, "utf8"));
  const result = mergeSidecars(read(base), read(ours), read(theirs));
  writeFileSync(ours, serializeSidecar(result.sidecar));
  if (result.conflicts.length) {
    const ids = result.conflicts.join(", ");
    process.stderr.write(`${BRAND}: both sides changed ${ids}; resolve the conflict markers in the body\n`);
    process.exitCode = 1;
  }
}

/** Places comments that a git operation brought in without smudging their source. */
async function runRefresh(): Promise<void> {
  const root = repoRoot();
  if (!smudges(root)) return;
  await refreshFiles(root);
}

function runWorktree(args: string[]): void {
  if (args[0] !== "add") throw new Error("only `worktree add` is supported");
  console.log(`worktree ready: ${addWorktree(repoRoot(), args.slice(1))}`);
}

const COMMANDS = new Map<string, (args: string[]) => void | Promise<void>>([
  ["clean", (args) => runFilter("clean", args[0])],
  ["smudge", (args) => runFilter("smudge", args[0])],
  ["filter-process", runFilterProcess],
  ["sync", runSync],
  ["expand", (args) => runRewrite(args, expandFiles)],
  ["collapse", (args) => runRewrite(args, collapseFiles)],
  ["refresh", runRefresh],
  ["scan", runScan],
  ["tag", runTag],
  ["check", runCheck],
  ["confirm", runConfirm],
  ["promote", runPromote],
  ["demote", runDemote],
  ["hook", runHookCommand],
  ["agents-md", runAgentsMd],
  ["init", runInit],
  ["uninstall", runUninstall],
  ["merge-sidecar", runMergeSidecar],
  ["worktree", runWorktree],
]);

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const run = command === undefined ? undefined : COMMANDS.get(command);
  if (run) return run(rest);
  process.stdout.write(USAGE);
  if (command && command !== "help" && command !== "--help") process.exitCode = 2;
}

try {
  await main(process.argv.slice(2));
} catch (error: unknown) {
  console.error(`${BRAND}: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
