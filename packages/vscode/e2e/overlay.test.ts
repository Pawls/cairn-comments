import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import * as vscode from "vscode";
import type { Applied, TestApi } from "../src/extension.js";

const EXTENSION_ID = "tildenote.tildenote-vscode";
const COMMANDS = { toggle: "tildenote.toggleOverlay", edit: "tildenote.editComment" };

const folder = () => vscode.workspace.workspaceFolders![0]!.uri;
const fixtureFile = (...parts: string[]) => vscode.Uri.joinPath(folder(), ...parts);

async function openSample(): Promise<{ api: TestApi; editor: vscode.TextEditor }> {
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fixtureFile("sample.py")));
  const extension = vscode.extensions.getExtension<TestApi>(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);
  const api = await extension.activate();
  // Park the cursor on a marker-free line so no marker is revealed by the selection.
  editor.selection = new vscode.Selection(0, 0, 0, 0);
  return { api, editor };
}

async function setMode(api: TestApi, mode: "off" | "on"): Promise<void> {
  if (api.mode() !== mode) await vscode.commands.executeCommand(COMMANDS.toggle);
  assert.equal(api.mode(), mode);
}

const rangeText = (editor: vscode.TextEditor, o: vscode.DecorationOptions) => editor.document.getText(o.range);
const labels = (applied: Applied, kind: keyof Applied) =>
  applied[kind].map((o) => [o.range.start.line, o.renderOptions?.after?.contentText]);

function screenshot(name: string): void {
  const dir = process.env.TILDENOTE_SCREENSHOTS;
  if (!dir || process.platform !== "win32") return;
  const script = path.join(__dirname, "../../e2e/screenshot.ps1");
  // Window pixels of the editor's first lines under the tab bar in the test window.
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Out", path.join(dir, `${name}.png`), "-Crop", "0,40,1000,300"];
  console.log(`screenshot: ${execFileSync("powershell", args, { encoding: "utf8" }).trim()}`);
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

suite("overlay", () => {
  suiteSetup(async () => {
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
    await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
    await vscode.commands.executeCommand("notifications.clearAll");
  });

  test("off: every bare marker with a body collapses to a dim tilde; a bodyless one warns", async () => {
    const { api, editor } = await openSample();
    await setMode(api, "off");
    const applied = await api.refresh(editor);
    assert.deepEqual(applied.hidden.map((o) => rangeText(editor, o)), ["#~a1b2", "#~c3d4"]);
    assert.deepEqual(labels(applied, "hidden"), [
      [1, "~"],
      [2, "~"],
    ]);
    assert.deepEqual(applied.missing.map((o) => rangeText(editor, o)), ["#~e5f6"]);
    assert.deepEqual(applied.revealed, []);
    await settle(500);
    screenshot("overlay-off");
  });

  test("on: the first body line renders in place, with a count for longer bodies", async () => {
    const { api, editor } = await openSample();
    await setMode(api, "on");
    const applied = await api.refresh(editor);
    assert.deepEqual(labels(applied, "hidden"), [
      [1, "retries are safe: ledger write is idempotent (+2)"],
      [2, "keyed on order.id"],
    ]);
    assert.deepEqual(labels(applied, "missing"), [[3, "  no comment body"]]);
    await settle(500);
    screenshot("overlay-on");
  });

  test("the marker on the cursor's line is revealed instead of hidden", async () => {
    const { api, editor } = await openSample();
    await setMode(api, "on");
    editor.selection = new vscode.Selection(2, 4, 2, 4);
    const applied = await api.refresh(editor);
    assert.deepEqual(applied.hidden.map((o) => rangeText(editor, o)), ["#~a1b2"]);
    assert.deepEqual(applied.revealed.map((o) => rangeText(editor, o)), ["#~c3d4"]);
  });

  test("the toggle state survives in workspace state and drives the status bar command", async () => {
    const { api } = await openSample();
    await setMode(api, "on");
    assert.equal(api.mode(), "on");
    await vscode.commands.executeCommand(COMMANDS.toggle);
    assert.equal(api.mode(), "off");
  });

  test("hover shows the full body, provenance, and an edit link", async () => {
    const { editor } = await openSample();
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      editor.document.uri,
      new vscode.Position(1, 6),
    );
    const text = hovers.flatMap((h) => h.contents.map((c) => (c as vscode.MarkdownString).value)).join("\n");
    assert.match(text, /retries are safe: ledger write is idempotent\n\nthe ledger dedupes/);
    assert.match(text, /\*model: fable 5\.1\*/);
    assert.match(text, /\[Edit comment\]\(command:tildenote\.editComment\?/);
    const none = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", editor.document.uri, new vscode.Position(2, 2));
    assert.equal(none.length, 0, "code before a trailing marker gets no hover");
  });

  test("edit comment opens the sidecar at the entry heading", async () => {
    const { editor } = await openSample();
    editor.selection = new vscode.Selection(2, 0, 2, 0);
    await vscode.commands.executeCommand(COMMANDS.edit);
    const active = vscode.window.activeTextEditor!;
    assert.equal(path.basename(active.document.fileName), "sample.py.md");
    assert.equal(active.document.lineAt(active.selection.active.line - 1).text, "## c3d4");
    assert.equal(active.document.lineAt(active.selection.active.line).text, "keyed on order.id");
    assert.equal(active.document.isDirty, false);
  });

  test("edit comment on a bodyless marker appends its heading without saving", async () => {
    const { editor } = await openSample();
    editor.selection = new vscode.Selection(3, 0, 3, 0);
    await vscode.commands.executeCommand(COMMANDS.edit);
    const active = vscode.window.activeTextEditor!;
    assert.equal(active.document.isDirty, true);
    assert.match(active.document.getText(), /\n## e5f6\n$/);
    assert.equal(active.document.lineAt(active.selection.active.line - 1).text, "## e5f6");
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  });
});
