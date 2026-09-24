// Review model for the scan tree: no `vscode` import, so vitest covers it (test/review.test.ts).
import { exec, execFile } from "node:child_process";
import { FILTER_DRIVER } from "@cairn-comments/core";

/** One `scan --json` entry; the CLI owns the format (packages/cli/src/scan.ts). */
export interface ReviewComment {
  file: string;
  line: number;
  endLine: number;
  fingerprint: string;
  score: number;
  detectors: string[];
  text: string;
  accept: boolean;
}

export interface ReviewFile {
  file: string;
  comments: ReviewComment[];
}

/** Candidates grouped by file in scan order; accept/reject state lives on each comment. */
export class ReviewModel {
  private groups: ReviewFile[] = [];

  load(comments: readonly ReviewComment[]): void {
    const byFile = new Map<string, ReviewComment[]>();
    for (const c of comments) byFile.set(c.file, [...(byFile.get(c.file) ?? []), { ...c, accept: c.accept !== false }]);
    this.groups = [...byFile].map(([file, cs]) => ({ file, comments: cs }));
  }

  files(): readonly ReviewFile[] {
    return this.groups;
  }

  /** Per comment when `line` is given, else for every comment in the file. */
  setAccepted(file: string, line: number | undefined, accept: boolean): void {
    for (const c of this.groups.find((g) => g.file === file)?.comments ?? []) if (line === undefined || c.line === line) c.accept = accept;
  }

  /** The list `scan --apply -` reads. */
  toReview(): { version: 1; comments: ReviewComment[] } {
    return { version: 1, comments: this.groups.flatMap((g) => g.comments) };
  }
}

/** The CLI invocation `init` recorded, from `filter.<driver>.clean = <cli> clean %f`. */
export function cliFromCleanConfig(clean: string): string | undefined {
  const suffix = " clean %f";
  return clean.trim().endsWith(suffix) ? clean.trim().slice(0, -suffix.length) : undefined;
}

function run(file: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(file, args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 }, (error, stdout) => (error ? reject(error) : resolve(stdout))),
  );
}

export interface Repo {
  root: string;
  /** Undefined when the repository has not run `init`. */
  cli: string | undefined;
}

export async function findRepo(folder: string): Promise<Repo | undefined> {
  let root: string;
  try {
    root = (await run("git", ["rev-parse", "--show-toplevel"], folder)).trim();
  } catch {
    return undefined;
  }
  const clean = await run("git", ["config", "--get", `filter.${FILTER_DRIVER}.clean`], root).catch(() => "");
  return { root, cli: cliFromCleanConfig(clean) };
}

/** One `check --stale --json` entry; the CLI owns the format (packages/cli/src/main.ts). */
export interface StaleComment {
  file: string;
  line: number;
  id: string;
  text: string;
}

/**
 * Runs `<cli> <args>` through the shell, as git and the pre-commit hook do, feeding `input`
 * on stdin. An exit code in `okCodes` resolves with stdout, for commands like `check`
 * whose exit code is part of the answer.
 */
export function runCli(cli: string, args: string, cwd: string, input?: string, okCodes: readonly number[] = [0]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = exec(`${cli} ${args}`, { cwd, encoding: "utf8", maxBuffer: 1 << 28 }, (error, stdout, stderr) =>
      error && !okCodes.includes(typeof error.code === "number" ? error.code : -1) ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout),
    );
    child.stdin?.end(input ?? "");
  });
}
