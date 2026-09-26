import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { screenshot } from "./capture.js";
import type { Applied, TestApi } from "../src/extension.js";

const EXTENSION_ID = "cairn-comments.cairn-comments-vscode";
const COMMANDS = { toggle: "cairn.toggleOverlay", edit: "cairn.editComment", confirm: "cairn.confirmComment" };
/** The fixture's `g7h8` entry records an anchor no code hashes to, so it is always stale. */
const STALE_BODY = "the check is read-only, so it never takes the ledger lock";
const STALE_LABEL = `[stale?] ${STALE_BODY}`;

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
const labels = (applied: Applied, kind: Exclude<keyof Applied, "placed">) =>
  applied[kind].map((o) => [o.range.start.line, o.renderOptions?.after?.contentText]);

/** Window pixels of the editor's first lines under the tab bar in the test window. */
const EDITOR_CROP = "0,40,1000,300";

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
    assert.deepEqual(applied.hidden.map((o) => rangeText(editor, o)), ["#~a1b2", "#~c3d4", "#~g7h8"]);
    assert.deepEqual(labels(applied, "hidden"), [
      [1, "~"],
      [2, "~"],
      [12, "~?"],
    ]);
    assert.deepEqual(applied.missing.map((o) => rangeText(editor, o)), ["#~e5f6"]);
    assert.deepEqual(applied.revealed, []);
    await settle(500);
    screenshot("overlay-off", EDITOR_CROP);
  });

  test("on: the first body line renders in place, with a count for longer bodies", async () => {
    const { api, editor } = await openSample();
    await setMode(api, "on");
    const applied = await api.refresh(editor);
    assert.deepEqual(labels(applied, "hidden"), [
      [1, "retries are safe: ledger write is idempotent (+2)"],
      [2, "keyed on order.id"],
      [12, `${STALE_LABEL}`],
    ]);
    assert.deepEqual(labels(applied, "missing"), [[3, "  no comment body"]]);
    await settle(500);
    screenshot("overlay-on", EDITOR_CROP);
  });

  test("the marker on the cursor's line is revealed instead of hidden", async () => {
    const { api, editor } = await openSample();
    await setMode(api, "on");
    editor.selection = new vscode.Selection(2, 4, 2, 4);
    const applied = await api.refresh(editor);
    assert.deepEqual(applied.hidden.map((o) => rangeText(editor, o)), ["#~a1b2", "#~g7h8"]);
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
    assert.match(text, /\*claude-code · claude-fable-5-1 · 2026-09-22 20:33 UTC · session 4f5ee155\*/);
    assert.match(text, /\[Edit comment\]\(command:cairn\.editComment\?/);
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

  test("a stale comment's hover says so and offers confirm", async () => {
    const { editor } = await openSample();
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", editor.document.uri, new vscode.Position(12, 6));
    const text = hovers.flatMap((h) => h.contents.map((c) => (c as vscode.MarkdownString).value)).join("\n");
    assert.match(text, /\*\*Possibly stale\*\*/);
    assert.match(text, /\[Confirm: still accurate\]\(command:cairn\.confirmComment\?/);
    const fresh = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", editor.document.uri, new vscode.Position(1, 6));
    assert.doesNotMatch(fresh.flatMap((h) => h.contents.map((c) => (c as vscode.MarkdownString).value)).join("\n"), /Possibly stale/);
  });

  test("confirm records the current anchor and the badge goes away", async () => {
    const sidecar = fixtureFile(".agents", "comments", "sample.py.md").fsPath;
    const original = readFileSync(sidecar);
    try {
      const { api, editor } = await openSample();
      await setMode(api, "on");
      editor.selection = new vscode.Selection(12, 0, 12, 0);
      await vscode.commands.executeCommand(COMMANDS.confirm);
      assert.match(readFileSync(sidecar, "utf8"), /## g7h8\n<!-- anchor=[0-9a-f]{8} -->\n/);
      assert.doesNotMatch(readFileSync(sidecar, "utf8"), /anchor=00000000/);
      await vscode.window.showTextDocument(editor.document);
      editor.selection = new vscode.Selection(0, 0, 0, 0);
      const applied = await api.refresh(vscode.window.activeTextEditor!);
      assert.deepEqual(labels(applied, "hidden").at(-1), [12, STALE_BODY]);
    } finally {
      writeFileSync(sidecar, original);
    }
  });
});
