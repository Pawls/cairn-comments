import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { TestApi } from "../src/extension.js";

const EXTENSION_ID = "slopstash.slopstash-vscode";
const COMMANDS = { scan: "slopstash.scan", apply: "slopstash.applyReview" };
const repo = () => process.env.SLOPSTASH_E2E_REPO!;
const read = (file: string) => readFileSync(path.join(repo(), file), "utf8");
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo(), encoding: "utf8" });

async function api(): Promise<TestApi> {
  const extension = vscode.extensions.getExtension<TestApi>(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);
  return extension.activate();
}

function screenshot(name: string): void {
  const dir = process.env.SLOPSTASH_SCREENSHOTS;
  if (!dir || process.platform !== "win32") return;
  const script = path.join(__dirname, "../../e2e/screenshot.ps1");
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Out", path.join(dir, `${name}.png`)];
  console.log(`screenshot: ${execFileSync("powershell", args, { encoding: "utf8" }).trim()}`);
}

const listing =(a: TestApi) => a.review.files().map((f) => [f.file, f.comments.map((c) => [c.line, c.accept])]);

suite("scan review", () => {
  test("scan groups likely AI comments by file, all accepted", async () => {
    const a = await api();
    await vscode.commands.executeCommand(COMMANDS.scan);
    assert.deepEqual(listing(a), [
      ["src/app.py", [[2, true], [6, true]]],
      ["src/util.ts", [[2, true]]],
    ]);
    assert.match(a.review.message() ?? "", /^3 likely AI comment/);
    if (process.env.SLOPSTASH_SCREENSHOTS) {
      // One rejection, so the picture shows both checkbox states; rows render ~1 s after focus.
      a.review.setAccepted("src/app.py", 6, false);
      await vscode.commands.executeCommand("slopstash.review.focus");
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
    assert.match(read(".agents/comments/src/app.py.md"), /^## [0-9a-z]{4}\nStep 1: Read the file contents\n$/);
    const ignore = read(".agents/scan-ignore");
    assert.match(ignore, /\nsrc\/app\.py\t[0-9a-f]{8}\tUpdated to return the raw text\n/);
    assert.match(ignore, /\nsrc\/util\.ts\t[0-9a-f]{8}\t🚀 Add the numbers\n/);
    const status = git("status", "--porcelain", "-uall").split("\n").filter(Boolean).sort();
    assert.deepEqual(status, ["?? .agents/comments/src/app.py.md", "?? .agents/scan-ignore", " M src/app.py"].sort());

    assert.deepEqual(a.review.files(), []);
    assert.equal(a.review.message(), "No likely AI comments found.");
  });
});
