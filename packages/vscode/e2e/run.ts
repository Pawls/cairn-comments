// `npm run test:vscode`: downloads a VS Code build on first use and runs dist/e2e in it,
// once against the overlay fixture and once against a scratch git repository for the scan
// review. Set SLOPSTASH_SCREENSHOTS=<dir> to also capture the two overlay states (Windows
// only) for the README. Set SLOPSTASH_E2E_EXTENSION=<dir> to test an unpacked .vsix (its
// `extension/` folder) instead of this package.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const extension = process.env.SLOPSTASH_E2E_EXTENSION ? path.resolve(process.env.SLOPSTASH_E2E_EXTENSION) : packageRoot;
const fixture = path.join(packageRoot, "e2e/fixture");
const cli = path.resolve(packageRoot, "../cli/bundle/main.js");

// Terminals inside VS Code export this; inherited, it makes the test build of VS Code
// run as plain Node and try to execute the fixture path as a script.
delete process.env.ELECTRON_RUN_AS_NODE;

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
  "src/util.ts": ["export function add(a: number, b: number) {", "  // 🚀 Add the numbers", "  return a + b;", "}", ""].join("\n"),
};

/**
 * A committed, initialized repository. Its own global git config keeps `init` from
 * writing a hook into the developer's `core.hooksPath`, and the extension host inherits it.
 */
function reviewRepo(): { dir: string; env: Record<string, string> } {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "slopstash-e2e-")));
  const config = path.join(dir, "gitconfig");
  writeFileSync(config, "[user]\n\tname = e2e\n\temail = e2e@example.com\n[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n");
  const env = { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };
  const repo = path.join(dir, "repo");
  for (const [file, text] of Object.entries(REVIEW_FILES)) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), text);
  }
  const opts = { cwd: repo, env: { ...process.env, ...env }, stdio: "ignore" as const };
  execFileSync("git", ["init", "-q"], opts);
  execFileSync(process.execPath, [cli, "init"], opts);
  execFileSync("git", ["add", "-A"], opts);
  execFileSync("git", ["commit", "-qm", "base"], opts);
  return { dir, env: { ...env, SLOPSTASH_E2E_REPO: repo } };
}

const review = reviewRepo();
try {
  await runTests({
    extensionDevelopmentPath: extension,
    extensionTestsPath: path.join(packageRoot, "dist/e2e/index.cjs"),
    launchArgs: [fixture, "--disable-extensions"],
    extensionTestsEnv: { SLOPSTASH_SUITE: "overlay", SLOPSTASH_SCREENSHOTS: process.env.SLOPSTASH_SCREENSHOTS ?? "" },
  });
  await runTests({
    extensionDevelopmentPath: extension,
    extensionTestsPath: path.join(packageRoot, "dist/e2e/index.cjs"),
    launchArgs: [review.env.SLOPSTASH_E2E_REPO!, "--disable-extensions"],
    extensionTestsEnv: { SLOPSTASH_SUITE: "review", SLOPSTASH_SCREENSHOTS: process.env.SLOPSTASH_SCREENSHOTS ?? "", ...review.env },
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  rmSync(review.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
