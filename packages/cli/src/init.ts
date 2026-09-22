import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND, FILTER_DRIVER, LANGUAGES, SCAN_IGNORE, SIDECAR_ROOT } from "@slopstash/core";
import { installAdapter } from "./adapters.js";
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
  /** Harnesses whose post-edit hook adapter to install (`claude-code`, `codex`, `cursor`). */
  hooks?: string[];
  /** Write the sigil convention into AGENTS.md. */
  agentsMd?: boolean;
}

const SNIPPET_BEGIN = `<!-- ${BRAND}:begin -->`;
const SNIPPET_END = `<!-- ${BRAND}:end -->`;

/** The sigil convention for an agent instruction file, between markers `init --agents-md` can find again. */
export function agentsSnippet(): string {
  const sigils = [...new Set(LANGUAGES.map((l) => l.lineSigil))];
  const byLanguages = sigils.map((s) => {
    const names = [...new Set(LANGUAGES.filter((l) => l.lineSigil === s).map((l) => l.name))];
    return `\`${s} text\` in ${names.length > 1 ? names.slice(0, -1).join(", ") + ", and " + names.at(-1) : names[0]}`;
  });
  return [
    SNIPPET_BEGIN,
    "## AI comments",
    "",
    `Write the comments you add as sigil comments: ${byLanguages.join("; ")}. The space after the sigil matters.`,
    `On commit, ${BRAND} moves their text to \`${SIDECAR_ROOT}/\` and leaves a short marker in the code, so the owner's view stays clean while agents still read the comments inline.`,
    "",
    "- A comment such as `#~a1b2 text` is already stored: edit its text freely, but keep the four-character id, and delete the whole comment to delete it.",
    "- Never put four letters or digits straight after the sigil (`#~todo`); that reads as an id.",
    "- Doc comments, license headers, pragmas, and lint suppressions stay ordinary comments.",
    SNIPPET_END,
    "",
  ].join("\n");
}

/** Adds the snippet to AGENTS.md, or replaces the copy between its markers. */
function ensureAgentsMd(root: string): string {
  const file = path.join(root, "AGENTS.md");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const snippet = agentsSnippet().replaceAll("\n", eol);
  const begin = existing.indexOf(SNIPPET_BEGIN);
  const end = existing.indexOf(SNIPPET_END, begin);
  let next: string;
  if (begin !== -1 && end !== -1) {
    const after = existing.slice(end + SNIPPET_END.length).replace(/^\r?\n/, "");
    next = existing.slice(0, begin) + snippet + after;
  } else {
    const gap = !existing ? "" : existing.endsWith(eol + eol) ? "" : existing.endsWith(eol) ? eol : eol + eol;
    next = existing + gap + snippet;
  }
  if (next === existing) return "AGENTS.md: already up to date";
  writeFileSync(file, next);
  return existing ? "AGENTS.md: sigil convention written" : "AGENTS.md: created with the sigil convention";
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
  for (const harness of options.hooks ?? []) report.push(installAdapter(root, harness, command));
  if (options.agentsMd) report.push(ensureAgentsMd(root));
  return report;
}
