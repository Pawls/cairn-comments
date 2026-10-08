// The folder the recorded CLI lives in, outside anything a package manager or editor deletes
// (design.md § Packaging, "The recorded CLI lives in a home the tool owns").
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BRAND } from "./brand.js";

/** Overrides the home; the test harnesses set it so a test never touches the real one. */
export const CLI_HOME_ENV = `${BRAND.toUpperCase()}_CLI_HOME`;

/** The oldest Node major the CLI supports; the home's main.js refuses an older one. */
export const MIN_NODE_MAJOR = 22;
/** The name of the sh script in the home that git runs; it picks the runtime for the home's main.js. */
export { BRAND as LAUNCHER } from "./brand.js";
/** Where the extension records its editor's runtime, the launcher's fallback when PATH has no usable `node`. */
export const RUNTIME_FILE = "runtime";
/** Set by the launcher while it tries `node` from PATH; main.js then reports a too-old Node with `OLD_NODE_EXIT`. */
export const LAUNCHER_ENV = `${BRAND.toUpperCase()}_LAUNCHER`;
/** The home's main.js exits with this, before reading stdin, to send the launcher on to the recorded runtime. */
export const OLD_NODE_EXIT = 85;

const VERSION_FILE = "version.json";
/** What a bundle carries besides its version file. */
const BUNDLE_FILES = ["main.js", "web-tree-sitter.wasm", "grammars"];

/** A bundle's version; `build` orders two builds of one version, so a rebuild during development replaces the last. */
export interface CliVersion {
  version: string;
  build: number;
}

export function cliHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, homedir = os.homedir()): string {
  const override = env[CLI_HOME_ENV];
  if (override) return override;
  return path.join(dataFolder(env, platform, homedir), BRAND, "cli");
}

/** The per-user data folder: `LOCALAPPDATA` on Windows, `XDG_DATA_HOME` elsewhere, else under the home directory. */
function dataFolder(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, homedir: string): string {
  if (platform === "win32") return env.LOCALAPPDATA ?? path.join(homedir, "AppData", "Local");
  return env.XDG_DATA_HOME ?? path.join(homedir, ".local", "share");
}

const forwardSlashes = (file: string) => file.split(path.sep).join("/");
/** The launcher in `home`; `LAUNCHER` re-exports its name. */
const launcherPath = (home: string) => path.join(home, BRAND);

/** How git and the hooks invoke the home's CLI: the launcher by absolute path, so finding a runtime is its job. */
export function homeCommand(home: string): string {
  return `"${forwardSlashes(launcherPath(home))}"`;
}

/** The home's main.js run by the `node` on PATH, for shells that cannot start the sh launcher (PowerShell, cmd). */
export function nodeCommand(home: string): string {
  return `node "${forwardSlashes(path.join(home, "main.js"))}"`;
}

/**
 * The launcher: `node` from PATH first, then the runtime the extension recorded, run as Node
 * (design.md § Packaging, "Running without Node"). Plain sh, because git runs it through
 * sh on every platform. `command -v`, `read`, and `[` are builtins, so the only processes
 * it starts are the runtimes it tries.
 */
function launcherScript(): string {
  return [
    "#!/bin/sh",
    `# Written by ${BRAND}'s installer; see design.md § Packaging in the ${BRAND} repository.`,
    "home=${0%/*}",
    "if command -v node >/dev/null 2>&1; then",
    `  ${LAUNCHER_ENV}=1 node "$home/main.js" "$@"`,
    "  status=$?",
    `  if [ "$status" -ne ${OLD_NODE_EXIT} ]; then exit "$status"; fi`,
    "fi",
    "runtime=",
    `if [ -f "$home/${RUNTIME_FILE}" ]; then read -r runtime < "$home/${RUNTIME_FILE}"; fi`,
    "# A VS Code Server update replaces the commit folder the runtime was recorded in.",
    'if [ -n "$runtime" ] && [ ! -x "$runtime" ]; then',
    "  case $runtime in",
    "    */.*-server/bin/*/node)",
    '      for candidate in "${runtime%/*/*}"/*/node; do',
    '        if [ -x "$candidate" ]; then runtime=$candidate; fi',
    "      done",
    "      ;;",
    "    */.*-server/cli/servers/*/server/node)",
    '      for candidate in "${runtime%/*/*/*}"/*/server/node; do',
    '        if [ -x "$candidate" ]; then runtime=$candidate; fi',
    "      done",
    "      ;;",
    "  esac",
    "fi",
    'if [ -z "$runtime" ] || [ ! -x "$runtime" ]; then',
    `  echo "${BRAND}: needs Node.js ${MIN_NODE_MAJOR} or later on PATH, or an editor where the ${BRAND} extension has run since it was installed" >&2`,
    "  exit 1",
    "fi",
    "# Inherited from an editor, the crashpad pipe can be stale, and Electron then logs an error on every run.",
    "unset CHROME_CRASHPAD_PIPE_NAME",
    'ELECTRON_RUN_AS_NODE=1 exec "$runtime" "$home/main.js" "$@"',
    "",
  ].join("\n");
}

/**
 * The home's main.js: it loads the installed copy, or refuses a Node older than
 * `MIN_NODE_MAJOR`. No `import` statement, so an old Node parses it as CommonJS and gets
 * as far as the check.
 */
