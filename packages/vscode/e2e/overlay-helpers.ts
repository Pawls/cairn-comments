// Helpers for overlay.test.ts. The workspace is a scratch repository made from e2e/fixture by
// `init` (see run.ts): the owner's view of a file whose comments live only in the sidecar.
// `audit` changed after its comment was recorded, so that one is stale, and the entry for
// `reconcile` no longer places anywhere.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { TestApi } from "../src/extension.js";
import type { OwnLineStyle, PlacedComment, PlacedRender } from "../src/placed.js";
import { screenshot } from "./capture.js";
import { settle, waitFor } from "./wait.js";

const EXTENSION_ID = "cairn-comments.cairn-comments-vscode";
const TOGGLE = "cairn.toggleOverlay";
/** Window pixels of the editor under the tab bar, down to the panel, in the test window. */
const EDITOR_CROP = "0,40,780,530";

/** The text of each CodeLens the fixture's comments make, as the overlay titles them. */
export const ENTRY_LENS = "Settlement entry point; the only caller is the nightly batch.";
export const SETTLE_LENS = "retries are safe: ledger write is idempotent (+2)";
export const RETURN_LENS = "nothing after notify on purpose: the batch reads the ledger, not our return";
export const REFUND_LENS = "a closed order was already refunded by support by hand";
export const STALE_LENS = "[stale?] the check is read-only, so it never takes the ledger lock";
/** The trailing comment on the line `settle`'s lens sits above. */
export const TRAILING_LABEL = "keyed on order.id";
/** Every lens the fixture shows with the overlay on, as `[line, title]`. */
export const LENSES: [number, string][] = [
  [3, ENTRY_LENS],
  [4, SETTLE_LENS],
  [6, RETURN_LENS],
  [11, REFUND_LENS],
  [17, STALE_LENS],
];

export function repo(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("the test host has no workspace folder; e2e/run.ts opens one");
  return folder.uri.fsPath;
}
export const samplePath = () => path.join(repo(), "sample.py");
export const sidecarPath = () => path.join(repo(), ".agents/comments/sample.py.md");
export const sidecarText = () => readFileSync(sidecarPath(), "utf8");

/** Screenshots the window without the Comments panel VS Code opens for the first file with threads. */
export async function capture(name: string, cropped = true): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.closePanel");
  await vscode.commands.executeCommand("notifications.clearAll");
  await settle(300);
  screenshot(name, cropped ? EDITOR_CROP : undefined);
}

/** Waits until the sidecar on disk passes `test` and holds all of its buffer: a read during a save can come back short. */
export async function sidecarSaved(what: string, test: (text: string) => boolean): Promise<void> {
  await waitFor(what, () => {
    const text = sidecarText();
    const buffer = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === vscode.Uri.file(sidecarPath()).toString(),
    );
    return test(text) && (!buffer || buffer.getText() === text);
  });
}

export async function open(): Promise<{ api: TestApi; editor: vscode.TextEditor }> {
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(samplePath()));
  const extension = vscode.extensions.getExtension<TestApi>(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);
  return { api: await extension.activate(), editor };
}

export async function setMode(api: TestApi, mode: "off" | "on"): Promise<void> {
  if (api.mode() !== mode) await vscode.commands.executeCommand(TOGGLE);
}

async function setStyle(style: OwnLineStyle): Promise<void> {
  await vscode.workspace.getConfiguration("cairn").update("ownLineStyle", style, vscode.ConfigurationTarget.Global);
}

/** Puts the `ownLineStyle` setting back to its default. */
export async function resetStyle(): Promise<void> {
  await vscode.workspace.getConfiguration("cairn").update("ownLineStyle", undefined, vscode.ConfigurationTarget.Global);
}

/** What the overlay renders for `editor` after a refresh; throws when it placed nothing. */
export async function placedNow(api: TestApi, editor: vscode.TextEditor): Promise<PlacedRender> {
  const { placed } = await api.refresh(editor);
  if (!placed) throw new Error("the overlay placed nothing");
  return placed;
}

/** Opens the file with the overlay on in `style` and returns what it shows. */
export async function shown(style: OwnLineStyle = "codelens") {
  const { api, editor } = await open();
  await setMode(api, "on");
  await setStyle(style);
  // The previous test's reset reaches the extension through the file watcher, which may lag.
  let applied = await api.refresh(editor);
  await waitFor(
    "the committed comments",
    async () => (applied = await api.refresh(editor)).placed?.threads.length === 6,
  );
  if (!applied.placed) throw new Error("the overlay placed nothing");
  return { api, editor, placed: applied.placed };
}

