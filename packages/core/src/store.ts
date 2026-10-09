// Where a repository keeps its sidecars: tracked under SIDECAR_ROOT, or in private mode in the
// git common dir, off every branch (design.md § Private mode). Plain file reads, no git process,
// so the extension can resolve them as cheaply as the CLI.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { BRAND, SCAN_IGNORE, SIDECAR_ROOT } from "./brand.js";

/** The private store's folder, relative to the git common dir. Its existence turns private mode on. */
export const PRIVATE_STORE = `${BRAND}/comments`;

/** The private scan-ignore file, relative to the git common dir. */
export const PRIVATE_SCAN_IGNORE = `${BRAND}/scan-ignore`;

/**
 * Whether a failed stat or read means the path is simply not there. Anything else (a denied
 * permission, a symlink loop) is rethrown: reading it as "no private store" would send
 * private comments to the branch.
 */
function isAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch (error) {
    if (isAbsent(error)) return false;
    throw error;
  }
}

/** Contents of a file, or undefined when it does not exist. */
function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (isAbsent(error)) return undefined;
    throw error;
  }
}

/**
 * The git directory every worktree of the repository at `root` shares, read from `root/.git`:
 * the folder itself, or for a linked worktree the `commondir` its `gitdir:` pointer names. A
 * submodule's pointer has no `commondir`; its own git dir is the common one. Undefined when
 * `root` has no `.git`.
 */
export function commonGitDir(root: string): string | undefined {
  const dotGit = path.join(root, ".git");
  if (isDirectory(dotGit)) return dotGit;
  const pointer = /^gitdir: (.+)$/m.exec(readText(dotGit) ?? "")?.[1]?.trim();
  if (!pointer) return undefined;
  const gitDir = path.resolve(root, pointer);
  const common = readText(path.join(gitDir, "commondir"))?.trim();
  return common ? path.resolve(gitDir, common) : gitDir;
}

/** The private store of the repository at `root`, or undefined when it keeps tracked sidecars. */
export function privateSidecarDir(root: string): string | undefined {
  const common = privateCommonDir(root);
  return common && path.join(common, PRIVATE_STORE);
}

/** The git common dir of a repository in private mode; undefined for one that keeps tracked sidecars. */
function privateCommonDir(root: string): string | undefined {
  const common = commonGitDir(root);
  return common && isDirectory(path.join(common, PRIVATE_STORE)) ? common : undefined;
}

/** The folder holding the sidecars of the repository at `root`, mirroring source paths. */
export function sidecarDir(root: string): string {
  return privateSidecarDir(root) ?? path.join(root, SIDECAR_ROOT);
}

/** The absolute path of a repo-relative source's sidecar under `dir`, a `sidecarDir` result. */
export function sidecarFileIn(dir: string, sourcePath: string): string {
  return path.join(dir, `${sourcePath.replaceAll("\\", "/")}.md`);
}

/** The scan-ignore file: tracked beside the sidecars, or in private mode in the git common dir. */
export function scanIgnoreFile(root: string): string {
  const common = privateCommonDir(root);
  return common ? path.join(common, PRIVATE_SCAN_IGNORE) : path.join(root, SCAN_IGNORE);
}
