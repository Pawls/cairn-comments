import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { TestApi } from "../src/extension.js";
import type { OwnLineStyle, PlacedComment } from "../src/placed.js";
import { screenshot } from "./capture.js";

// The workspace is a scratch repository made from e2e/fixture by `init` (see run.ts): the
// owner's view of a file whose comments live only in the sidecar. `audit` changed after its
// comment was recorded, so that one is stale, and the entry for `reconcile` no longer
// places anywhere.
const EXTENSION_ID = "cairn-comments.cairn-comments-vscode";
const TOGGLE = "cairn.toggleOverlay";
const STALE_TITLE = "[stale?] the check is read-only, so it never takes the ledger lock";
const LENSES = [
  [3, "Settlement entry point; the only caller is the nightly batch."],
  [4, "retries are safe: ledger write is idempotent (+2)"],
  [6, "nothing after notify on purpose: the batch reads the ledger, not our return"],
  [11, "a closed order was already refunded by support by hand"],
  [17, STALE_TITLE],
];

const repo = () => vscode.workspace.workspaceFolders![0]!.uri.fsPath;
const samplePath = () => path.join(repo(), "sample.py");
const sidecarPath = () => path.join(repo(), ".agents/comments/sample.py.md");
const sidecarText = () => readFileSync(sidecarPath(), "utf8");
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Window pixels of the editor under the tab bar, down to the panel, in the test window. */
const EDITOR_CROP = "0,40,780,530";

/** Screenshots the window without the Comments panel VS Code opens for the first file with threads. */
async function capture(name: string, cropped = true): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.closePanel");
  await vscode.commands.executeCommand("notifications.clearAll");
  await settle(300);
  screenshot(name, cropped ? EDITOR_CROP : undefined);
}

async function waitFor(what: string, condition: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await settle(50);
  }
}

async function open(): Promise<{ api: TestApi; editor: vscode.TextEditor }> {
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(samplePath()));
  const extension = vscode.extensions.getExtension<TestApi>(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);
  return { api: await extension.activate(), editor };
}

async function setMode(api: TestApi, mode: "off" | "on"): Promise<void> {
  if (api.mode() !== mode) await vscode.commands.executeCommand(TOGGLE);
}

async function setStyle(style: OwnLineStyle): Promise<void> {
  await vscode.workspace.getConfiguration("cairn").update("ownLineStyle", style, vscode.ConfigurationTarget.Global);
}

/** Opens the file with the overlay on in `style` and returns what it shows. */
async function shown(style: OwnLineStyle = "codelens") {
  const { api, editor } = await open();
  await setMode(api, "on");
  await setStyle(style);
  // The previous test's reset reaches the extension through the file watcher, which may lag.
  let applied = await api.refresh(editor);
  await waitFor("the committed comments", async () => (applied = await api.refresh(editor)).placed?.threads.length === 6);
  return { api, editor, applied };
}

function comment(api: TestApi, editor: vscode.TextEditor, id: string): PlacedComment {
  const found = api.placed.comment(editor.document, id);
  assert.ok(found, `no thread comment for ${id}`);
  return found;
}

/** Discards the buffer and puts the repository back as committed. */
async function reset(): Promise<void> {
  for (const document of vscode.workspace.textDocuments) {
    if (!document.isDirty || document.uri.scheme !== "file") continue;
    // A buffer with no editor (a sidecar) is shown only to revert it: a sidecar left in a
    // tab is the user's to save, so a later test's undo would not save it.
    const shown = vscode.window.visibleTextEditors.some((e) => e.document === document);
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand(shown ? "workbench.action.files.revert" : "workbench.action.revertAndCloseActiveEditor");
  }
  execFileSync("git", ["checkout", "--", "."], { cwd: repo() });
  // Every buffer, the sidecar's included, must reload before the next test edits it: VS Code
  // refuses an edit or save to a buffer older than its file ("has changed in the meantime").
  const committed = readFileSync(samplePath(), "utf8");
  await waitFor("the file to reload", async () => (await vscode.workspace.openTextDocument(samplePath())).getText() === committed);
  for (const document of vscode.workspace.textDocuments) {
    if (document.uri.scheme !== "file" || !existsSync(document.fileName)) continue;
    await waitFor(`${path.basename(document.fileName)} to reload`, () => document.getText() === readFileSync(document.fileName, "utf8"));
  }
}

