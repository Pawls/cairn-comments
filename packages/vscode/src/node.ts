import { execFile } from "node:child_process";

/** The oldest Node major the CLI supports; `init` records a `node` command that git runs (design.md § Packaging). */
export const MIN_NODE_MAJOR = 22;

/**
 * Why setup cannot run, given the output of `node --version`, or undefined when that Node is
 * new enough. `undefined` output means the command could not run.
 */
export function nodeProblem(versionOutput: string | undefined): string | undefined {
  const needs = `the git filter Cairn Comments sets up needs Node.js ${MIN_NODE_MAJOR} or later on PATH`;
  const install = `Install it from [nodejs.org](https://nodejs.org), then restart VS Code so it sees the new PATH.`;
  const version = /^v(\d+)\.\d+\.\d+/.exec(versionOutput?.trim() ?? "");
  if (!version) return `${needs}, and none was found. ${install}`;
  if (Number(version[1]) < MIN_NODE_MAJOR) return `${needs}; found ${version[0]}. ${install}`;
  return undefined;
}

function nodeVersion(): Promise<string | undefined> {
  return new Promise((resolve) => {
    // Looked up on PATH on purpose (typescript:S4036): this must find the same `node` git runs for the filter.
    execFile("node", ["--version"], { encoding: "utf8" }, (error, stdout) => resolve(error ? undefined : stdout)); // NOSONAR
  });
}

/** Throws with `nodeProblem`'s message unless the `node` on PATH can run the CLI. */
export async function requireNode(): Promise<void> {
  const problem = nodeProblem(await nodeVersion());
  if (problem) throw new Error(problem);
}
