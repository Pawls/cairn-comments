/** Files and repositories the benchmark tests build. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git, isolatedEnv } from "../workspace.ts";

/** Writes `content` to `file` under `root`, making its folders; anything but a string is written as JSON. */
export function writeUnder(root: string, file: string, content: unknown): void {
  const full = path.join(root, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, typeof content === "string" ? content : JSON.stringify(content));
}

export interface Repo {
  repo: string;
  start: string;
  /** The isolated git environment the repository was made with. */
  env: Record<string, string>;
}

/** A repository at `<root>/source` with one commit holding `files`, made with an isolated git config. */
export function makeRepo(root: string, files: Record<string, string>): Repo {
  const repo = path.join(root, "source");
  for (const [file, content] of Object.entries(files)) writeUnder(repo, file, content);
  const env = isolatedEnv(path.join(root, "git-state"), path.join(root, "cli-home"));
  git(repo, env, "init", "--quiet");
  git(repo, env, "add", ".");
  git(repo, env, "commit", "--quiet", "-m", "start");
  return { repo, start: git(repo, env, "rev-parse", "HEAD").trim(), env };
}

/** A change probe's test: passes once `tests/hidden.txt` is in place and `tests/kept.txt` reads "good". */
export const CHANGE_CHECK = [
  'import { existsSync, readFileSync } from "node:fs";',
  'const ready = existsSync("tests/hidden.txt") && readFileSync("tests/kept.txt", "utf8") === "good";',
  "process.exit(ready ? 0 : 3);",
].join("\n");
