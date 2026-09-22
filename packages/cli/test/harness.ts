import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/main.js");

export interface SandboxOptions {
  autocrlf: boolean;
  /** Extra lines for the isolated global git config. */
  globalConfig?: string;
}

/**
 * A scratch directory with its own global git config, so a scenario behaves the same on
 * every machine and never reads or writes the developer's real config or hooks.
 */
export class Sandbox {
  readonly dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "slopstash-it-")));
  readonly eol: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: SandboxOptions) {
    this.eol = options.autocrlf ? "\r\n" : "\n";
    const config = path.join(this.dir, "gitconfig");
    writeFileSync(
      config,
      [
        "[user]\n\tname = it\n\temail = it@example.com",
        `[core]\n\tautocrlf = ${options.autocrlf}`,
        "[init]\n\tdefaultBranch = main",
        "[commit]\n\tgpgsign = false",
        "[advice]\n\tdetachedHead = false",
        options.globalConfig ?? "",
      ].join("\n"),
    );
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
    this.env = { ...inherited, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  }

  path(...parts: string[]): string {
    return path.join(this.dir, ...parts);
  }

  git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, env: this.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }

  /** Runs git without throwing, for scenarios where git is expected to report a failure. */
  gitResult(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
    const { status, stdout, stderr } = spawnSync("git", args, { cwd, env: this.env, encoding: "utf8" });
    return { status, stdout, stderr };
  }

  cli(cwd: string, ...args: string[]): string {
    return execFileSync(process.execPath, [CLI, ...args], { cwd, env: this.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }

  /** Runs the CLI with `input` on stdin, as a harness hook would. */
  cliWithInput(cwd: string, input: string, ...args: string[]): string {
    return execFileSync(process.execPath, [CLI, ...args], { cwd, env: this.env, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
  }

  /** Writes LF-authored text with this sandbox's working-tree terminator. */
  write(file: string, lf: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, lf.replaceAll("\n", this.eol));
  }

  /** Reads a working file, asserting nothing about terminators, as LF text. */
  read(file: string): string {
    return readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  }

  status(cwd: string): string {
    return this.git(cwd, "status", "--porcelain");
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
