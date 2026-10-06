// The folder the recorded CLI lives in, outside anything a package manager or editor deletes
// (design.md § Packaging, "The recorded CLI lives in a home the tool owns").
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BRAND } from "./brand.js";

/** Overrides the home; the test harnesses set it so a test never touches the real one. */
export const CLI_HOME_ENV = `${BRAND.toUpperCase()}_CLI_HOME`;

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

/** How git and the hooks invoke the home's CLI: by absolute path, so nothing depends on PATH. */
export function homeCommand(home: string): string {
  return `node "${path.join(home, "main.js").split(path.sep).join("/")}"`;
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
function replaceFile(file: string, text: string): void {
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, text);
  renameSync(temporary, file);
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
  replaceFile(path.join(home, "main.js"), `import "./${name}/main.js";\n`);
  replaceFile(path.join(home, VERSION_FILE), JSON.stringify(incoming) + "\n");
  removeOldCopies(home, new Set([name, previous && copyName(previous)]));
  return { installed: true, version: incoming };
}
