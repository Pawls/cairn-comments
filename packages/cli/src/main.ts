#!/usr/bin/env node
import { parseArgs } from "node:util";
import { BRAND, clean, smudge } from "@tildenote/core";
import { collapseFiles, decodeExact, expandFiles, readBodies, selectFiles, syncFiles } from "./files.js";
import { repoRoot } from "./git.js";
import { init } from "./init.js";
import { addWorktree } from "./worktree.js";

const USAGE = `usage: ${BRAND} <command>

  init [--command <cli>]        configure the filter, .gitattributes, and pre-commit hook
  worktree add <git args...>    add a worktree whose checkout shows full comments
  sync [--staged] [--add] [files...]
                                move comment bodies into sidecars and stamp new ids
  expand [files...]             show full comments in working files
  collapse [files...]           reduce working files to bare markers
  clean <path>, smudge <path>   git filter endpoints (stdin to stdout)
`;

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Git runs filters from the worktree root and passes a root-relative path. */
async function runFilter(mode: "clean" | "smudge", file: string | undefined): Promise<void> {
  if (!file) throw new Error(`${mode} needs the path git passes as %f`);
  const input = await readStdin();
  const text = decodeExact(input);
  let output = input;
  if (text !== undefined) {
    const result = mode === "clean" ? await clean(file, text) : await smudge(file, text, readBodies(process.cwd(), file));
    if (result !== text) output = Buffer.from(result, "utf8");
  }
  await new Promise<void>((resolve, reject) => process.stdout.write(output, (err) => (err ? reject(err) : resolve())));
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "clean":
    case "smudge":
      return runFilter(command, rest[0]);
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
    case "init": {
      const { values } = parseArgs({ args: rest, options: { command: { type: "string" } } });
      for (const line of init(repoRoot(), values.command)) console.log(line);
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
