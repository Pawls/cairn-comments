// `npm run test:vscode`: downloads a VS Code build on first use and runs dist/e2e in it,
// against a scratch repository copied from e2e/fixture and one for the scan review. Set
// CAIRN_SCREENSHOTS=<dir> to also capture the overlay states (Windows only) for the
// README. Set CAIRN_E2E_EXTENSION=<dir> to test an unpacked .vsix (its `extension/`
// folder) instead of this package.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runTests } from "@vscode/test-electron";
import { extensionPath, fixtureRepo, packageRoot, scratchRepo, type ScratchRepo } from "./scratch.js";

// Terminals inside VS Code export this; inherited, it makes the test build of VS Code
// run as plain Node and try to execute the fixture path as a script.
delete process.env.ELECTRON_RUN_AS_NODE;

// On Linux, rerun this script on a virtual X display so the test windows never reach the
// desktop (WSLg included); dropping WAYLAND_DISPLAY keeps Electron on X11. Set
// CAIRN_E2E_VISIBLE=1 to watch them instead.
if (process.platform === "linux" && !process.env.CAIRN_E2E_VISIBLE && !process.env.CAIRN_E2E_XVFB) {
  const env: NodeJS.ProcessEnv = { ...process.env, CAIRN_E2E_XVFB: "1" };
  delete env.WAYLAND_DISPLAY;
  const xvfb = spawnSync("xvfb-run", ["-a", process.execPath, ...process.argv.slice(1)], { stdio: "inherit", env });
  if (xvfb.error) console.error(`xvfb-run failed (${xvfb.error.message}); install xvfb or set CAIRN_E2E_VISIBLE=1`);
  process.exit(xvfb.status ?? 1);
}

const REVIEW_FILES: Record<string, string> = {
  "src/app.py": [
    "def load(path):",
    "    # Step 1: Read the file contents",
    "    with open(path) as f:",
    "        data = f.read()",
    "    # retry once; the proxy drops the first connection after idle",
    "    return data  # Updated to return the raw text",
    "",
  ].join("\n"),
  "src/util.ts": [
    "export function add(a: number, b: number) {",
    "  // 🚀 Add the numbers",
    "  return a + b;",
    "}",
    "",
  ].join("\n"),
  // Same as the overlay fixture: the tests drive git themselves, and VS Code's built-in git
  // extension would otherwise watch and refresh the repository beside them.
  ".vscode/settings.json": '{\n  "git.enabled": false\n}\n',
};

const writeReviewFiles = (repo: string) => {
  for (const [file, text] of Object.entries(REVIEW_FILES)) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), text);
  }
};

/** Runs one suite from dist/e2e/index.cjs in a VS Code window opened on `target`. */
async function runSuite(
  suite: "overlay" | "review",
  target: ScratchRepo,
  env: Record<string, string> = {},
): Promise<void> {
  await runTests({
    extensionDevelopmentPath: extensionPath,
    extensionTestsPath: path.join(packageRoot, "dist/e2e/index.cjs"),
    // --force-disable-user-env: on Linux and macOS VS Code otherwise reads the login shell's
    // environment, which would put back the node `withoutNode` took off PATH.
    launchArgs: [target.repo, "--disable-extensions", "--force-disable-user-env"],
    extensionTestsEnv: {
      CAIRN_SUITE: suite,
      CAIRN_SCREENSHOTS: process.env.CAIRN_SCREENSHOTS ?? "",
      ...target.env,
      ...env,
    },
  });
}

/**
 * Runs `suite` with every folder that holds a `node` left off PATH, as on a machine without
 * Node: the extension, its CLI calls, and git's filter must all run on the editor's runtime.
 * Set on process.env itself, whose PATH spelling Windows does not care about.
 */
async function withoutNode(suite: () => Promise<void>): Promise<void> {
  const original = process.env.PATH;
  const nodeFile = process.platform === "win32" ? "node.exe" : "node";
  process.env.PATH = (original ?? "")
    .split(path.delimiter)
    .filter((dir) => dir && !existsSync(path.join(dir, nodeFile)))
    .join(path.delimiter);
  try {
    await suite();
  } finally {
    process.env.PATH = original;
  }
}

const scratch: ScratchRepo[] = [];
try {
  const overlay = fixtureRepo();
  scratch.push(overlay);
  const review = scratchRepo(writeReviewFiles);
  scratch.push(review);
  await runSuite("overlay", overlay);
  await withoutNode(() => runSuite("review", review, { CAIRN_E2E_REPO: review.repo, CAIRN_E2E_NO_NODE: "1" }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  for (const s of scratch) rmSync(s.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
