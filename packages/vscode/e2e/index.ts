// Entry point VS Code's extension host loads for `@vscode/test-electron`; bundled to
// dist/e2e/index.cjs with the suites in this folder. run.ts picks one per launch through
// CAIRN_SUITE, since each needs its own workspace.
import Mocha from "mocha";

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: "tdd", color: true, timeout: 60_000 });
  // `pre-require` installs `suite`/`test` on the global scope; the suites must load after it.
  const suite = process.env.CAIRN_SUITE ?? "overlay";
  mocha.suite.emit("pre-require", globalThis, `${suite}.test`, mocha);
  if (suite === "review") await import("./review.test.js");
  else if (suite === "private") await import("./private.test.js");
  else await import("./overlay.test.js");
  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} e2e test(s) failed`)) : resolve()));
  });
}
