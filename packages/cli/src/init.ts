import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND, FILTER_DRIVER, LANGUAGES, SCAN_IGNORE, SIDECAR_ROOT } from "@slopstash/core";
import { git } from "./git.js";

const HOOK_TAG = `managed by ${BRAND} init`;
const CHAINED_HOOK = `pre-commit.${BRAND}-chained`;

/** How git and the hook invoke this CLI: by absolute path, so nothing depends on PATH. */
export function defaultCommand(): string {
  const main = path.join(path.dirname(fileURLToPath(import.meta.url)), "main.js");
  return `node "${main.split(path.sep).join("/")}"`;
}

/** The CLI invocation `init` recorded, recovered from the clean filter's config. */
export function configuredCommand(cwd: string): string {
  let clean = "";
  try {
    clean = git(["config", "--get", `filter.${FILTER_DRIVER}.clean`], { cwd }).trim();
  } catch {
    // Unset exits 1; handled below.
  }
  if (!clean.endsWith(" clean %f")) throw new Error(`filter.${FILTER_DRIVER}.clean is not set; run \`${BRAND} init\` first`);
  return clean.slice(0, -" clean %f".length);
}

function ensureAttributes(root: string): string[] {
  const file = path.join(root, ".gitattributes");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const present = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const wanted = [
    ...LANGUAGES.flatMap((l) => l.extensions.map((ext) => `*${ext} filter=${FILTER_DRIVER}`)),
    // eol=lf: the tool writes sidecars as LF, so autocrlf never has anything to convert.
    `${SIDECAR_ROOT}/** merge=union text eol=lf`,
    // Append-only lines, so a union merge keeps both branches' rejections.
    `${SCAN_IGNORE} merge=union text eol=lf`,
  ];
  const missing = wanted.filter((l) => !present.has(l));
  if (missing.length) {
    const lead = existing && !existing.endsWith("\n") ? eol : "";
    writeFileSync(file, existing + lead + missing.map((l) => l + eol).join(""));
  }
  return missing;
}

/**
 * Installs into the effective hooks directory, which a `core.hooksPath` may have moved
 * away from `.git/hooks` (design.md, spike finding 4). An existing hook is renamed and
 * run after ours. The filter-config test keeps the hook inert in any other repository
 * that shares a global hooks directory.
 */
function ensureHook(root: string, command: string): string {
  const hooksDir = path.resolve(root, git(["rev-parse", "--git-path", "hooks"], { cwd: root }).trim());
  const hook = path.join(hooksDir, "pre-commit");
  const chained = path.join(hooksDir, CHAINED_HOOK);
  mkdirSync(hooksDir, { recursive: true });
  let note = "installed";
  if (existsSync(hook) && !readFileSync(hook, "utf8").includes(HOOK_TAG)) {
    if (existsSync(chained)) throw new Error(`${chained} already exists; merge it with ${hook} by hand, then rerun`);
    renameSync(hook, chained);
    note = `installed; the previous hook now runs after it as ${CHAINED_HOOK}`;
  }
  const script = [
    "#!/bin/sh",
    `# ${HOOK_TAG}`,
    `if git config --get filter.${FILTER_DRIVER}.clean >/dev/null 2>&1; then`,
    `  ${command} sync --staged --add || exit 1`,
    "fi",
    `chained="$(dirname "$0")/${CHAINED_HOOK}"`,
    'if [ -x "$chained" ]; then exec "$chained" "$@"; fi',
    "",
  ].join("\n");
  writeFileSync(hook, script);
  chmodSync(hook, 0o755);
  return `${hook}: ${note}`;
}

/** The repository-wide filter process, or undefined in one-shot mode. */
export function configuredProcess(cwd: string): string | undefined {
  try {
    // --local: an agent worktree's own override (`--smudge`) must not answer for the repo.
    return git(["config", "--local", "--get", `filter.${FILTER_DRIVER}.process`], { cwd }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface InitOptions {
  command?: string;
  /** Leave git on a process per file; the long-running process is the default. */
  oneShot?: boolean;
}

/**
 * The one-shot `clean` is always configured: git ignores it while `process` is set, and
 * it is what the hook and `configuredCommand` key on. Process mode is repo-wide for clean;
 * `worktree add` turns on smudge per worktree (design.md § Filter process).
 */
export function init(root: string, options: InitOptions = {}): string[] {
  const command = options.command ?? defaultCommand();
  const report: string[] = [];
  git(["config", "extensions.worktreeConfig", "true"], { cwd: root });
  git(["config", `filter.${FILTER_DRIVER}.clean`, `${command} clean %f`], { cwd: root });
  if (options.oneShot) {
    if (configuredProcess(root)) git(["config", "--local", "--unset", `filter.${FILTER_DRIVER}.process`], { cwd: root });
    report.push(`git config: extensions.worktreeConfig, filter.${FILTER_DRIVER}.clean (one-shot)`);
  } else {
    git(["config", `filter.${FILTER_DRIVER}.process`, `${command} filter-process`], { cwd: root });
    report.push(`git config: extensions.worktreeConfig, filter.${FILTER_DRIVER}.clean, filter.${FILTER_DRIVER}.process`);
  }
  const added = ensureAttributes(root);
  report.push(added.length ? `.gitattributes: added ${added.length} line(s)` : ".gitattributes: already up to date");
  report.push(ensureHook(root, command));
  return report;
}
