#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { BRAND, SIDECAR_ROOT, STALE_TAG, mergeSidecars, parseSidecar, serializeSidecar } from "@slopstash/core";
import { check, formatCheck } from "./check.js";
import { collapseFiles, confirmIds, expandFiles, filterContent, promotableIds, promoteIds, readSidecar, selectFiles, staleIn, syncFiles } from "./files.js";
import { ADAPTERS } from "./adapters.js";
import { repoRoot, smudges, toRepoPath, trackedFiles } from "./git.js";
import { runHook } from "./hook.js";
import { agentsSnippet, planInit, planUninstall, runPlan } from "./init.js";
import { serveFilterProcess } from "./process.js";
import { applyReview, demote, formatApply, formatReview, markAll, parseReview, scan } from "./scan.js";
import { tag, tagTargets } from "./tag.js";
import { addWorktree } from "./worktree.js";

const USAGE = `usage: ${BRAND} <command>

  init [--command <cli>] [--one-shot] [--hooks <harness,...>] [--agents-md] [--dry-run]
                                configure the filter, merge driver, .gitattributes, and pre-commit
                                hook, printing each change; --one-shot runs a process per file
                                instead of one per git command; --hooks installs post-edit adapters
                                (${Object.keys(ADAPTERS).join(", ")}); --agents-md writes the sigil
                                convention into AGENTS.md; --dry-run prints without changing
  uninstall [--dry-run]         undo init, adapters and AGENTS.md included; sidecars and markers stay
  worktree add <git args...>    add a worktree whose checkout shows full comments
  sync [--staged] [--add] [files...]
                                move comment bodies into sidecars and stamp new ids
  expand [files...]             show full comments in working files
  collapse [files...]           reduce working files to bare markers
  scan [--json] [--all] [files...]
                                list likely AI comments; --all adds detectors that ship disabled
  scan --apply <review.json|->  convert the accepted comments of a reviewed \`scan --json\` list to
                                sigil comments and ignore the rejected ones, then sync
  scan --mark-all [files...]    convert every unprotected comment, detectors or not
  tag [--changed] [--by <harness>] [--model <m>] [--session <id>] [files...]
                                turn comments new since the index into sigil comments and sync,
                                recording the provenance given; --changed adds every edited file
  check [--staged] [--fix] [--json] [files...]
                                check what is committed (the index): comments committed with
                                their text, markers without bodies, bodies without markers;
                                --fix moves bodies after renames and drops unreferenced ones;
                                exits 1 when problems remain
  check --stale [--json] [files...]
                                list comments whose code changed while their body did not;
                                exits 1 when any are found
  confirm <id|file:id>...       accept the current code for a stale comment, clearing its flag
  promote <id|file:id>... | --all [files...]
                                turn AI comments into ordinary committed comments
  demote <file:line>...         move the ordinary comment on that line into the sidecar
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

/** Git runs filters from the worktree root and passes a root-relative path. */
async function runFilter(mode: "clean" | "smudge", file: string | undefined): Promise<void> {
  if (!file) throw new Error(`${mode} needs the path git passes as %f`);
  const output = await filterContent(mode, process.cwd(), file, await readStdin());
  await new Promise<void>((resolve, reject) => process.stdout.write(output, (err) => (err ? reject(err) : resolve())));
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
  throw new Error(files.length ? `${arg} is in several files; name one as <file>:${arg}: ${files.join(", ")}` : `no comment ${arg}`);
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "clean":
    case "smudge":
      return runFilter(command, rest[0]);
    case "filter-process": {
      const { values } = parseArgs({ args: rest, options: { smudge: { type: "boolean", default: false } } });
      const log = (message: string) => process.stderr.write(`${BRAND}: ${message}\n`);
      return serveFilterProcess(process.stdin, process.stdout, { root: process.cwd(), smudge: values.smudge, log });
    }
    case "sync": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { staged: { type: "boolean", default: false }, add: { type: "boolean", default: false } },
      });
      const root = repoRoot();
      return syncFiles(root, selectFiles(root, { files: positionals, staged: values.staged }), { add: values.add });
    }
    case "expand":
    case "collapse": {
      const root = repoRoot();
      const files = selectFiles(root, { files: rest, staged: false });
      return command === "expand" ? expandFiles(root, files) : collapseFiles(root, files);
    }
    case "scan": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          json: { type: "boolean", default: false },
          all: { type: "boolean", default: false },
          apply: { type: "string" },
          "mark-all": { type: "boolean", default: false },
        },
      });
      const root = repoRoot();
      if (values.apply !== undefined) {
        const text = values.apply === "-" ? (await readStdin()).toString("utf8") : readFileSync(values.apply, "utf8");
        process.stdout.write(formatApply(await applyReview(root, parseReview(text))));
        return;
      }
      if (values["mark-all"]) {
        process.stdout.write(formatApply(await markAll(root, positionals)));
        return;
      }
      const review = await scan(root, positionals, { all: values.all });
      process.stdout.write(values.json ? JSON.stringify(review, null, 2) + "\n" : formatReview(review));
      return;
    }
    case "tag": {
      const { values, positionals } = parseArgs({
        args: rest,
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
      return;
    }
    case "check": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          stale: { type: "boolean", default: false },
          json: { type: "boolean", default: false },
          staged: { type: "boolean", default: false },
          fix: { type: "boolean", default: false },
        },
      });
      const root = repoRoot();
      if (!values.stale) {
        const report = await check(root, { files: positionals, staged: values.staged, fix: values.fix });
        process.stdout.write(values.json ? JSON.stringify(report, null, 2) + "\n" : formatCheck(report));
        if (report.problems.length) process.exitCode = 1;
        return;
      }
      const stale = await staleIn(root, selectFiles(root, { files: positionals, staged: false }));
      const rows = stale.map((s) => ({ file: s.file, line: s.line, id: s.id, text: s.body }));
      if (values.json) process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      else for (const r of rows) console.log(`${r.file}:${r.line}: ${r.id} ${STALE_TAG} ${r.text.split("\n")[0]}`);
      if (rows.length) process.exitCode = 1;
      return;
    }
    case "confirm":
    case "promote": {
      const all = command === "promote" && rest[0] === "--all";
      if (!rest.length) throw new Error(`${command} needs one or more ids (<id> or <file>:<id>)`);
      const root = repoRoot();
      const byFile = new Map<string, string[]>();
      if (all) {
        for (const file of selectFiles(root, { files: rest.slice(1), staged: false })) {
          const ids = await promotableIds(root, file);
          if (ids.length) byFile.set(file, ids);
        }
        if (!byFile.size) console.log("no AI comments to promote");
      }
      for (const arg of all ? [] : rest) {
        const [file, id] = await locateId(root, arg);
        byFile.set(file, [...(byFile.get(file) ?? []), id]);
      }
      const expand = smudges(root);
      const run = command === "confirm" ? confirmIds : promoteIds;
      for (const [file, ids] of byFile) {
        const missing = await run(root, file, ids, expand);
        if (missing.length) throw new Error(`no comment ${missing.join(", ")} in ${file}`);
        console.log(`${command === "confirm" ? "confirmed" : "promoted"} ${ids.join(", ")} in ${file}`);
      }
      return;
    }
    case "demote": {
      if (!rest.length) throw new Error("demote needs one or more <file>:<line>");
      const root = repoRoot();
      const targets = rest.map((arg) => {
        const split = /^(.+):([1-9][0-9]*)$/.exec(arg);
        if (!split) throw new Error(`expected <file>:<line>, got ${arg}`);
        return { file: toRepoPath(root, split[1]!), line: Number(split[2]) };
      });
      const report = await demote(root, targets);
      console.log(`demoted ${report.converted.length} comment(s) in ${report.files.length} file(s)`);
      return;
    }
    case "hook": {
      if (!rest[0]) throw new Error(`hook needs a harness: ${Object.keys(ADAPTERS).join(", ")}`);
      await runHook(rest[0], (await readStdin()).toString("utf8"));
      return;
    }
    case "agents-md":
      process.stdout.write(agentsSnippet());
      return;
    case "init": {
      const { values } = parseArgs({
        args: rest,
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
      return;
    }
    case "uninstall": {
      const { values } = parseArgs({ args: rest, options: { "dry-run": { type: "boolean", default: false } } });
      const root = repoRoot();
      for (const line of runPlan(planUninstall(root), values["dry-run"])) console.log(line);
      const kept = trackedFiles(root).filter((f) => f.startsWith(`${SIDECAR_ROOT}/`)).length;
      if (kept) console.log(`note: ${kept} sidecar file(s) under ${SIDECAR_ROOT}/ and their markers stay; \`${BRAND} promote --all\` before uninstalling turns them into ordinary comments`);
      return;
    }
    case "merge-sidecar": {
      const [base, ours, theirs] = rest;
      if (!base || !ours || !theirs) throw new Error("merge-sidecar needs the %O %A %B paths git passes");
      const read = (file: string) => parseSidecar(readFileSync(file, "utf8"));
      const result = mergeSidecars(read(base), read(ours), read(theirs));
      writeFileSync(ours, serializeSidecar(result.sidecar));
      if (result.conflicts.length) {
        process.stderr.write(`${BRAND}: both sides changed ${result.conflicts.join(", ")}; resolve the conflict markers in the body\n`);
        process.exitCode = 1;
      }
      return;
    }
    case "worktree": {
      if (rest[0] !== "add") throw new Error("only `worktree add` is supported");
      console.log(`worktree ready: ${addWorktree(repoRoot(), rest.slice(1))}`);
      return;
    }
    default:
      process.stdout.write(USAGE);
      if (command && command !== "help" && command !== "--help") process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`${BRAND}: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
