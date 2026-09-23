#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { BRAND, STALE_TAG } from "@slopstash/core";
import { collapseFiles, confirmIds, expandFiles, filterContent, readSidecar, selectFiles, staleIn, syncFiles } from "./files.js";
import { ADAPTERS } from "./adapters.js";
import { repoRoot, smudges, toRepoPath } from "./git.js";
import { runHook } from "./hook.js";
import { agentsSnippet, init } from "./init.js";
import { serveFilterProcess } from "./process.js";
import { applyReview, formatApply, formatReview, markAll, parseReview, scan } from "./scan.js";
import { tag, tagTargets } from "./tag.js";
import { addWorktree } from "./worktree.js";

const USAGE = `usage: ${BRAND} <command>

  init [--command <cli>] [--one-shot] [--hooks <harness,...>] [--agents-md]
                                configure the filter, .gitattributes, and pre-commit hook;
                                --one-shot runs a process per file instead of one per git command;
                                --hooks installs post-edit adapters (${Object.keys(ADAPTERS).join(", ")});
                                --agents-md writes the sigil convention into AGENTS.md
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
  check [--stale] [--json] [files...]
                                list comments whose code changed while their body did not
                                (the only check so far); exits 1 when any are found
  confirm <id|file:id>...       accept the current code for a stale comment, clearing its flag
  hook <harness>                run a harness's post-edit hook payload (stdin) through \`tag\`
  agents-md                     print the sigil convention snippet for an agent instruction file
  clean <path>, smudge <path>   one-shot git filter endpoints (stdin to stdout)
  filter-process [--smudge]     git long-running filter process (filter.<driver>.process)
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
        options: { stale: { type: "boolean", default: false }, json: { type: "boolean", default: false } },
      });
      const root = repoRoot();
      const stale = await staleIn(root, selectFiles(root, { files: positionals, staged: false }));
      const rows = stale.map((s) => ({ file: s.file, line: s.line, id: s.id, text: s.body }));
      if (values.json) process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      else for (const r of rows) console.log(`${r.file}:${r.line}: ${r.id} ${STALE_TAG} ${r.text.split("\n")[0]}`);
      if (rows.length) process.exitCode = 1;
      return;
    }
    case "confirm": {
      if (!rest.length) throw new Error("confirm needs one or more ids (<id> or <file>:<id>)");
      const root = repoRoot();
      const byFile = new Map<string, string[]>();
      for (const arg of rest) {
        const [file, id] = await locateId(root, arg);
        byFile.set(file, [...(byFile.get(file) ?? []), id]);
      }
      const expand = smudges(root);
      for (const [file, ids] of byFile) {
        const missing = await confirmIds(root, file, ids, expand);
        if (missing.length) throw new Error(`no comment ${missing.join(", ")} in ${file}`);
        console.log(`confirmed ${ids.join(", ")} in ${file}`);
      }
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
        },
      });
      const hooks = values.hooks?.split(",").map((h) => h.trim()).filter(Boolean);
      const options = { command: values.command, oneShot: values["one-shot"], hooks, agentsMd: values["agents-md"] };
      for (const line of init(repoRoot(), options)) console.log(line);
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
