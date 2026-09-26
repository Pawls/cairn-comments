import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { screenshot } from "./capture.js";
import type { TestApi } from "../src/extension.js";

const EXTENSION_ID = "cairn-comments.cairn-comments-vscode";
const COMMANDS = { scan: "cairn.scan", apply: "cairn.applyReview" };
const repo = () => process.env.CAIRN_E2E_REPO!;
const read = (file: string) => readFileSync(path.join(repo(), file), "utf8");
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo(), encoding: "utf8" });

async function api(): Promise<TestApi> {
  const extension = vscode.extensions.getExtension<TestApi>(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);
  return extension.activate();
}

const listing =(a: TestApi) => a.review.files().map((f) => [f.file, f.comments.map((c) => [c.line, c.accept])]);

suite("scan review", () => {
  test("scan groups likely AI comments by file, all accepted", async () => {
    const a = await api();
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
    await vscode.commands.executeCommand(COMMANDS.scan);
    assert.equal(a.review.visible(), true, "the palette command brings the review view forward");
    assert.deepEqual(listing(a), [
      ["src/app.py", [[2, true], [6, true]]],
      ["src/util.ts", [[2, true]]],
    ]);
    assert.match(a.review.message() ?? "", /^3 likely AI comment/);
    if (process.env.CAIRN_SCREENSHOTS) {
      // One rejection, so the picture shows both checkbox states; rows render ~1 s after focus.
      a.review.setAccepted("src/app.py", 6, false);
      await vscode.commands.executeCommand("cairn.review.focus");
      await new Promise((r) => setTimeout(r, 3000));
      screenshot("review-tree");
    }
  });

  test("apply converts accepted comments, remembers rejected ones, and a rescan stays quiet", async () => {
    const a = await api();
    await a.review.scan();
    a.review.setAccepted("src/app.py", 6, false);
    a.review.setAccepted("src/util.ts", undefined, false);
    const report = await a.review.apply();
    assert.equal(report, "converted 1 comment(s) in 1 file(s)\nignored 2 comment(s) in .agents/scan-ignore\n");

    assert.match(read("src/app.py"), /^def load\(path\):\n {4}#~[0-9a-z]{4}\n {4}with open/);
    assert.match(read("src/app.py"), /return data {2}# Updated to return the raw text\n/);
    assert.match(read(".agents/comments/src/app.py.md"), /^## [0-9a-z]{4}\n<!-- anchor=[0-9a-f]{8} -->\nStep 1: Read the file contents\n$/);
    const ignore = read(".agents/scan-ignore");
    assert.match(ignore, /\nsrc\/app\.py\t[0-9a-f]{8}\tUpdated to return the raw text\n/);
    assert.match(ignore, /\nsrc\/util\.ts\t[0-9a-f]{8}\t🚀 Add the numbers\n/);
    const status = git("status", "--porcelain", "-uall").split("\n").filter(Boolean).sort();
    assert.deepEqual(status, ["?? .agents/comments/src/app.py.md", "?? .agents/scan-ignore", " M src/app.py"].sort());

    assert.deepEqual(a.review.files(), []);
    assert.equal(a.review.message(), "No likely AI comments found.");
  });

  test("code actions demote an ordinary comment and promote it back to the same bytes", async () => {
    await api();
    const uri = vscode.Uri.file(path.join(repo(), "src/app.py"));
    const document = await vscode.workspace.openTextDocument(uri);
    const actions = async (line: number) => {
      const found = await vscode.commands.executeCommand<vscode.CodeAction[]>("vscode.executeCodeActionProvider", uri, new vscode.Range(line, 0, line, 0));
      return found.filter((a) => a.command?.command.startsWith("cairn."));
    };
    const titles = async (line: number) => (await actions(line)).map((a) => a.title);
    const run = async (action: vscode.CodeAction) =>
      vscode.commands.executeCommand<string>(action.command!.command, ...(action.command!.arguments ?? []));
    const settled = async (text: string) => {
      for (let i = 0; i < 50 && document.getText() !== text; i++) await new Promise((r) => setTimeout(r, 100));
      assert.equal(document.getText(), text);
    };

    const source = read("src/app.py");
    const sidecar = read(".agents/comments/src/app.py.md");
    assert.deepEqual(await titles(0), []);
    assert.deepEqual(await titles(1), ["Promote AI comment to an ordinary comment"]);
    assert.deepEqual(await titles(4), ["Demote comment to an AI comment (move it to the sidecar)"]);

    assert.equal(await run((await actions(4))[0]!), "demoted 1 comment(s) in 1 file(s)\n");
    const demoted = read("src/app.py");
    assert.match(demoted, /\n {4}#~[0-9a-z]{4}\n {4}return data/);
    assert.match(read(".agents/comments/src/app.py.md"), /\nretry once; the proxy drops the first connection after idle\n$/);
    await settled(demoted);

    assert.match(await run((await actions(4))[0]!), /^promoted [0-9a-z]{4} in src\/app\.py\n$/);
    assert.equal(read("src/app.py"), source);
    assert.equal(read(".agents/comments/src/app.py.md"), sidecar);
    await settled(source);
  });

  test("the stale list names a comment whose code changed, through `check --stale`", async () => {
    const a = await api();
    assert.deepEqual(await a.staleComments(), []);
    const file = path.join(repo(), "src/app.py");
    const original = readFileSync(file, "utf8");
    try {
      writeFileSync(file, original.replace("with open(path) as f:", "with open(path, 'rb') as f:"));
      const found = await a.staleComments();
      assert.ok(Array.isArray(found));
      assert.deepEqual(found.map((c) => [path.relative(repo(), c.file).split(path.sep).join("/"), c.line, c.text]), [
        ["src/app.py", 2, "Step 1: Read the file contents"],
      ]);
    } finally {
      writeFileSync(file, original);
    }
  });
});
