// `npm run test:vscode`: downloads a VS Code build on first use and runs dist/e2e in it
// against the fixture workspace. Set SLOPSTASH_SCREENSHOTS=<dir> to also capture the two
// overlay states (Windows only) for the README.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = path.join(packageRoot, "e2e/fixture");

// Terminals inside VS Code export this; inherited, it makes the test build of VS Code
// run as plain Node and try to execute the fixture path as a script.
delete process.env.ELECTRON_RUN_AS_NODE;

try {
  await runTests({
    extensionDevelopmentPath: packageRoot,
    extensionTestsPath: path.join(packageRoot, "dist/e2e/index.cjs"),
    launchArgs: [fixture, "--disable-extensions"],
    extensionTestsEnv: { SLOPSTASH_SCREENSHOTS: process.env.SLOPSTASH_SCREENSHOTS ?? "" },
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
