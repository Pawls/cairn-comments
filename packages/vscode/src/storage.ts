// Where Set Up keeps a repository's comments: on the branch, or private in the git dir
// (design.md § Private mode). No `vscode` import, so vitest covers it (test/storage.test.ts).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { FILTER_DRIVER, SIDECAR_ROOT, privateSidecarDir } from "@cairn-comments/core";

export type Storage = "branch" | "private";

/** Whether `.gitattributes` in `root` already puts files under the filter, as a branch setup does. */
function attributesNameFilter(root: string): boolean {
  const file = path.join(root, ".gitattributes");
  return existsSync(file) && readFileSync(file, "utf8").includes(`filter=${FILTER_DRIVER}`);
}

/**
 * The storage a repository already has, which Set Up keeps without asking; undefined for a
 * fresh one. A clone of a team's repository finds its sidecars or attributes on the branch.
 * The empty sidecar folder the scan view creates says nothing.
 */
export function existingStorage(root: string): Storage | undefined {
  if (privateSidecarDir(root)) return "private";
  const sidecars = path.join(root, SIDECAR_ROOT);
  if (existsSync(sidecars) && readdirSync(sidecars).length) return "branch";
  return attributesNameFilter(root) ? "branch" : undefined;
}

/** The `init` arguments that set a repository up with `storage`. */
export function initArgs(storage: Storage): string[] {
  return storage === "private" ? ["init", "--private"] : ["init"];
}
