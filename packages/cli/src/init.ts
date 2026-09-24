import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND, FILTER_DRIVER, LANGUAGES, SCAN_IGNORE, SIDECAR_ROOT } from "@cairn-comments/core";
import { ADAPTERS, applySettingsChange, planAdapterInstall, planAdapterUninstall, type SettingsChange } from "./adapters.js";
import { git, gitQuiet } from "./git.js";

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

/** The repository-wide filter process, or undefined in one-shot mode. */
export function configuredProcess(cwd: string): string | undefined {
  try {
    // --local: an agent worktree's own override (`--smudge`) must not answer for the repo.
    return git(["config", "--local", "--get", `filter.${FILTER_DRIVER}.process`], { cwd }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** One reviewable edit: `init --dry-run` prints `what` without calling `apply`. */
export interface Change {
  what: string;
  apply(): void;
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

const localConfig = (root: string, key: string) => gitQuiet(["config", "--local", "--get", key], root)?.trim();

function configChanges(root: string, wanted: Record<string, string | undefined>): Change[] {
  const changes: Change[] = [];
  for (const [key, value] of Object.entries(wanted)) {
    const current = localConfig(root, key);
    if (current === value) continue;
    if (value === undefined) changes.push({ what: `git config: unset ${key}`, apply: () => git(["config", "--local", "--unset", key], { cwd: root }) });
    else changes.push({ what: `git config: set ${key} = ${value}`, apply: () => git(["config", "--local", key, value], { cwd: root }) });
  }
  return changes;
}

function attributeLines(): string[] {
  return [
    ...LANGUAGES.flatMap((l) => l.extensions.map((ext) => `*${ext} filter=${FILTER_DRIVER}`)),
    // eol=lf: the tool writes sidecars as LF, so autocrlf never has anything to convert.
    `${SIDECAR_ROOT}/** merge=${FILTER_DRIVER} text eol=lf`,
    // Append-only lines, so a union merge keeps both branches' rejections.
    `${SCAN_IGNORE} merge=union text eol=lf`,
  ];
}

/** Lines earlier versions wrote, replaced on `init` and removed on `uninstall`. */
const LEGACY_ATTRIBUTES = [`${SIDECAR_ROOT}/** merge=union text eol=lf`];

/** Rewrites `.gitattributes` line by line, keeping every other line and its terminator. */
function attributesChange(root: string, add: string[], remove: string[]): Change | undefined {
  const file = path.join(root, ".gitattributes");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const lines = existing.split(/(?<=\n)/).filter(Boolean);
  const kept = lines.filter((l) => !remove.includes(l.trim()));
  const present = new Set(kept.map((l) => l.trim()));
  const missing = add.filter((l) => !present.has(l));
  if (!missing.length && kept.length === lines.length) return undefined;
  const body = kept.join("");
  const next = body + (body && !body.endsWith("\n") && missing.length ? eol : "") + missing.map((l) => l + eol).join("");
  const removed = lines.length - kept.length;
  const parts = [missing.length && `add ${missing.length} line(s)`, removed && `remove ${removed} line(s)`].filter(Boolean);
  const empty = !next.trim();
  return {
    what: `.gitattributes: ${empty && existing ? "delete (nothing else was in it)" : parts.join(", ")}`,
    apply: () => (empty ? rmSync(file, { force: true }) : writeFileSync(file, next)),
  };
}

function hooksDir(root: string): string {
  return path.resolve(root, git(["rev-parse", "--git-path", "hooks"], { cwd: root }).trim());
}

/**
 * Installs into the effective hooks directory, which a `core.hooksPath` may have moved
 * away from `.git/hooks` (design.md § Git behavior, item 4). An existing hook is renamed and
 * run after ours. The filter-config test keeps the hook inert in any other repository
 * that shares a global hooks directory.
 */
function hookChange(root: string, command: string): Change | undefined {
  const dir = hooksDir(root);
  const hook = path.join(dir, "pre-commit");
  const chained = path.join(dir, CHAINED_HOOK);
  const script = [
    "#!/bin/sh",
    `# ${HOOK_TAG}`,
    `if git config --get filter.${FILTER_DRIVER}.clean >/dev/null 2>&1; then`,
    `  ${command} sync --staged --add || exit 1`,
    `  ${command} check --staged --fix || exit 1`,
    "fi",
    `chained="$(dirname "$0")/${CHAINED_HOOK}"`,
    'if [ -x "$chained" ]; then exec "$chained" "$@"; fi',
    "",
  ].join("\n");
  const existing = existsSync(hook) ? readFileSync(hook, "utf8") : undefined;
  if (existing === script) return undefined;
  const foreign = existing !== undefined && !existing.includes(HOOK_TAG);
  if (foreign && existsSync(chained)) throw new Error(`${chained} already exists; merge it with ${hook} by hand, then rerun`);
  const write = () => {
    mkdirSync(dir, { recursive: true });
    if (foreign) renameSync(hook, chained);
    writeFileSync(hook, script);
    chmodSync(hook, 0o755);
  };
  const what = foreign ? "install; the previous hook now runs after it as " + CHAINED_HOOK : existing === undefined ? "install" : "update";
  return { what: `${hook}: ${what}`, apply: write };
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

/** Adds the snippet to AGENTS.md, replaces the copy between its markers, or (`remove`) takes it out. */
function agentsMdChange(root: string, remove: boolean): Change | undefined {
  const file = path.join(root, "AGENTS.md");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const snippet = agentsSnippet().replaceAll("\n", eol);
  const begin = existing.indexOf(SNIPPET_BEGIN);
  const end = existing.indexOf(SNIPPET_END, begin);
  const found = begin !== -1 && end !== -1;
  if (remove && !found) return undefined;
  let next: string;
  if (found) {
    const after = existing.slice(end + SNIPPET_END.length).replace(/^\r?\n/, "");
    const before = existing.slice(0, begin);
    next = remove ? (after ? before + after : before.replace(/(\r?\n)+$/, "") + (before.trim() ? eol : "")) : before + snippet + after;
  } else {
    const gap = !existing ? "" : existing.endsWith(eol + eol) ? "" : existing.endsWith(eol) ? eol : eol + eol;
    next = existing + gap + snippet;
  }
  if (next === existing) return undefined;
  if (remove) {
    const empty = !next.trim();
    return {
      what: `AGENTS.md: ${empty ? "delete (only the sigil convention was in it)" : "remove the sigil convention"}`,
      apply: () => (empty ? rmSync(file, { force: true }) : writeFileSync(file, next)),
    };
  }
  return { what: `AGENTS.md: ${existing ? (found ? "update" : "add") + " the sigil convention" : "create with the sigil convention"}`, apply: () => writeFileSync(file, next) };
}

function settingsChange(root: string, harness: string, change: SettingsChange | undefined, installing: boolean): Change | undefined {
  if (!change) return undefined;
  const file = path.relative(root, change.file).split(path.sep).join("/");
  const what =
    change.next === null ? "delete (nothing else was in it)" : !change.existed ? `create with the ${harness} hook` : `${installing ? "set" : "remove"} the ${harness} hook`;
  return { what: `${file}: ${what}`, apply: () => applySettingsChange(change) };
}

/**
 * Every change `init` would make, in order; empty when the repository is already set up.
 * The one-shot `clean` is always configured: git ignores it while `process` is set, and
 * it is what the hook and `configuredCommand` key on. Process mode is repo-wide for clean;
 * `worktree add` turns on smudge per worktree (design.md § Filter process).
 */
export function planInit(root: string, options: InitOptions = {}): Change[] {
  const command = options.command ?? defaultCommand();
  const hooks = options.hooks ?? [];
  const changes: (Change | undefined)[] = [
    ...configChanges(root, {
      "extensions.worktreeConfig": "true",
      [`filter.${FILTER_DRIVER}.clean`]: `${command} clean %f`,
      [`filter.${FILTER_DRIVER}.process`]: options.oneShot ? undefined : `${command} filter-process`,
      [`merge.${FILTER_DRIVER}.name`]: `${BRAND} sidecar merge`,
      [`merge.${FILTER_DRIVER}.driver`]: `${command} merge-sidecar %O %A %B`,
    }),
    attributesChange(root, attributeLines(), LEGACY_ATTRIBUTES),
    hookChange(root, command),
    ...hooks.map((h) => settingsChange(root, h, planAdapterInstall(root, h, command), true)),
    options.agentsMd ? agentsMdChange(root, false) : undefined,
  ];
  return changes.filter((c): c is Change => !!c);
}

function worktreeRoots(root: string): string[] {
  return git(["worktree", "list", "--porcelain"], { cwd: root })
    .split(/\r?\n/)
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
}

/**
 * Every change `uninstall` would make. Comment bodies and the markers in the code are
 * user data and stay; `promote --all` first turns them into ordinary comments.
 */
export function planUninstall(root: string): Change[] {
  const changes: (Change | undefined)[] = [];
  for (const section of [`filter.${FILTER_DRIVER}`, `merge.${FILTER_DRIVER}`]) {
    if (gitQuiet(["config", "--local", "--get-regexp", `^${section.replace(".", "\\.")}\\.`], root) !== undefined) {
      changes.push({ what: `git config: remove [${section.replace(".", ' "')}"]`, apply: () => git(["config", "--local", "--remove-section", section], { cwd: root }) });
    }
  }
  // Agent worktrees carry their own smudge settings (worktree add).
  if (localConfig(root, "extensions.worktreeConfig") === "true") {
    for (const wt of worktreeRoots(root)) {
      if (!existsSync(wt) || gitQuiet(["config", "--worktree", "--get-regexp", `^filter\\.${FILTER_DRIVER}\\.`], wt) === undefined) continue;
      changes.push({
        what: `git config --worktree (${wt}): remove [filter "${FILTER_DRIVER}"]`,
        apply: () => git(["config", "--worktree", "--remove-section", `filter.${FILTER_DRIVER}`], { cwd: wt }),
      });
    }
  }
  changes.push(attributesChange(root, [], [...attributeLines(), ...LEGACY_ATTRIBUTES]));
  const dir = hooksDir(root);
  const hook = path.join(dir, "pre-commit");
  const chained = path.join(dir, CHAINED_HOOK);
  if (existsSync(hook) && readFileSync(hook, "utf8").includes(HOOK_TAG)) {
    const restore = existsSync(chained);
    changes.push({
      what: `${hook}: ${restore ? `remove; ${CHAINED_HOOK} goes back to pre-commit` : "remove"}`,
      apply: () => (restore ? renameSync(chained, hook) : rmSync(hook, { force: true })),
    });
  }
  for (const harness of Object.keys(ADAPTERS)) changes.push(settingsChange(root, harness, planAdapterUninstall(root, harness), false));
  changes.push(agentsMdChange(root, true));
  return changes.filter((c): c is Change => !!c);
}

/** Applies `changes` unless `dryRun`, and returns the report: exactly the changes, or that there are none. */
export function runPlan(changes: Change[], dryRun: boolean): string[] {
  if (!changes.length) return ["nothing to change"];
  if (dryRun) return ["dry run; would change:", ...changes.map((c) => `  ${c.what}`)];
  for (const c of changes) c.apply();
  return changes.map((c) => c.what);
}
