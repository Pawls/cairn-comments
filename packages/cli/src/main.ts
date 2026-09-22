#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { BRAND } from "@slopstash/core";
import { collapseFiles, expandFiles, filterContent, selectFiles, syncFiles } from "./files.js";
import { repoRoot } from "./git.js";
import { init } from "./init.js";
import { serveFilterProcess } from "./process.js";
import { applyReview, formatApply, formatReview, markAll, parseReview, scan } from "./scan.js";
import { addWorktree } from "./worktree.js";

const USAGE = `usage: ${BRAND} <command>

  init [--command <cli>] [--one-shot]
                                configure the filter, .gitattributes, and pre-commit hook;
                                --one-shot runs a process per file instead of one per git command
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
    case "init": {
      const { values } = parseArgs({
        args: rest,
        options: { command: { type: "string" }, "one-shot": { type: "boolean", default: false } },
      });
      for (const line of init(repoRoot(), { command: values.command, oneShot: values["one-shot"] })) console.log(line);
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