export function comment(api: TestApi, editor: vscode.TextEditor, id: string): PlacedComment {
  const found = api.placed.comment(editor.document, id);
  assert.ok(found, `no thread comment for ${id}`);
  return found;
}

export const bodyText = (c: PlacedComment) => (c.body as vscode.MarkdownString).value;

export function threadOf(c: PlacedComment): vscode.CommentThread {
  const thread = c.thread();
  if (!thread) throw new Error("the comment has no thread");
  return thread;
}

export const lensRows = (placed: PlacedRender) => placed.lenses.map((l) => [l.line, l.title]);

export function lensTitle(placed: PlacedRender, index: number): string {
  const lens = placed.lenses[index];
  if (!lens) throw new Error(`no lens at index ${index}`);
  return lens.title;
}

export const lensEndingWith = (placed: PlacedRender, line: number, title: string) =>
  placed.lenses.some((l) => l.line === line && l.title.endsWith(title));
export const labelEndingWith = (placed: PlacedRender, line: number, text: string) =>
  placed.labels.some((l) => l.line === line && l.text.endsWith(text));
/** Whether `settle`'s note and the trailing label are rendered on `line`, as when the line they belong to moved there. */
export const settleNotesOn = (placed: PlacedRender, line: number) =>
  lensEndingWith(placed, line, SETTLE_LENS) && labelEndingWith(placed, line, TRAILING_LABEL);

export const codeLenses = (editor: vscode.TextEditor) =>
  vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", editor.document.uri);

/** Runs the command a CodeLens carries, as clicking it does. */
export async function clickLens(lens: vscode.CodeLens | undefined): Promise<void> {
  if (!lens?.command) throw new Error("no lens with a command to click");
  await vscode.commands.executeCommand(lens.command.command, ...(lens.command.arguments ?? []));
}

/** The code line that carries `settle`'s own-line and trailing comments, wherever it moves to. */
export const WRITE_LINE = "    ledger.write(order.id)";

/** Reverts every dirty file buffer. */
async function revertDirtyDocuments(): Promise<void> {
  for (const document of vscode.workspace.textDocuments) {
    if (!document.isDirty || document.uri.scheme !== "file") continue;
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand("workbench.action.files.revert");
  }
}

const sidecarTabs = () =>
  vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .map((t) => t.input)
    .filter(
      (input): input is vscode.TabInputText =>
        input instanceof vscode.TabInputText && input.uri.fsPath.includes(".agents"),
    );

/**
 * Reverting a sidecar opens it in a tab, which makes it the user's to save: a later
 * test's undo would then leave it unsaved (design.md § Promote and demote, "Undo").
 */
async function closeSidecarTabs(): Promise<void> {
  for (const input of sidecarTabs()) {
    await vscode.window.showTextDocument(input.uri);
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  }
  assert.deepEqual(sidecarTabs(), [], "a sidecar tab is still open");
}

/**
 * Waits for every buffer, the sidecar's included, to reload before the next test edits it:
 * VS Code refuses an edit or save to a buffer older than its file ("has changed in the meantime").
 */
async function waitForReload(): Promise<void> {
  const committed = readFileSync(samplePath(), "utf8");
  await waitFor(
    "the file to reload",
    async () => (await vscode.workspace.openTextDocument(samplePath())).getText() === committed,
  );
  for (const document of vscode.workspace.textDocuments) {
    if (document.uri.scheme !== "file" || !existsSync(document.fileName)) continue;
    await waitFor(
      `${path.basename(document.fileName)} to reload`,
      () => document.getText() === readFileSync(document.fileName, "utf8"),
    );
  }
}

/** Discards the buffer and puts the repository back as committed. */
export async function reset(): Promise<void> {
  await revertDirtyDocuments();
  await closeSidecarTabs();
  execFileSync("git", ["checkout", "--", "."], { cwd: repo() });
  await waitForReload();
}

/**
 * A paste transfer as copying (or cutting) `range` leaves it: the extension's own data from
 * its copy request, and `text` as plain text. A cut deletes `range` before this runs.
 */
