import { execFile } from "node:child_process";
import { MIN_NODE_MAJOR, recordRuntime } from "@cairn-comments/core";

/** The longest the runtime check may take before activation gives up on it. */
const VERSION_TIMEOUT_MS = 10_000;

/**
 * The Node major a runtime reports for `--version` when run as Node, or undefined for
 * anything else. An editor whose `RunAsNode` fuse is off prints its own version or nothing.
 */
export function runtimeMajor(output: string): number | undefined {
  const version = /^v(\d+)\.\d+\.\d+/.exec(output.trim());
  return version ? Number(version[1]) : undefined;
}

/**
 * The environment that runs this editor's binary as Node. An inherited crashpad pipe can be
 * stale, and Electron then logs an error to stderr on every run (design.md § Packaging).
 */
export function cliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env, ELECTRON_RUN_AS_NODE: "1" };
  delete result.CHROME_CRASHPAD_PIPE_NAME;
  return result;
}

function versionOf(runtime: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(runtime, ["--version"], { encoding: "utf8", env: cliEnv(), timeout: VERSION_TIMEOUT_MS }, (execError, stdout) =>
      resolve(execError ? "" : stdout),
    );
  });
}

/** Whether `runtime` really runs as Node `MIN_NODE_MAJOR` or later, by what it prints for `--version`. */
async function runsAsNode(runtime: string, version: (runtime: string) => Promise<string>): Promise<boolean> {
  const major = runtimeMajor(await version(runtime));
  return major !== undefined && major >= MIN_NODE_MAJOR;
}

/**
 * The program the extension runs its CLI calls on: the editor's binary when it runs as Node
 * `MIN_NODE_MAJOR` or later, else `node` from PATH. Run as the editor, a binary whose
 * `RunAsNode` fuse is off would open a window instead of running the CLI.
 */
export async function cliRuntime(execPath = process.execPath, version = versionOf): Promise<string> {
  return (await runsAsNode(execPath, version)) ? execPath : "node";
}

/**
 * Records the runtime this extension runs on in the CLI home, so the launcher git runs can
 * use it where PATH has no usable `node`. Recorded only when it really runs as Node
 * `MIN_NODE_MAJOR` or later. Never rejects: a home it cannot write leaves git on `node`
 * from PATH, as before the launcher had a fallback.
 */
export async function recordEditorRuntime(home: string): Promise<void> {
  if (!(await runsAsNode(process.execPath, versionOf))) return;
  try {
    recordRuntime(home, process.execPath);
  } catch {
    // installBundledCli already warned when the home cannot be written.
  }
}