function mainScript(copy: string): string {
  return [
    `const major = Number(process.versions.node.split(".")[0]);`,
    `if (major >= ${MIN_NODE_MAJOR}) import("./${copy}/main.js");`,
    `else if (process.env.${LAUNCHER_ENV}) process.exit(${OLD_NODE_EXIT});`,
    "else {",
    `  console.error(\`${BRAND} needs Node.js ${MIN_NODE_MAJOR} or later; \${process.execPath} is \${process.versions.node}\`);`,
    "  process.exitCode = 1;",
    "}",
    "",
  ].join("\n");
}

/**
 * Records `runtime` for the launcher, a Snap's under its `current` revision, which a refresh
 * does not remove. Leaves the file alone when it already says that, and reports whether it wrote.
 */
export function recordRuntime(home: string, runtime: string, platform: NodeJS.Platform = process.platform): boolean {
  const stable = runtime.replace(/^\/snap\/([^/]+)\/x?\d+\//, "/snap/$1/current/");
  const text = (platform === "win32" ? stable.replaceAll("\\", "/") : stable) + "\n";
  const file = path.join(home, RUNTIME_FILE);
  if (existsSync(file) && readFileSync(file, "utf8") === text) return false;
  mkdirSync(home, { recursive: true });
  replaceFile(file, text);
  return true;
}

function readVersion(dir: string): CliVersion | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, VERSION_FILE), "utf8")) as Partial<CliVersion>;
    return typeof parsed.version === "string" && typeof parsed.build === "number" ? { version: parsed.version, build: parsed.build } : undefined;
  } catch {
    return undefined;
  }
}

function isNewer(incoming: CliVersion, installed: CliVersion): boolean {
  const parts = (v: string) => v.split(/[.+-]/).slice(0, 3).map(Number);
  const [a, b] = [parts(incoming.version), parts(installed.version)];
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return incoming.build > installed.build;
}

const copyName = (v: CliVersion) => `${v.version}-${v.build}`;

/** The installed version, when its copy is really there. */
function installedVersion(home: string): CliVersion | undefined {
  const installed = readVersion(home);
  return installed && existsSync(path.join(home, copyName(installed), "main.js")) ? installed : undefined;
}

/** The version `installCli` would install from `source`, or undefined when `home` has it or a newer one. */
export function pendingInstall(source: string, home: string): CliVersion | undefined {
  const incoming = readVersion(source);
  if (!incoming) throw new Error(`${path.join(source, VERSION_FILE)} is missing; this CLI is not a built bundle`);
  const installed = installedVersion(home);
  return !installed || isNewer(incoming, installed) ? incoming : undefined;
}

/** Writes `text` beside `file` and renames it into place, so a reader sees the old file or the new one. */
function replaceFile(file: string, text: string, mode?: number): void {
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, text, { mode });
  renameSync(temporary, file);
}

/** Replaces the launcher only when its text changed: on Windows a launcher git is running cannot be renamed over. */
function writeLauncher(home: string): void {
  const file = launcherPath(home);
  const text = launcherScript();
  if (existsSync(file) && readFileSync(file, "utf8") === text) return;
  replaceFile(file, text, 0o755);
}

export interface InstallResult {
  installed: boolean;
  version: CliVersion;
}

/** Copies the bundle in `source` to `target` through a temporary name, so `target` is never half copied. */
function copyBundle(source: string, target: string): void {
  const temporary = `${target}.tmp-${process.pid}`;
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true });
  try {
    for (const file of [...BUNDLE_FILES, VERSION_FILE]) cpSync(path.join(source, file), path.join(temporary, file), { recursive: true });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Removes the version copies in `home` other than those named in `keep`. */
function removeOldCopies(home: string, keep: ReadonlySet<string | undefined>): void {
  for (const entry of readdirSync(home, { withFileTypes: true })) {
    // A `.tmp-` folder may be another installer's copy in progress.
    if (!entry.isDirectory() || keep.has(entry.name) || entry.name.includes(".tmp-") || !readVersion(path.join(home, entry.name))) continue;
    try {
      rmSync(path.join(home, entry.name), { recursive: true, force: true });
    } catch {
      // A copy some process still holds open on Windows goes on the next install.
    }
  }
}

/**
 * Copies the bundle in `source` into `home` when it is newer than the installed one. Each
 * version gets its own folder, copied under a temporary name and renamed whole; only then
 * does the home's `main.js`, a one-line import of that folder, switch to it. A git filter
 * starting mid-install therefore loads the old copy or the new one, never a mix. The copy
 * just replaced stays, for a filter that read the old `main.js` but has not imported yet.
 */
export function installCli(source: string, home: string): InstallResult {
  const incoming = pendingInstall(source, home);
  const previous = installedVersion(home);
  if (!incoming) return { installed: false, version: previous! };
  const name = copyName(incoming);
  const target = path.join(home, name);
  if (!existsSync(path.join(target, "main.js"))) copyBundle(source, target);
  writeLauncher(home);
  replaceFile(path.join(home, "main.js"), mainScript(name));
  replaceFile(path.join(home, VERSION_FILE), JSON.stringify(incoming) + "\n");
  removeOldCopies(home, new Set([name, previous && copyName(previous)]));
  return { installed: true, version: incoming };
}