export async function copied(api: TestApi, document: vscode.TextDocument, range: vscode.Range, text: string) {
  const transfer = new vscode.DataTransfer();
  await api.paste.prepareDocumentPaste(document, [range], transfer);
  transfer.set("text/plain", new vscode.DataTransferItem(text));
  return transfer;
}

/** Asks the paste provider for `at` and asserts it offers exactly one edit. */
export async function pasteEdit(
  api: TestApi,
  document: vscode.TextDocument,
  at: vscode.Range,
  transfer: vscode.DataTransfer,
) {
  const edits = await api.paste.provideDocumentPasteEdits(document, [at], transfer);
  assert.equal(edits?.length, 1);
  const [pasted] = edits ?? [];
  if (!pasted) throw new Error("the paste offered no edit");
  return pasted;
}

/** Applies the sidecar edit a paste carries. */
export async function applyAdditionalEdit(pasted: vscode.DocumentPasteEdit): Promise<void> {
  if (!pasted.additionalEdit) throw new Error("the paste carries no sidecar edit");
  assert.ok(await vscode.workspace.applyEdit(pasted.additionalEdit));
}

/** Inserts the text a paste offers at `at`, as the editor does before it applies the paste's other edits. */
export async function applyInsertText(
  document: vscode.TextDocument,
  pasted: vscode.DocumentPasteEdit,
  at: vscode.Position,
): Promise<void> {
  if (typeof pasted.insertText !== "string") throw new Error("the paste offered a snippet");
  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, at, pasted.insertText);
  assert.ok(await vscode.workspace.applyEdit(edit));
}

/** Appends three line breaks and returns the row of the last (empty) line, where a paste can land. */
export async function appendBlankLines(editor: vscode.TextEditor): Promise<number> {
  const document = editor.document;
  await editor.edit((b) => b.insert(document.lineAt(document.lineCount - 1).range.end, "\n\n\n"));
  return document.lineCount - 1;
}

/**
 * Cuts `refund`'s five lines and pastes them at an empty cursor on `to`, which puts them
 * above that line, as one edit that also carries the sidecar change (as a real paste lands).
 */
export async function cutAndPasteRefund(
  api: TestApi,
  editor: vscode.TextEditor,
  to: number | "last line",
): Promise<void> {
  const document = editor.document;
  const from = document
    .getText()
    .split("\n")
    .findIndex((l) => l.startsWith("def refund"));
  const cut = new vscode.Range(from, 0, from + 5, 0);
  const text = document.getText(cut);
  await editor.edit((b) => b.delete(cut));
  const transfer = await copied(api, document, cut, text);
  const row = to === "last line" ? document.lineCount - 1 : to;
  const pasted = await pasteEdit(api, document, new vscode.Range(row, 0, row, 0), transfer);
  assert.equal(pasted.insertText, "");
  await applyAdditionalEdit(pasted);
}

/** Whether `refund`'s comment is rendered on its `return None`, wherever `refund` is. */
export async function refundCommentShown(api: TestApi, editor: vscode.TextEditor): Promise<boolean> {
  const row = editor.document
    .getText()
    .split("\n")
    .findIndex((l) => l.startsWith("        return None"));
  const placed = (await api.refresh(editor)).placed;
  const lens = placed?.lenses.some((l) => l.line === row && l.title === REFUND_LENS);
  return !!lens && api.placed.sites(editor.document).some((s) => s.id === "ewiw" && s.row === row);
}

/** Runs Ctrl+Z or Ctrl+Shift+Z in `editor`, then gives the extension time to see it, as a person pressing keys does. */
export async function undoStep(command: "undo" | "redo", editor: vscode.TextEditor): Promise<void> {
  await vscode.window.showTextDocument(editor.document);
  await vscode.commands.executeCommand(command);
  await settle(500);
  await vscode.window.showTextDocument(editor.document);
}

/**
 * Moves `refund` to the end of the file and saves, so the sidecar holds anchors recorded
 * by the tool rather than the fixture's hand-written ones. A later whole-function move
 * then leaves the sidecar unchanged.
 */
export async function recordRefundAnchors(api: TestApi, editor: vscode.TextEditor): Promise<void> {
  const committed = sidecarText();
  await cutAndPasteRefund(api, editor, "last line");
  await sidecarSaved("the first move's anchors in the sidecar", (s) => s !== committed);
  await editor.document.save();
  await waitFor("refund's comment on the moved function", () => refundCommentShown(api, editor));
  // A late file watcher event for that sidecar change would place the comments again.
  await settle(1_500);
}
