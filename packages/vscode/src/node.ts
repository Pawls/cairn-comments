import { execFile, type ExecFileException } from "node:child_process";

/** The oldest Node major the CLI supports; `init` records a `node` command that git runs (design.md § Packaging). */
export const MIN_NODE_MAJOR = 22;

/** The longest `node --version` may take before setup gives up on it. */
const VERSION_TIMEOUT_MS = 10_000;

/**
 * Why setup cannot run, given the output of `node --version`, or undefined when that Node is
 * new enough. `undefined` output means no `node` was found on PATH.
 */
export function nodeProblem(output: string | undefined): string | undefined {
  const needs = `the git filter Cairn Comments sets up needs Node.js ${MIN_NODE_MAJOR} or later on PATH`;
  const install = `Install it from [nodejs.org](https://nodejs.org), then restart VS Code so it sees the new PATH.`;
  const version = /^v(\d+)\.\d+\.\d+/.exec(output?.trim() ?? "");
  if (!version) return `${needs}, and none was found. ${install}`;
  if (Number(version[1]) < MIN_NODE_MAJOR) return `${needs}; found ${version[0]}. ${install}`;
  return undefined;
}

/**
 * What `node --version` printed, given its `execFile` result. Undefined only when no `node` is
 * on PATH (ENOENT); a `node` that is there but fails or hangs throws, so setup does not tell
 * the user to install a Node they already have.
 */
export function versionOutput(error: ExecFileException | null, stdout: string): string | undefined {
  if (!error) return stdout;
  if (error.code === "ENOENT") return undefined;
  if (error.killed) throw new Error(`\`node --version\` did not finish within ${VERSION_TIMEOUT_MS / 1000} s`);
  throw new Error(`\`node --version\` failed: ${error.message}`);
}

function nodeVersion(): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const options = { encoding: "utf8" as const, timeout: VERSION_TIMEOUT_MS };
    // Looked up on PATH on purpose (typescript:S4036): this must find the same `node` git runs for the filter.
    execFile("node", ["--version"], options, (execError, stdout) => { // NOSONAR
      try {
        resolve(versionOutput(execError, stdout));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

/** Throws with `nodeProblem`'s message, or `versionOutput`'s, unless the `node` on PATH can run the CLI. */
export async function requireNode(): Promise<void> {
  const problem = nodeProblem(await nodeVersion());
  if (problem) throw new Error(problem);
}
