import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { TestApi } from "../src/extension.js";
import { cairnActions } from "./actions.js";
import { screenshot } from "./capture.js";
import { settle } from "./wait.js";

const EXTENSION_ID = "pawls.cairn-comments-vscode";
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
const homeFile = (name: string) => path.join(requiredEnv("CAIRN_CLI_HOME"), name);
const forwardSlashes = (file: string) => file.split(path.sep).join("/");
const recordedClean = () => `"${forwardSlashes(homeFile("cairn"))}" clean %f`;
/** Runs the home's CLI on this editor's runtime; run.ts takes node off PATH for this suite. */
const homeCli = (...args: string[]) =>
  execFileSync(process.execPath, [homeFile("main.js"), ...args], { cwd: repo(), env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });

async function api(): Promise<TestApi> {
  const extension = vscode.extensions.getExtension<TestApi>(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);
  return extension.activate();
}

const listing = (a: TestApi) =>
  a.review.files().map((f) => [f.file, f.comments.map((c) => [c.line, c.decision ?? null])]);

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
    assert.equal(
      existsSync(path.join(repo(), ".agents/comments")),
      false,
      "init leaves the sidecar folder to the first scan",
    );
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
    await vscode.commands.executeCommand("cairn.scan");
    assert.equal(a.review.visible(), true, "the palette command brings the review view forward");
    assert.equal(
      existsSync(path.join(repo(), ".agents/comments")),
      true,
      "scan creates the folder the extension activates on",
    );
    assert.deepEqual(listing(a), [
      [
        "src/app.py",
        [
          [2, null],
          [6, null],
        ],
      ],
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
    assert.equal(
      await a.review.apply(),
      "converted 1 comment(s) in 1 file(s)\nignored 1 comment(s) in .agents/scan-ignore\n",
    );
    assert.deepEqual(listing(a), [], "the skipped comment stays out after the pass's rescan");
    assert.match(a.review.message() ?? "", /1 skipped/);
    assert.doesNotMatch(read(".agents/scan-ignore"), /Add the numbers/, "a skipped comment is not ignored");

    await a.review.scan();
    assert.deepEqual(listing(a), [["src/util.ts", [[2, null]]]], "a new scan brings the skipped comment back");
    assert.equal(await a.review.apply("keep"), "ignored 1 comment(s) in .agents/scan-ignore\n");

    assert.match(read("src/app.py"), /^def load\(path\):\n {4}with open/);
    assert.match(read("src/app.py"), /return data {2}# Updated to return the raw text\n/);
    assert.match(
      read(SIDECAR),
      /^## [0-9a-z]{4}\n<!-- pos=before scope=load [^\n]*-->\nStep 1: Read the file contents\n$/,
    );
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
    assert.equal(
      await vscode.commands.executeCommand("cairn.promoteComment", { file: uri.fsPath, id }),
      `promoted ${id} in src/app.py\n`,
    );
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
      assert.deepEqual(
        found.map((c) => [path.relative(repo(), c.file).split(path.sep).join("/"), c.line, c.text]),
        [["src/app.py", 2, "Step 1: Read the file contents"]],
      );
    } finally {
      writeFileSync(file, original);
    }
  });

  test("the extension installs its CLI into the home, which is what the repository records", async () => {
    await api();
    assert.equal(existsSync(homeFile("main.js")), true);
    assert.equal(git("config", "--get", "filter.cairn.clean").trim(), recordedClean());
  });

  test("the suite runs with no node on PATH", () => {
    assert.equal(process.env.CAIRN_E2E_NO_NODE, "1");
    const nodeFile = process.platform === "win32" ? "node.exe" : "node";
    const found = (process.env.PATH ?? "").split(path.delimiter).filter((dir) => dir && existsSync(path.join(dir, nodeFile)));
    assert.deepEqual(found, []);
  });

  test("the extension records its own runtime in the home, for the launcher git runs", async () => {
    await api();
    const runtime = process.platform === "win32" ? forwardSlashes(process.execPath) : process.execPath;
    for (let i = 0; i < 50 && !existsSync(homeFile("runtime")); i++) await settle(100);
    assert.equal(readFileSync(homeFile("runtime"), "utf8"), runtime + "\n");
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

  // The last three run in order: setup after an uninstall, then private mode in two ways.
  test("in a repository never set up, the review view offers setup, which runs init after its dry run and then scans", async () => {
    const a = await api();
    homeCli("uninstall");
    await a.review.scan();
    assert.equal(a.review.message(), undefined, "the setup welcome takes the view's place");

    // The earlier tests left sidecars on the branch, so setup keeps them there without asking.
    const keepsBranch = async () => {
      throw new Error("setup asked where the comments go in a repository that already has them on the branch");
    };
    assert.equal(
      await a.review.setup({ choose: keepsBranch, confirm: async () => false }),
      "",
      "declining the dry run changes nothing",
    );
    assert.throws(() => git("config", "--get", "filter.cairn.clean"));

    let plan = "";
    const report = await a.review.setup({
      choose: keepsBranch,
      confirm: async (_root, dryRun) => {
        plan = dryRun;
        return true;
      },
    });
    assert.match(plan, /^dry run; would change:\n/);
    assert.match(report, /git config: set filter\.cairn\.clean/);
    assert.equal(git("config", "--get", "filter.cairn.clean").trim(), recordedClean());
    assert.notEqual(a.review.message(), undefined, "setup scans, so the view shows the review again");

    // Without node on PATH, git still filters through the launcher and the recorded runtime.
    writeFileSync(path.join(repo(), "src/note.py"), "def f():\n    #~ explains f\n    return 1\n");
    git("add", "src/note.py");
    git("commit", "-qm", "note");
    assert.equal(git("show", "HEAD:src/note.py"), "def f():\n    return 1\n");
  });

  test("Make Comments Private moves the comments into .git after its dry run, and stages their removal", async () => {
    const a = await api();
    assert.ok(git("ls-files", ".agents/comments").includes("src/note.py.md"), "the previous test committed a sidecar");
    assert.equal(await a.privateMode.makePrivate(async () => false), "", "declining the dry run changes nothing");
    assert.equal(existsSync(path.join(repo(), ".git", "cairn", "comments")), false);

    let plan = "";
    const report = await a.privateMode.makePrivate(async (_root, dryRun) => {
      plan = dryRun;
      return true;
    });
    assert.match(plan, /^dry run; would change:\n/);
    assert.match(report, /Commit the staged changes/);
    assert.match(readFileSync(path.join(repo(), ".git", "cairn", "comments", "src", "note.py.md"), "utf8"), /explains f/);
    git("commit", "-qm", "comments leave the branch");
    assert.doesNotMatch(git("ls-tree", "-r", "--name-only", "HEAD"), /^\.agents\//m);
  });

  // Last: it uninstalls the repository and drops its comments.
  test("Set Up in a fresh repository asks where the comments go, and Private keeps everything in .git", async () => {
    const a = await api();
    homeCli("uninstall");
    rmSync(path.join(repo(), ".git", "cairn"), { recursive: true, force: true });
    await a.review.scan();

    let asked = false;
    const report = await a.review.setup({
      choose: async () => {
        asked = true;
        return "private";
      },
      confirm: async () => true,
    });
    assert.ok(asked, "setup asked where the comments go");
    assert.match(report, /cairn\/comments: create/);
    assert.ok(existsSync(path.join(repo(), ".git", "cairn", "comments")));
    assert.match(readFileSync(path.join(repo(), ".git", "info", "attributes"), "utf8"), /\*\.py filter=cairn/);
    assert.equal(git("status", "--porcelain", "--", ".gitattributes"), "", "the branch's .gitattributes is untouched");
  });
});
