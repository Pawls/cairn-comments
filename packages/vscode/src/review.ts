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

/** What the owner decided for a candidate: convert it to an AI comment, or keep it as an ordinary one. */
export type Decision = "ai" | "keep";

/** A candidate in the tree, with the decision it will be applied with (none yet when undefined). */
export type ReviewItem = ReviewComment & { decision?: Decision };

export interface ReviewFile {
  file: string;
  comments: ReviewItem[];
}

const skipKey = (c: ReviewComment) => `${c.file}\t${c.fingerprint}`;

/**
 * Candidates grouped by file in scan order. The owner decides each one, skips the ones to
 * judge later, and applies the decisions in one pass; undecided and skipped ones stay out
 * of it.
 */
export class ReviewModel {
  private groups: ReviewFile[] = [];
  private readonly skipped = new Set<string>();

  /** Starts a review. `keepSkipped` is for the rescan after a pass, which should not bring skipped comments back. */
  load(comments: readonly ReviewComment[], options: { keepSkipped?: boolean } = {}): void {
    if (!options.keepSkipped) this.skipped.clear();
    const byFile = new Map<string, ReviewItem[]>();
    for (const c of comments) {
      if (this.skipped.has(skipKey(c))) continue;
      byFile.set(c.file, [...(byFile.get(c.file) ?? []), { ...c, decision: undefined }]);
    }
    this.groups = [...byFile].map(([file, cs]) => ({ file, comments: cs }));
  }

  files(): readonly ReviewFile[] {
    return this.groups;
  }

  /**
   * Sets `decision` on one comment, or on every comment in the file when `line` is undefined.
   * Deciding what the comments already have clears it, so each button toggles.
   */
  decide(file: string, line: number | undefined, decision: Decision): void {
    const targets = this.pick(file, line);
    const clear = targets.every((c) => c.decision === decision);
    for (const c of targets) c.decision = clear ? undefined : decision;
  }

  /** Takes one comment, or a whole file, out of this review until the next scan starts over. */
  skip(file: string, line: number | undefined): void {
    for (const c of this.pick(file, line)) this.skipped.add(skipKey(c));
    this.groups = this.groups
      .map((g) => ({ file: g.file, comments: g.comments.filter((c) => !this.skipped.has(skipKey(c))) }))
      .filter((g) => g.comments.length);
  }

  decidedCount(): number {
    return this.groups.reduce((n, g) => n + g.comments.filter((c) => c.decision).length, 0);
  }

  commentCount(): number {
    return this.groups.reduce((n, g) => n + g.comments.length, 0);
  }

  skippedCount(): number {
    return this.skipped.size;
  }

  /**
   * The list `scan --apply -` reads: each decided comment with its decision, and with
   * `rest`, every undecided one with that. `accept` converts a comment to an AI comment;
   * otherwise the CLI records it in the ignore file. Unlisted candidates are left alone.
   */
  toReview(rest?: Decision): { version: 1; comments: ReviewComment[] } {
    const comments = this.groups.flatMap((g) =>
      g.comments.flatMap(({ decision, ...c }) => {
        const chosen = decision ?? rest;
        return chosen ? [{ ...c, accept: chosen === "ai" }] : [];
      }),
    );
    return { version: 1, comments };
  }

  private pick(file: string, line: number | undefined): ReviewItem[] {
    return (this.groups.find((g) => g.file === file)?.comments ?? []).filter((c) => line === undefined || c.line === line);
  }
}

/** The CLI invocation `init` recorded, from `filter.<driver>.clean = <cli> clean %f`. */
export function cliFromCleanConfig(clean: string): string | undefined {
  const suffix = " clean %f";
  return clean.trim().endsWith(suffix) ? clean.trim().slice(0, -suffix.length) : undefined;
}

/** The script a recorded `node <main.js>` command runs; undefined for any other command, which may be on PATH. */
export function recordedMain(cli: string): string | undefined {
  const match = /^node\s+(?:"([^"]+)"|(\S+))$/.exec(cli.trim());
  return match ? (match[1] ?? match[2]) : undefined;
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

/** An entry `check --orphans --json` reports as `unplaced`, with `source` made absolute by the caller. */
export interface OrphanComment {
  source: string;
  id: string;
  /** The declaration the comment was last placed in; absent at module level. */
  scope?: string;
  text: string;
}

/** The orphans in a `check --orphans --json` report; its other problems are left out. */
export function orphansOf(report: { problems: { kind: string }[] }): OrphanComment[] {
  return report.problems
    .filter((p): p is OrphanComment & { kind: "unplaced" } => p.kind === "unplaced")
    .map(({ source, id, scope, text }) => ({ source, id, scope, text }));
}

/**
 * One argument for `runCli`'s shell line. POSIX single quotes expand nothing; cmd.exe expands
 * `%VAR%` even inside double quotes, so a Windows argument holding such a character is refused.
 */
export function shellQuote(arg: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    if (/[%"^]/.test(arg)) throw new Error(`${arg} cannot be passed through cmd.exe; rename the file.`);
    return `"${arg}"`;
  }
  return "'" + arg.replaceAll("'", String.raw`'\''`) + "'";
}

/**
 * Runs `<cli> <args>` through the shell, as git and the pre-commit hook do, feeding `input`
 * on stdin. An exit code in `okCodes` resolves with stdout, for commands like `check`
 * whose exit code is part of the answer.
 */
export function runCli(cli: string, args: string, cwd: string, input?: string, okCodes: readonly number[] = [0]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = exec(`${cli} ${args}`, { cwd, encoding: "utf8", maxBuffer: 1 << 28 }, (error, stdout, stderr) => {
      const code = typeof error?.code === "number" ? error.code : -1;
      if (error && !okCodes.includes(code)) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
    child.stdin?.end(input ?? "");
  });
}
