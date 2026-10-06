import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { TestApi } from "../src/extension.js";
import { screenshot } from "./capture.js";
import { settle } from "./wait.js";

const EXTENSION_ID = "cairn-comments.cairn-comments-vscode";
const SIDECAR = ".agents/comments/src/app.py.md";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; e2e/run.ts sets it for this suite`);
  return value;
}

const repo = () => requiredEnv("CAIRN_E2E_REPO");
const read = (file: string) => readFileSync(path.join(repo(), file), "utf8");
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo(), encoding: "utf8" });

// The CLI home comes from scratch.ts, so these tests never touch the developer's own.
const homeMain = () => path.join(requiredEnv("CAIRN_CLI_HOME"), "main.js");
const recordedClean = () => `node "${homeMain().split(path.sep).join("/")}" clean %f`;

async function api(): Promise<TestApi> {
  const extension = vscode.extensions.getExtension<TestApi>(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);
  return extension.activate();
}

const listing = (a: TestApi) => a.review.files().map((f) => [f.file, f.comments.map((c) => [c.line, c.decision ?? null])]);

/** The code actions from this extension on `line` of `uri`. */
async function cairnActions(uri: vscode.Uri, line: number): Promise<vscode.CodeAction[]> {
  const found = await vscode.commands.executeCommand<vscode.CodeAction[]>(
    "vscode.executeCodeActionProvider",
    uri,
    new vscode.Range(line, 0, line, 0),
  );
  return found.filter((action) => action.command?.command.startsWith("cairn."));
}

async function runAction(action: vscode.CodeAction): Promise<string> {
  const { command, arguments: args = [] } = action.command!;
  return vscode.commands.executeCommand<string>(command, ...args);
}

/** Waits up to 5 s for the buffer to hold `text`, then asserts it does. */
async function bufferSettled(document: vscode.TextDocument, text: string): Promise<void> {
  for (let i = 0; i < 50 && document.getText() !== text; i++) await settle(100);
  assert.equal(document.getText(), text);
}

/** The id of the last entry in the sidecar text. */
function lastEntryId(sidecar: string): string {
  const last = [...sidecar.matchAll(/^## ([0-9a-z]{4})$/gm)].at(-1);
  if (!last) throw new Error(`no entries in the sidecar:\n${sidecar}`);
  return last[1]!;
}

suite("scan review", () => {
  test("scan groups likely AI comments by file, none decided", async () => {
    const a = await api();
    assert.equal(existsSync(path.join(repo(), ".agents/comments")), false, "init leaves the sidecar folder to the first scan");
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
    await vscode.commands.executeCommand("cairn.scan");
    assert.equal(a.review.visible(), true, "the palette command brings the review view forward");
    assert.equal(existsSync(path.join(repo(), ".agents/comments")), true, "scan creates the folder the extension activates on");
    assert.deepEqual(listing(a), [
      ["src/app.py", [[2, null], [6, null]]],
      ["src/util.ts", [[2, null]]],
    ]);
    assert.match(a.review.message() ?? "", /^3 likely AI comment/);
    if (process.env.CAIRN_SCREENSHOTS) {
      // One decision of each kind, so the picture shows every row state; rows render ~1 s after focus.
      a.review.decide("src/app.py", 2, "ai");
      a.review.decide("src/util.ts", 2, "keep");
      await vscode.commands.executeCommand("cairn.review.focus");
      await settle(3000);
      screenshot("review-tree");
    }
  });

  test("one pass applies a mix of decisions; skipped and undecided comments wait for later", async () => {
    const a = await api();
    await a.review.scan();
    assert.equal(await vscode.commands.executeCommand("cairn.applyReview"), undefined, "nothing decided is a no-op");
    a.review.decide("src/app.py", 2, "ai");
    a.review.decide("src/app.py", 6, "keep");
    a.review.skip("src/util.ts", 2);
    assert.equal(await a.review.apply(), "converted 1 comment(s) in 1 file(s)\nignored 1 comment(s) in .agents/scan-ignore\n");
    assert.deepEqual(listing(a), [], "the skipped comment stays out after the pass's rescan");
    assert.match(a.review.message() ?? "", /1 skipped/);
    assert.doesNotMatch(read(".agents/scan-ignore"), /Add the numbers/, "a skipped comment is not ignored");

    await a.review.scan();
    assert.deepEqual(listing(a), [["src/util.ts", [[2, null]]]], "a new scan brings the skipped comment back");
    assert.equal(await a.review.apply("keep"), "ignored 1 comment(s) in .agents/scan-ignore\n");

    assert.match(read("src/app.py"), /^def load\(path\):\n {4}with open/);
    assert.match(read("src/app.py"), /return data {2}# Updated to return the raw text\n/);
    assert.match(read(SIDECAR), /^## [0-9a-z]{4}\n<!-- pos=before scope=load [^\n]*-->\nStep 1: Read the file contents\n$/);
    const ignore = read(".agents/scan-ignore");
    assert.match(ignore, /\nsrc\/app\.py\t[0-9a-f]{8}\tUpdated to return the raw text\n/);
    assert.match(ignore, /\nsrc\/util\.ts\t[0-9a-f]{8}\t🚀 Add the numbers\n/);
    const status = git("status", "--porcelain", "-uall").split("\n").filter(Boolean).sort();
    assert.deepEqual(status, ["?? .agents/comments/src/app.py.md", "?? .agents/scan-ignore", " M src/app.py"].sort());

    assert.deepEqual(a.review.files(), []);
    assert.equal(a.review.message(), "No likely AI comments found.");
  });

  test("a code action demotes an ordinary comment, and promote puts it back as the same bytes", async () => {
    await api();
    const uri = vscode.Uri.file(path.join(repo(), "src/app.py"));
    const document = await vscode.workspace.openTextDocument(uri);
    const source = read("src/app.py");
    const sidecar = read(SIDECAR);
    const titles = async (line: number) => (await cairnActions(uri, line)).map((action) => action.title);
    assert.deepEqual(await titles(0), []);
    assert.deepEqual(await titles(3), ["Demote comment to an AI comment (move it to the sidecar)"]);

    assert.equal(await runAction((await cairnActions(uri, 3))[0]!), "demoted 1 comment(s) in 1 file(s)\n");
    const demoted = read("src/app.py");
    assert.match(demoted, /\n {8}data = f\.read\(\)\n {4}return data/);
    assert.match(read(SIDECAR), /\nretry once; the proxy drops the first connection after idle\n$/);
    await bufferSettled(document, demoted);

    const id = lastEntryId(read(SIDECAR));
    assert.equal(await vscode.commands.executeCommand("cairn.promoteComment", { file: uri.fsPath, id }), `promoted ${id} in src/app.py\n`);
    assert.equal(read("src/app.py"), source);
    assert.equal(read(SIDECAR), sidecar);
    await bufferSettled(document, source);
  });

  test("the stale list names a comment whose code changed, through `check --stale`", async () => {
    const a = await api();
    assert.deepEqual(await a.staleComments(), []);
    const file = path.join(repo(), "src/app.py");
    const original = readFileSync(file, "utf8");
    try {
      // A change elsewhere in `load` leaves the comment on its statement, flagged.
      writeFileSync(file, original.replace("return data  #", "return data.strip()  #"));
      const found = await a.staleComments();
      assert.ok(Array.isArray(found));
      assert.deepEqual(found.map((c) => [path.relative(repo(), c.file).split(path.sep).join("/"), c.line, c.text]), [
        ["src/app.py", 2, "Step 1: Read the file contents"],
      ]);
    } finally {
      writeFileSync(file, original);
    }
  });

  test("the extension installs its CLI into the home, which is what the repository records", async () => {
    await api();
    assert.equal(existsSync(homeMain()), true);
    assert.equal(git("config", "--get", "filter.cairn.clean").trim(), recordedClean());
  });

  test("a repository whose recorded CLI is gone is repaired to the home's copy", async () => {
    const a = await api();
    git("config", "filter.cairn.clean", 'node "/gone/cairn/main.js" clean %f');
    let missing = "";
    const repaired = await a.repair(async (_root, gone) => {
      missing = gone;
      return true;
    });
    assert.equal(repaired, true);
    assert.equal(missing, "/gone/cairn/main.js");
    assert.equal(git("config", "--get", "filter.cairn.clean").trim(), recordedClean());
    assert.equal(await a.repair(async () => true), false, "nothing to repair once it records the home");
  });

  // Last: it uninstalls the repository.
  test("in a repository never set up, the review view offers setup, which runs init after its dry run and then scans", async () => {
    const a = await api();
    execFileSync("node", [homeMain(), "uninstall"], { cwd: repo() });
    await a.review.scan();
    assert.equal(a.review.message(), undefined, "the setup welcome takes the view's place");

    assert.equal(await a.review.setup(async () => false), "", "declining the dry run changes nothing");
    assert.throws(() => git("config", "--get", "filter.cairn.clean"));

    let plan = "";
    const report = await a.review.setup(async (_root, dryRun) => {
      plan = dryRun;
      return true;
    });
    assert.match(plan, /^dry run; would change:\n/);
    assert.match(report, /git config: set filter\.cairn\.clean/);
    assert.equal(git("config", "--get", "filter.cairn.clean").trim(), recordedClean());
    assert.notEqual(a.review.message(), undefined, "setup scans, so the view shows the review again");
  });
});