suite("overlay", () => {
  suiteSetup(async () => {
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
    await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
    await vscode.commands.executeCommand("notifications.clearAll");
  });

  teardown(reset);

  suiteTeardown(async () => {
    await vscode.workspace.getConfiguration("cairn").update("ownLineStyle", undefined, vscode.ConfigurationTarget.Global);
  });

  test("off: the file shows plain code and nothing else", async () => {
    const { api, editor } = await open();
    await setMode(api, "off");
    const applied = await api.refresh(editor);
    assert.equal(applied.placed, undefined);
    assert.deepEqual(await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", editor.document.uri), []);
    assert.equal(api.placed.comment(editor.document, "qmbf"), undefined);
    await settle(500);
    await capture("overlay-off");
  });

  test("codelens: own-line comments sit above their code line; trailing ones end their line", async () => {
    const { editor, applied } = await shown("codelens");
    assert.deepEqual(
      applied.placed!.lenses.map((l) => [l.line, l.title]),
      LENSES,
    );
    assert.deepEqual(applied.placed!.labels, [{ line: 4, text: "keyed on order.id", stale: false }]);
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", editor.document.uri);
    assert.equal(lenses.length, 5);
    await settle(1000);
    await capture("overlay-on");
  });

  test("every comment is a thread with its provenance, collapsed until its CodeLens opens it", async () => {
    const { api, editor, applied } = await shown("codelens");
    assert.deepEqual(
      applied.placed!.threads.map((t) => [t.line, t.id, t.expanded]),
      [
        [3, "qmbf", false],
        [4, "1kjy", false],
        [4, "f7eo", false],
        [6, "ip6u", false],
        [11, "ewiw", false],
        [17, "p7c3", false],
      ],
    );
    const settleNote = comment(api, editor, "1kjy");
    assert.equal(settleNote.author.name, "claude-code · claude-opus-5-5 · 2026-09-25 18:40 UTC");
    assert.equal((settleNote.body as vscode.MarkdownString).value, "retries are safe: ledger write is idempotent\n\nthe ledger dedupes on order.id, so a retried settle is a no-op");
    assert.equal(settleNote.contextValue, "current");
    const audit = comment(api, editor, "p7c3");
    assert.equal(audit.contextValue, "stale");
    assert.equal(audit.label, "possibly stale");

    const lens = (await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", editor.document.uri))[1]!;
    await vscode.commands.executeCommand(lens.command!.command, ...lens.command!.arguments!);
    assert.equal(settleNote.thread()!.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded);
    await vscode.commands.executeCommand(lens.command!.command, ...lens.command!.arguments!);
    assert.equal(settleNote.thread()!.collapsibleState, vscode.CommentThreadCollapsibleState.Collapsed, "a second click closes the thread");
  });

  test("thread: each own-line comment is an expanded thread below the line above its code", async () => {
    const { applied } = await shown("thread");
    assert.deepEqual(
      applied.placed!.threads.filter((t) => t.expanded).map((t) => t.line),
      [2, 3, 5, 10, 16],
    );
    assert.deepEqual(applied.placed!.lenses, []);
    await settle(1000);
    await capture("overlay-thread");
  });

  test("eol: own-line comments end the line above their code", async () => {
    const { applied } = await shown("eol");
    assert.deepEqual(
      applied.placed!.labels.map((l) => l.line),
      [2, 3, 4, 5, 10, 16],
    );
    await settle(1000);
    await capture("overlay-eol");
  });

  test("comments follow the owner's edits, and are placed from their anchors again on save", async () => {
    const { api, editor } = await shown("codelens");
    // A new first statement in `settle`: its comments move down with their code and stay current until saved.
    await editor.edit((b) => b.insert(new vscode.Position(4, 0), "    log(order)\n"));
    let applied = await api.refresh(editor);
    assert.deepEqual(
      applied.placed!.lenses.map((l) => [l.line, l.title]),
      LENSES.map(([line, title], i) => [i === 0 ? line : (line as number) + 1, title]),
    );
    assert.deepEqual(applied.placed!.labels, [{ line: 5, text: "keyed on order.id", stale: false }]);

    await editor.document.save();
    applied = await api.refresh(editor);
    const titles = applied.placed!.lenses.map((l) => [l.line, l.title]);
    assert.deepEqual(titles.slice(0, 3), [
      [3, LENSES[0]![1]],
      [5, `[stale?] ${LENSES[1]![1]}`],
      [7, `[stale?] ${LENSES[2]![1]}`],
    ]);
  });

  test("a change on disk places the comments again", async () => {
    const { api, editor } = await shown("codelens");
    writeFileSync(samplePath(), "import os\n" + readFileSync(samplePath(), "utf8"));
    await waitFor("the file to reload", () => editor.document.lineAt(0).text === "import os");
    const applied = await api.refresh(editor);
    assert.deepEqual(
      applied.placed!.lenses.map((l) => l.line),
      LENSES.map(([line]) => (line as number) + 1),
    );
  });

  test("Edit changes the body in place and stores it", async () => {
    const { api, editor } = await shown("codelens");
    const refund = comment(api, editor, "ewiw");
    await vscode.commands.executeCommand("cairn.editComment", refund);
    assert.equal(refund.mode, vscode.CommentMode.Editing);
    refund.body = "support refunds a closed order by hand";
    await vscode.commands.executeCommand("cairn.saveComment", refund);
    assert.equal(refund.mode, vscode.CommentMode.Preview);
    assert.match(sidecarText(), /## ewiw\n<!--[^\n]*-->\nsupport refunds a closed order by hand\n/);
    await waitFor("the lens to update", async () => (await api.refresh(editor)).placed!.lenses[3]!.title === "support refunds a closed order by hand");
  });

  test("a thread shows each line of a body on its own line, and edits the lines stored", async () => {
    const { api, editor } = await shown("codelens");
    const lines = "support refunds a closed order by hand\nso there is nothing to reverse";
    const edited = comment(api, editor, "ewiw");
    await vscode.commands.executeCommand("cairn.editComment", edited);
    edited.body = lines;
    await vscode.commands.executeCommand("cairn.saveComment", edited);
    assert.match(sidecarText(), /## ewiw\n<!--[^\n]*-->\nsupport refunds a closed order by hand\nso there is nothing to reverse\n/);
    const rendered = () => (comment(api, editor, "ewiw").body as vscode.MarkdownString).value;
    await waitFor("the thread to show both lines", async () => {
      await api.refresh(editor);
      return rendered() === "support refunds a closed order by hand  \nso there is nothing to reverse";
    });

    const refund = comment(api, editor, "ewiw");
    await vscode.commands.executeCommand("cairn.editComment", refund);
    assert.equal((refund.body as vscode.MarkdownString).value, lines, "the edit box holds the stored lines");
    await vscode.commands.executeCommand("cairn.cancelCommentEdit", refund);
  });

  test("Confirm clears a stale comment", async () => {
    const { api, editor } = await shown("codelens");
    await vscode.commands.executeCommand("cairn.confirmComment", comment(api, editor, "p7c3"));
    await waitFor("the stale tag to go", async () => (await api.refresh(editor)).placed!.lenses[4]!.title === STALE_TITLE.replace("[stale?] ", ""));
    assert.equal(comment(api, editor, "p7c3").contextValue, "current");
  });

  test("Delete removes the entry", async () => {
    const { api, editor } = await shown("codelens");
    await vscode.commands.executeCommand("cairn.deleteComment", comment(api, editor, "ewiw"));
    assert.doesNotMatch(sidecarText(), /## ewiw/);
    await waitFor("the lens to go", async () => (await api.refresh(editor)).placed!.lenses.length === 4);
  });

  test("Promote writes an ordinary comment into the file and removes the entry", async () => {
    const { api, editor } = await shown("codelens");
    await vscode.commands.executeCommand("cairn.promoteComment", comment(api, editor, "ewiw"));
    assert.match(readFileSync(samplePath(), "utf8"), / {4}if order\.closed:\n {8}# a closed order was already refunded by support by hand\n {8}return None\n/);
    assert.equal(editor.document.isDirty, false);
    assert.doesNotMatch(sidecarText(), /## ewiw/);
    await waitFor("the lens to go", async () => (await api.refresh(editor)).placed!.lenses.length === 4);
  });

  // Closing the source without saving once put the ordinary comment back on disk while the
  // unseen sidecar buffer kept the entry: the comment showed twice.
  test("Ctrl+Z after Promote makes it an AI comment again, saved in the source and its sidecar", async () => {
    const { api, editor } = await shown("codelens");
    const committed = { source: readFileSync(samplePath(), "utf8"), sidecar: sidecarText() };
    await vscode.commands.executeCommand("cairn.promoteComment", comment(api, editor, "ewiw"));
    await vscode.window.showTextDocument(editor.document);
    await vscode.commands.executeCommand("undo");
    await waitFor("the undo saved in both files", () => readFileSync(samplePath(), "utf8") === committed.source && sidecarText() === committed.sidecar);
    assert.equal(editor.document.isDirty, false);
    await waitFor("the comment back in the overlay", async () => (await api.refresh(editor)).placed!.lenses.length === 5);
  });

  test("Ctrl+Z after Delete saves the entry back into the sidecar", async () => {
    const { api, editor } = await shown("codelens");
    const committed = sidecarText();
    await vscode.commands.executeCommand("cairn.deleteComment", comment(api, editor, "ewiw"));
    await vscode.window.showTextDocument(editor.document);
    await vscode.commands.executeCommand("undo");
    await waitFor("the entry saved back", () => sidecarText() === committed);
  });

  test("Ctrl+Z after a paste saves the sidecar but leaves the source's unsaved edits unsaved", async () => {
    const { api, editor } = await shown("codelens");
    const committed = readFileSync(samplePath(), "utf8");
    const transfer = new vscode.DataTransfer();
    const copied = new vscode.Range(9, 0, 15, 0);
    await api.paste.prepareDocumentPaste(editor.document, [copied], transfer);
    transfer.set("text/plain", new vscode.DataTransferItem(editor.document.getText(copied)));
    const end = editor.document.lineAt(editor.document.lineCount - 1).range.end;
    await editor.edit((b) => b.insert(end, "\n\n\n"));
    const pasteAt = editor.document.lineCount - 1;
    const at = new vscode.Range(pasteAt, 0, pasteAt, 0);
    const pasted = (await api.paste.provideDocumentPasteEdits(editor.document, [at], transfer))![0]!;
    // One edit, as a real paste lands, so one undo step covers the source and the sidecar.
    const edit = new vscode.WorkspaceEdit();
    edit.insert(editor.document.uri, at.start, pasted.insertText as string);
    for (const [uri, edits] of pasted.additionalEdit!.entries()) for (const e of edits) edit.replace(uri, e.range, e.newText);
    assert.ok(await vscode.workspace.applyEdit(edit));
    await waitFor("the pasted comment in the sidecar", () => /copied-from=ewiw/.test(sidecarText()));

    await vscode.window.showTextDocument(editor.document);
    await vscode.commands.executeCommand("undo");
    await waitFor("the pasted comment gone from the sidecar", () => !/copied-from=ewiw/.test(sidecarText()));
    await settle(500); // a save of the source would follow the sidecar's
    assert.equal(readFileSync(samplePath(), "utf8"), committed, "the edit made before the paste was saved");
    assert.equal(editor.document.isDirty, true);
  });

  test("a string that is not a docstring demotes, and Promote writes it back as the same string", async () => {
    const { api } = await open();
    await setMode(api, "on");
    const file = path.join(repo(), "notes.py");
    const notesSidecar = path.join(repo(), ".agents/comments/notes.py.md");
    const original = 'def settle(order):\n    """Settle one order."""\n    ledger.write(order.id)\n    """\n    Idempotent: keyed on order.id.\n    """\n    notify(order)\n';
    writeFileSync(file, original);
    try {
      const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
      const titles = async (line: number) => {
        const found = await vscode.commands.executeCommand<vscode.CodeAction[]>("vscode.executeCodeActionProvider", editor.document.uri, new vscode.Range(line, 0, line, 0));
        return found.filter((a) => a.command?.command.startsWith("cairn.")).map((a) => a.title);
      };
      assert.deepEqual(await titles(1), [], "a docstring stays in the code");
      assert.deepEqual(await titles(4), ["Demote string to an AI comment (move it to the sidecar)"]);

      assert.equal(await vscode.commands.executeCommand("cairn.demoteComment", { file, line: 5 }), "demoted 1 comment(s) in 1 file(s)\n");
      const code = 'def settle(order):\n    """Settle one order."""\n    ledger.write(order.id)\n    notify(order)\n';
      await waitFor("the string to leave the file", () => editor.document.getText() === code);
      const id = /^## ([0-9a-z]{4})\n<!-- .*literal=triple-double/m.exec(readFileSync(notesSidecar, "utf8"))?.[1];
      assert.ok(id, "the entry records the string's quotes");
      await waitFor("the demoted comment's thread", async () => !!(await api.refresh(editor)).placed?.threads.length);

      await vscode.commands.executeCommand("cairn.promoteComment", comment(api, editor, id));
      assert.equal(readFileSync(file, "utf8"), original);
      assert.equal(editor.document.isDirty, false);
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      rmSync(file, { force: true });
      rmSync(notesSidecar, { force: true });
    }
  });

  test("a copied function carries its comments to where it is pasted", async () => {
    const { api, editor } = await shown("codelens");
    // VS Code only asks paste providers on a real copy event, which an unfocused test window
    // never gets, so this drives the provider the way the editor would: copy, then paste.
    const transfer = new vscode.DataTransfer();
    const copied = new vscode.Range(9, 0, 15, 0);
    await api.paste.prepareDocumentPaste(editor.document, [copied], transfer);
    transfer.set("text/plain", new vscode.DataTransferItem(editor.document.getText(copied)));
    const end = editor.document.lineAt(editor.document.lineCount - 1).range.end;
    await editor.edit((b) => b.insert(end, "\n\n\n"));
    const pasteAt = editor.document.lineCount - 1;
    const at = new vscode.Range(pasteAt, 0, pasteAt, 0);
    const edits = await api.paste.provideDocumentPasteEdits(editor.document, [at], transfer);
    assert.equal(edits?.length, 1);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(editor.document.uri, at.start, edits![0]!.insertText as string);
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.ok(await vscode.workspace.applyEdit(edits![0]!.additionalEdit!));

    await waitFor("the pasted comment in the sidecar", () => /copied-from=ewiw/.test(sidecarText()));
    const sidecar = sidecarText();
    const id = /## ([0-9a-z]{4})\n<!-- by=claude-code [^\n]*copied-from=ewiw[^\n]*scope=refund@1 /.exec(sidecar)?.[1];
    assert.ok(id, `no copied entry anchored to the second refund in:\n${sidecar}`);
    assert.match(sidecar, new RegExp(`## ${id}\\n<!--[^\\n]*-->\\na closed order was already refunded by support by hand\\n`));
    const sidecarDocument = vscode.workspace.textDocuments.find((d) => d.fileName === sidecarPath());
    assert.ok(!sidecarDocument?.isDirty, "the sidecar was left unsaved");

    await editor.document.save();
    await waitFor("the pasted comment's lens", async () => {
      const lenses = (await api.refresh(editor)).placed!.lenses;
      return lenses.some((l) => l.line === pasteAt + 2 && l.title === "a closed order was already refunded by support by hand");
    });
  });

  test("a line copied without a selection carries its comments to a new line above the cursor", async () => {
    const { api, editor } = await shown("codelens");
    const document = editor.document;
    // Ctrl+C with no selection: VS Code reports the line without its break as the copied
    // range, and puts the line with its break on the clipboard.
    const line = document.lineAt(4);
    const transfer = new vscode.DataTransfer();
    await api.paste.prepareDocumentPaste(document, [new vscode.Range(4, 0, 4, line.text.length)], transfer);
    transfer.set("text/plain", new vscode.DataTransferItem(`${line.text}\n`));
    const edits = await api.paste.provideDocumentPasteEdits(document, [new vscode.Range(18, 4, 18, 4)], transfer);
    assert.equal(edits?.length, 1);
    assert.equal(edits![0]!.insertText, "", "a whole-line paste goes on its own line, not at the cursor");
    assert.ok(await vscode.workspace.applyEdit(edits![0]!.additionalEdit!));
    assert.equal(document.lineAt(18).text, "    ledger.write(order.id)");
    assert.equal(document.lineAt(19).text, "    return ledger.balance(order.account, strict=True)");

    await waitFor("both pasted comments in the sidecar", () => /copied-from=1kjy/.test(sidecarText()) && /copied-from=f7eo/.test(sidecarText()));
    await document.save();
    await waitFor("the pasted comments on the new line", async () => {
      const placed = (await api.refresh(editor)).placed!;
      return placed.lenses.some((l) => l.line === 18 && l.title === LENSES[1]![1]) && placed.labels.some((l) => l.line === 18 && l.text === "keyed on order.id");
    });
  });

  test("a cut function's comments move with it: same ids, no copies", async () => {
    const { api, editor } = await shown("codelens");
    const document = editor.document;
    const cut = new vscode.Range(9, 0, 16, 0);
    const text = document.getText(cut);
    const transfer = new vscode.DataTransfer();
    // The extension host sees the cut's deletion before the copy request, whose range still
    // describes the text before the cut (VS Code sends the request after an await).
    await editor.edit((b) => b.delete(cut));
    await api.paste.prepareDocumentPaste(document, [cut], transfer);
    transfer.set("text/plain", new vscode.DataTransferItem(text));

    await editor.edit((b) => b.insert(document.lineAt(document.lineCount - 1).range.end, "\n\n\n"));
    const pasteAt = document.lineCount - 1;
    const at = new vscode.Range(pasteAt, 0, pasteAt, 0);
    const edits = await api.paste.provideDocumentPasteEdits(document, [at], transfer);
    assert.equal(edits?.length, 1);
    const before = sidecarText();
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, at.start, edits![0]!.insertText as string);
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.ok(await vscode.workspace.applyEdit(edits![0]!.additionalEdit!));

    await waitFor("the moved comment's new anchor in the sidecar", () => sidecarText() !== before);
    const sidecar = sidecarText();
    assert.doesNotMatch(sidecar, /copied-from/);
    assert.equal(sidecar.match(/a closed order was already refunded by support by hand/g)?.length, 1);
    assert.match(sidecar, /## ewiw\n/);

    await document.save();
    await waitFor("one lens for the moved comment, on the pasted function", async () => {
      const lenses = (await api.refresh(editor)).placed!.lenses.filter((l) => l.title === LENSES[3]![1]);
      return lenses.length === 1 && lenses[0]!.line === pasteAt + 2;
    });
  });

  test("a cut function whose entry the paste leaves unchanged shows its comments where it lands, before a save", async () => {
    const { api, editor } = await shown("codelens");
    const document = editor.document;
    // Its comment sits on `return None`, the third of `refund`'s five lines.
    const refundLens = (line: number) => async () => (await api.refresh(editor)).placed!.lenses.some((l) => l.line === line && l.title === LENSES[3]![1]);
    /** Cuts `refund`'s five lines and pastes them at an empty cursor on `to` (after the cut), which puts them above that line. */
    const moveRefund = async (to: number | "last line") => {
      const from = document.getText().split("\n").findIndex((l) => l.startsWith("def refund"));
      const cut = new vscode.Range(from, 0, from + 5, 0);
      const text = document.getText(cut);
      const transfer = new vscode.DataTransfer();
      await editor.edit((b) => b.delete(cut));
      await api.paste.prepareDocumentPaste(document, [cut], transfer);
      transfer.set("text/plain", new vscode.DataTransferItem(text));
      const row = to === "last line" ? document.lineCount - 1 : to;
      const edits = await api.paste.provideDocumentPasteEdits(document, [new vscode.Range(row, 0, row, 0)], transfer);
      assert.equal(edits?.length, 1);
      assert.equal(edits![0]!.insertText, "");
      assert.ok(await vscode.workspace.applyEdit(edits![0]!.additionalEdit!));
    };

    // The fixture's anchors are hand-written, so the first move records them afresh.
    const committed = sidecarText();
    await moveRefund("last line");
    await waitFor("the first move's anchors in the sidecar", () => sidecarText() !== committed);
    await document.save();
    await waitFor("refund's comment on the pasted function", refundLens(16));
    // A late file watcher event for that sidecar change would place the comments again.
    await settle(1_500);

    // Moved again, the comment records exactly the entry it already has.
    const recorded = sidecarText();
    await moveRefund(9);
    assert.equal(document.lineAt(9).text, "def refund(order):");
    assert.ok(document.isDirty);
    await waitFor("refund's comment on the pasted function, unsaved", refundLens(11));
    assert.equal(sidecarText(), recorded);
  });

  test("a highlighted line, whatever whitespace the highlight leaves out, pastes like a whole-line copy", async () => {
    const { api, editor } = await shown("codelens");
    const document = editor.document;
    const copied = new vscode.Range(4, 4, 4, document.lineAt(4).text.length);
    const transfer = new vscode.DataTransfer();
    await api.paste.prepareDocumentPaste(document, [copied], transfer);
    transfer.set("text/plain", new vscode.DataTransferItem(document.getText(copied)));
    const edits = await api.paste.provideDocumentPasteEdits(document, [new vscode.Range(18, 4, 18, 4)], transfer);
    assert.equal(edits?.length, 1);
    assert.equal(edits![0]!.insertText, "");
    assert.ok(await vscode.workspace.applyEdit(edits![0]!.additionalEdit!));
    assert.equal(document.lineAt(18).text, "    ledger.write(order.id)", "the whole line, indentation included, above the cursor");
    await waitFor("both pasted comments in the sidecar", () => /copied-from=1kjy/.test(sidecarText()) && /copied-from=f7eo/.test(sidecarText()));
  });

  test("a line cut without a selection moves its comments to where it is pasted", async () => {
    const { api, editor } = await shown("codelens");
    const document = editor.document;
    const line = document.lineAt(4);
    const transfer = new vscode.DataTransfer();
    // Ctrl+X with no selection deletes the line and its break; the copy request comes after.
    await editor.edit((b) => b.delete(new vscode.Range(4, 0, 5, 0)));
    await api.paste.prepareDocumentPaste(document, [new vscode.Range(4, 0, 4, line.text.length)], transfer);
    transfer.set("text/plain", new vscode.DataTransferItem(`${line.text}\n`));
    const edits = await api.paste.provideDocumentPasteEdits(document, [new vscode.Range(5, 4, 5, 4)], transfer);
    assert.equal(edits?.length, 1);
    const before = sidecarText();
    assert.ok(await vscode.workspace.applyEdit(edits![0]!.additionalEdit!));
    assert.equal(document.lineAt(5).text, "    ledger.write(order.id)");
    await waitFor("the moved comments' new anchors in the sidecar", () => sidecarText() !== before);
    assert.doesNotMatch(sidecarText(), /copied-from/);
    await document.save();
    await waitFor("the moved comments on the pasted line", async () => {
      const placed = (await api.refresh(editor)).placed!;
      return placed.lenses.some((l) => l.line === 5 && l.title.endsWith(LENSES[1]![1] as string)) && placed.labels.some((l) => l.line === 5 && l.text.endsWith("keyed on order.id"));
    });
  });

  test("a line moved with Alt+Down keeps its comments, before and after a save", async () => {
    const { api, editor } = await shown("codelens");
    editor.selection = new vscode.Selection(4, 0, 4, 0);
    await vscode.commands.executeCommand("editor.action.moveLinesDownAction");
    assert.equal(editor.document.lineAt(5).text, "    ledger.write(order.id)");
    const onMovedLine = async () => {
      const placed = (await api.refresh(editor)).placed!;
      return placed.lenses.some((l) => l.line === 5 && l.title.endsWith(LENSES[1]![1] as string)) && placed.labels.some((l) => l.line === 5 && l.text.endsWith("keyed on order.id"));
    };
    assert.ok(await onMovedLine(), "the comments follow the line while the file is unsaved");
    await editor.document.save();
    await waitFor("the comments on the moved line after placing from anchors", onMovedLine);
  });

  test("a line cut from its first non-blank character moves its comments to where it is pasted", async () => {
    const { api, editor } = await shown("codelens");
    const document = editor.document;
    const line = document.lineAt(4);
    // A highlight from the first non-blank character to the end of the line, then Ctrl+X.
    const cut = new vscode.Range(4, 4, 4, line.text.length);
    const transfer = new vscode.DataTransfer();
    await editor.edit((b) => b.delete(cut));
    await api.paste.prepareDocumentPaste(document, [cut], transfer);
    transfer.set("text/plain", new vscode.DataTransferItem(line.text.trimStart()));
    const edits = await api.paste.provideDocumentPasteEdits(document, [new vscode.Range(18, 4, 18, 4)], transfer);
    assert.equal(edits?.length, 1);
    const before = sidecarText();
    assert.ok(await vscode.workspace.applyEdit(edits![0]!.additionalEdit!));
    assert.equal(document.lineAt(18).text, "    ledger.write(order.id)");
    await waitFor("the moved comments' new anchors in the sidecar", () => sidecarText() !== before);
    assert.doesNotMatch(sidecarText(), /copied-from/);
    assert.equal(sidecarText().match(/keyed on order\.id/g)?.length, 1, "the trailing comment moved rather than being copied");
    await document.save();
    await waitFor("the moved comments on the pasted line", async () => {
      const placed = (await api.refresh(editor)).placed!;
      return placed.lenses.some((l) => l.line === 18 && l.title.endsWith(LENSES[1]![1] as string)) && placed.labels.some((l) => l.line === 18 && l.text.endsWith("keyed on order.id"));
    });
  });

  test("a block cut from its first non-blank character moves the comments on its first line too", async () => {
    const { api, editor } = await shown("codelens");
    const document = editor.document;
    // settle's body, highlighted from `ledger` on its first line to the end of its last.
    const cut = new vscode.Range(4, 4, 6, document.lineAt(6).text.length);
    const text = document.getText(cut);
    const transfer = new vscode.DataTransfer();
    await editor.edit((b) => b.delete(cut));
    await api.paste.prepareDocumentPaste(document, [cut], transfer);
    transfer.set("text/plain", new vscode.DataTransferItem(text));
    // Two lines shorter, audit's return is now line 16; the block goes above it.
    const edits = await api.paste.provideDocumentPasteEdits(document, [new vscode.Range(16, 4, 16, 4)], transfer);
    assert.equal(edits?.length, 1);
    const before = sidecarText();
    assert.ok(await vscode.workspace.applyEdit(edits![0]!.additionalEdit!));
    assert.deepEqual(
      [16, 17, 18, 19].map((l) => document.lineAt(l).text),
      ["    ledger.write(order.id)", "    notify(order)", "    return order", "    return ledger.balance(order.account, strict=True)"],
    );
    await waitFor("the moved comments' new anchors in the sidecar", () => sidecarText() !== before);
    const sidecar = sidecarText();
    assert.doesNotMatch(sidecar, /copied-from/);
    for (const id of ["1kjy", "f7eo", "ip6u"]) assert.equal(sidecar.match(new RegExp(`## ${id}\\n`, "g"))?.length, 1, `one entry for ${id}`);
    await document.save();
    await waitFor("the moved comments on the pasted block", async () => {
      const placed = (await api.refresh(editor)).placed!;
      return (
        placed.lenses.some((l) => l.line === 16 && l.title.endsWith(LENSES[1]![1] as string)) &&
        placed.labels.some((l) => l.line === 16 && l.text.endsWith("keyed on order.id")) &&
        placed.lenses.some((l) => l.line === 18 && l.title.endsWith(LENSES[2]![1] as string))
      );
    });
  });

  test("a line moved with Alt+Down or Alt+Up past a commented line keeps both lines' comments", async () => {
    const { api, editor } = await shown("codelens");
    const document = editor.document;
    const shows = async (expected: { lens: [number, string][]; label: number }) => {
      const placed = (await api.refresh(editor)).placed!;
      return expected.lens.every(([line, title]) => placed.lenses.some((l) => l.line === line && l.title.endsWith(title))) && placed.labels.some((l) => l.line === expected.label && l.text.endsWith("keyed on order.id"));
    };
    const settleNote = LENSES[1]![1] as string;
    const returnNote = LENSES[2]![1] as string;
    // `notify(order)` has no comments; the lines it passes do.
    editor.selection = new vscode.Selection(5, 0, 5, 0);
    await vscode.commands.executeCommand("editor.action.moveLinesDownAction");
    assert.equal(document.lineAt(5).text, "    return order");
    assert.ok(await shows({ lens: [[4, settleNote], [5, returnNote]], label: 4 }), "the return's comment moves up with it");

    await vscode.commands.executeCommand("editor.action.moveLinesUpAction");
    await vscode.commands.executeCommand("editor.action.moveLinesUpAction");
    assert.equal(document.lineAt(4).text, "    notify(order)");
    assert.equal(document.lineAt(5).text, "    ledger.write(order.id)");
    assert.ok(await shows({ lens: [[5, settleNote], [6, returnNote]], label: 5 }), "the write's comments move down with it");

    await document.save();
    await waitFor("the same comments after placing from anchors", () => shows({ lens: [[5, settleNote], [6, returnNote]], label: 5 }));
  });

  test("the Activity Bar lists stale and orphaned comments across the repository", async () => {
    const { api } = await open();
    await vscode.commands.executeCommand("cairn.stale.focus");
    await vscode.commands.executeCommand("cairn.orphans.focus");
    await api.lists.refresh();
    assert.deepEqual(
      api.lists.stale().map((c) => [path.basename(c.file), c.line, c.id]),
      [["sample.py", 18, "p7c3"]],
    );
    assert.deepEqual(
      api.lists.orphans().map((c) => [path.basename(c.source), c.id, c.scope, c.text]),
      [["sample.py", "r3cn", "reconcile", "reconcile runs after settle, never before"]],
    );
    await settle(1000);
    await capture("overlay-lists", false);
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
  });
});
