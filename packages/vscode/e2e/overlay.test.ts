import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { TestApi } from "../src/extension.js";
import { cairnActions } from "./actions.js";
import {
  appendBlankLines,
  applyAdditionalEdit,
  applyInsertText,
  bodyText,
  capture,
  clickLens,
  codeLenses,
  comment,
  copied,
  cutAndPasteRefund,
  ENTRY_LENS,
  labelEndingWith,
  lensEndingWith,
  lensRows,
  LENSES,
  lensTitle,
  open,
  pasteEdit,
  placedNow,
  recordRefundAnchors,
  REFUND_LENS,
  refundCommentShown,
  repo,
  reset,
  resetStyle,
  RETURN_LENS,
  samplePath,
  setMode,
  SETTLE_LENS,
  settleNotesOn,
  shown,
  sidecarPath,
  sidecarSaved,
  sidecarText,
  STALE_LENS,
  threadOf,
  TRAILING_LABEL,
  undoStep,
  WRITE_LINE,
} from "./overlay-helpers.js";
import { settle, waitFor } from "./wait.js";

/** Whether `settle`'s note and the trailing label are rendered on `line` now. */
const settleNotesShownOn = async (api: TestApi, editor: vscode.TextEditor, line: number) =>
  settleNotesOn(await placedNow(api, editor), line);

/** Waits until the sidecar holds both comments a whole-line paste of `settle`'s write line copies. */
const bothSettleNotesCopied = () =>
  waitFor(
    "both pasted comments in the sidecar",
    () => /copied-from=1kjy/.test(sidecarText()) && /copied-from=f7eo/.test(sidecarText()),
  );

suite("overlay", () => {
  suiteSetup(async () => {
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
    await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
    await vscode.commands.executeCommand("notifications.clearAll");
  });

  teardown(reset);

  suiteTeardown(resetStyle);

  suite("display", () => {
    test("off: the file shows plain code and nothing else", async () => {
      const { api, editor } = await open();
      await setMode(api, "off");
      const applied = await api.refresh(editor);
      assert.equal(applied.placed, undefined);
      assert.deepEqual(await codeLenses(editor), []);
      assert.equal(api.placed.comment(editor.document, "qmbf"), undefined);
      await settle(500);
      await capture("overlay-off");
    });

    test("codelens: own-line comments sit above their code line; trailing ones end their line", async () => {
      const { editor, placed } = await shown("codelens");
      assert.deepEqual(lensRows(placed), LENSES);
      assert.deepEqual(placed.labels, [{ line: 4, text: TRAILING_LABEL, stale: false }]);
      const lenses = await codeLenses(editor);
      assert.equal(lenses.length, 5);
      await settle(1000);
      await capture("overlay-on");
    });

    test("every comment is a thread with its provenance, collapsed until its CodeLens opens it", async () => {
      const { api, editor, placed } = await shown("codelens");
      assert.deepEqual(
        placed.threads.map((t) => [t.line, t.id, t.expanded]),
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
      assert.equal(
        bodyText(settleNote),
        "retries are safe: ledger write is idempotent\n\nthe ledger dedupes on order.id, so a retried settle is a no-op",
      );
      assert.equal(settleNote.contextValue, "current");
      const audit = comment(api, editor, "p7c3");
      assert.equal(audit.contextValue, "stale");
      assert.equal(audit.label, "possibly stale");

      const lens = (await codeLenses(editor))[1];
      await clickLens(lens);
      assert.equal(threadOf(settleNote).collapsibleState, vscode.CommentThreadCollapsibleState.Expanded);
      await clickLens(lens);
      assert.equal(
        threadOf(settleNote).collapsibleState,
        vscode.CommentThreadCollapsibleState.Collapsed,
        "a second click closes the thread",
      );
    });

    test("thread: each own-line comment is an expanded thread below the line above its code", async () => {
      const { placed } = await shown("thread");
      assert.deepEqual(
        placed.threads.filter((t) => t.expanded).map((t) => t.line),
        [2, 3, 5, 10, 16],
      );
      assert.deepEqual(placed.lenses, []);
      await settle(1000);
      await capture("overlay-thread");
    });

    test("eol: own-line comments end the line above their code", async () => {
      const { placed } = await shown("eol");
      assert.deepEqual(
        placed.labels.map((l) => l.line),
        [2, 3, 4, 5, 10, 16],
      );
      await settle(1000);
      await capture("overlay-eol");
    });
  });

  suite("edits", () => {
    test("comments follow the owner's edits, and are placed from their anchors again on save", async () => {
      const { api, editor } = await shown("codelens");
      // A new first statement in `settle`: its comments move down with their code and stay current until saved.
      await editor.edit((b) => b.insert(new vscode.Position(4, 0), "    log(order)\n"));
      let placed = await placedNow(api, editor);
      // Every lens below the new line moves down one; the first sits above it.
      assert.deepEqual(
        lensRows(placed),
        LENSES.map(([line, title], i) => [i === 0 ? line : line + 1, title]),
      );
      assert.deepEqual(placed.labels, [{ line: 5, text: TRAILING_LABEL, stale: false }]);

      await editor.document.save();
      placed = await placedNow(api, editor);
      assert.deepEqual(lensRows(placed).slice(0, 3), [
        [3, ENTRY_LENS],
        [5, `[stale?] ${SETTLE_LENS}`],
        [7, `[stale?] ${RETURN_LENS}`],
      ]);
    });

    test("a change on disk places the comments again", async () => {
      const { api, editor } = await shown("codelens");
      writeFileSync(samplePath(), "import os\n" + readFileSync(samplePath(), "utf8"));
      await waitFor("the file to reload", () => editor.document.lineAt(0).text === "import os");
      const placed = await placedNow(api, editor);
      assert.deepEqual(
        placed.lenses.map((l) => l.line),
        LENSES.map(([line]) => line + 1),
      );
    });
  });

  suite("comment actions", () => {
    test("Edit changes the body in place and stores it", async () => {
      const { api, editor } = await shown("codelens");
      const refund = comment(api, editor, "ewiw");
      await vscode.commands.executeCommand("cairn.editComment", refund);
      assert.equal(refund.mode, vscode.CommentMode.Editing);
      refund.body = "support refunds a closed order by hand";
      await vscode.commands.executeCommand("cairn.saveComment", refund);
      assert.equal(refund.mode, vscode.CommentMode.Preview);
      assert.match(sidecarText(), /## ewiw\n<!--[^\n]*-->\nsupport refunds a closed order by hand\n/);
      await waitFor(
        "the lens to update",
        async () => lensTitle(await placedNow(api, editor), 3) === "support refunds a closed order by hand",
      );
    });

    test("a thread shows each line of a body on its own line, and edits the lines stored", async () => {
      const { api, editor } = await shown("codelens");
      const lines = "support refunds a closed order by hand\nso there is nothing to reverse";
      const edited = comment(api, editor, "ewiw");
      await vscode.commands.executeCommand("cairn.editComment", edited);
      edited.body = lines;
      await vscode.commands.executeCommand("cairn.saveComment", edited);
      assert.match(
        sidecarText(),
        /## ewiw\n<!--[^\n]*-->\nsupport refunds a closed order by hand\nso there is nothing to reverse\n/,
      );
      await waitFor("the thread to show both lines", async () => {
        await api.refresh(editor);
        return (
          bodyText(comment(api, editor, "ewiw")) ===
          "support refunds a closed order by hand  \nso there is nothing to reverse"
        );
      });

      const refund = comment(api, editor, "ewiw");
      await vscode.commands.executeCommand("cairn.editComment", refund);
      assert.equal(bodyText(refund), lines, "the edit box holds the stored lines");
      await vscode.commands.executeCommand("cairn.cancelCommentEdit", refund);
    });

    test("Confirm clears a stale comment", async () => {
      const { api, editor } = await shown("codelens");
      await vscode.commands.executeCommand("cairn.confirmComment", comment(api, editor, "p7c3"));
      await waitFor(
        "the stale tag to go",
        async () => lensTitle(await placedNow(api, editor), 4) === STALE_LENS.replace("[stale?] ", ""),
      );
      assert.equal(comment(api, editor, "p7c3").contextValue, "current");
    });

    test("Delete removes the entry", async () => {
      const { api, editor } = await shown("codelens");
      await vscode.commands.executeCommand("cairn.deleteComment", comment(api, editor, "ewiw"));
      assert.doesNotMatch(sidecarText(), /## ewiw/);
      await waitFor("the lens to go", async () => (await placedNow(api, editor)).lenses.length === 4);
    });

    test("Promote writes an ordinary comment into the file and removes the entry", async () => {
      const { api, editor } = await shown("codelens");
      await vscode.commands.executeCommand("cairn.promoteComment", comment(api, editor, "ewiw"));
      assert.match(
        readFileSync(samplePath(), "utf8"),
        / {4}if order\.closed:\n {8}# a closed order was already refunded by support by hand\n {8}return None\n/,
      );
      assert.equal(editor.document.isDirty, false);
      assert.doesNotMatch(sidecarText(), /## ewiw/);
      await waitFor("the lens to go", async () => (await placedNow(api, editor)).lenses.length === 4);
    });
  });

  suite("undo", () => {
    // Closing the source without saving once put the ordinary comment back on disk while the
    // unseen sidecar buffer kept the entry: the comment showed twice.
    test("Ctrl+Z after Promote makes it an AI comment again, saved in the source and its sidecar", async () => {
      const { api, editor } = await shown("codelens");
      const committed = { source: readFileSync(samplePath(), "utf8"), sidecar: sidecarText() };
      await vscode.commands.executeCommand("cairn.promoteComment", comment(api, editor, "ewiw"));
      await vscode.window.showTextDocument(editor.document);
      await vscode.commands.executeCommand("undo");
      await waitFor(
        "the undo saved in both files",
        () => readFileSync(samplePath(), "utf8") === committed.source && sidecarText() === committed.sidecar,
      );
      assert.equal(editor.document.isDirty, false);
      await waitFor("the comment back in the overlay", async () => (await placedNow(api, editor)).lenses.length === 5);
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
      const document = editor.document;
      const committed = readFileSync(samplePath(), "utf8");
      const copiedRange = new vscode.Range(9, 0, 15, 0);
      const transfer = await copied(api, document, copiedRange, document.getText(copiedRange));
      const pasteAt = await appendBlankLines(editor);
      const at = new vscode.Range(pasteAt, 0, pasteAt, 0);
      const [pasted] = (await api.paste.provideDocumentPasteEdits(document, [at], transfer)) ?? [];
      if (!pasted?.additionalEdit || typeof pasted.insertText !== "string")
        throw new Error("the paste offered no text and sidecar edit");
      // One edit, as a real paste lands, so one undo step covers the source and the sidecar.
      const edit = new vscode.WorkspaceEdit();
      edit.insert(document.uri, at.start, pasted.insertText);
      for (const [uri, edits] of pasted.additionalEdit.entries()) {
        for (const e of edits) edit.replace(uri, e.range, e.newText);
      }
      assert.ok(await vscode.workspace.applyEdit(edit));
      await sidecarSaved("the pasted comment in the sidecar", (s) => /copied-from=ewiw/.test(s));

      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand("undo");
      await sidecarSaved("the pasted comment gone from the sidecar", (s) => !/copied-from=ewiw/.test(s));
      await settle(500); // a save of the source would follow the sidecar's
      assert.equal(readFileSync(samplePath(), "utf8"), committed, "the edit made before the paste was saved");
      assert.equal(document.isDirty, true);
    });
  });

  suite("strings", () => {
    test("a string that is not a docstring demotes, and Promote writes it back as the same string", async () => {
      const { api } = await open();
      await setMode(api, "on");
      const file = path.join(repo(), "notes.py");
      const notesSidecar = path.join(repo(), ".agents/comments/notes.py.md");
      const original =
        'def settle(order):\n    """Settle one order."""\n    ledger.write(order.id)\n    """\n    Idempotent: keyed on order.id.\n    """\n    notify(order)\n';
      writeFileSync(file, original);
      try {
        const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
        const titles = async (line: number) => (await cairnActions(editor.document.uri, line)).map((a) => a.title);
        assert.deepEqual(await titles(1), [], "a docstring stays in the code");
        assert.deepEqual(await titles(4), ["Demote string to an AI comment (move it to the sidecar)"]);

        assert.equal(
          await vscode.commands.executeCommand("cairn.demoteComment", { file, line: 5 }),
          "demoted 1 comment(s) in 1 file(s)\n",
        );
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
  });

  suite("copy and paste", () => {
    test("a copied function carries its comments to where it is pasted", async () => {
      const { api, editor } = await shown("codelens");
      const document = editor.document;
      // VS Code only asks paste providers on a real copy event, which an unfocused test window
      // never gets, so this drives the provider the way the editor would: copy, then paste.
      const copiedRange = new vscode.Range(9, 0, 15, 0);
      const transfer = await copied(api, document, copiedRange, document.getText(copiedRange));
      const pasteAt = await appendBlankLines(editor);
      const at = new vscode.Range(pasteAt, 0, pasteAt, 0);
      const pasted = await pasteEdit(api, document, at, transfer);
      await applyInsertText(document, pasted, at.start);
      await applyAdditionalEdit(pasted);

      await sidecarSaved("the pasted comment in the sidecar", (s) => /copied-from=ewiw/.test(s));
      const sidecar = sidecarText();
      const id = /## ([0-9a-z]{4})\n<!-- by=claude-code [^\n]*copied-from=ewiw[^\n]*scope=refund@1 /.exec(sidecar)?.[1];
      assert.ok(id, `no copied entry anchored to the second refund in:\n${sidecar}`);
      assert.match(
        sidecar,
        new RegExp(`## ${id}\\n<!--[^\\n]*-->\\na closed order was already refunded by support by hand\\n`),
      );
      const sidecarDocument = vscode.workspace.textDocuments.find((d) => d.fileName === sidecarPath());
      assert.ok(!sidecarDocument?.isDirty, "the sidecar was left unsaved");

      await document.save();
      await waitFor("the pasted comment's lens", async () => {
        const { lenses } = await placedNow(api, editor);
        return lenses.some((l) => l.line === pasteAt + 2 && l.title === REFUND_LENS);
      });
    });

    test("a line copied without a selection carries its comments to a new line above the cursor", async () => {
      const { api, editor } = await shown("codelens");
      const document = editor.document;
      // Ctrl+C with no selection: VS Code reports the line without its break as the copied
      // range, and puts the line with its break on the clipboard.
      const line = document.lineAt(4);
      const transfer = await copied(api, document, new vscode.Range(4, 0, 4, line.text.length), `${line.text}\n`);
      const pasted = await pasteEdit(api, document, new vscode.Range(18, 4, 18, 4), transfer);
      assert.equal(pasted.insertText, "", "a whole-line paste goes on its own line, not at the cursor");
      await applyAdditionalEdit(pasted);
      assert.equal(document.lineAt(18).text, WRITE_LINE);
      assert.equal(document.lineAt(19).text, "    return ledger.balance(order.account, strict=True)");

      await bothSettleNotesCopied();
      await document.save();
      await waitFor("the pasted comments on the new line", async () => {
        const placed = await placedNow(api, editor);
        return (
          placed.lenses.some((l) => l.line === 18 && l.title === SETTLE_LENS) &&
          placed.labels.some((l) => l.line === 18 && l.text === TRAILING_LABEL)
        );
      });
    });
  });

  suite("cut and paste", () => {
    test("a cut function's comments move with it: same ids, no copies", async () => {
      const { api, editor } = await shown("codelens");
      const document = editor.document;
      const cut = new vscode.Range(9, 0, 16, 0);
      const text = document.getText(cut);
      // The extension host sees the cut's deletion before the copy request, whose range still
      // describes the text before the cut (VS Code sends the request after an await).
      await editor.edit((b) => b.delete(cut));
      const transfer = await copied(api, document, cut, text);

      const pasteAt = await appendBlankLines(editor);
      const at = new vscode.Range(pasteAt, 0, pasteAt, 0);
      const pasted = await pasteEdit(api, document, at, transfer);
      const before = sidecarText();
      await applyInsertText(document, pasted, at.start);
      await applyAdditionalEdit(pasted);

      await sidecarSaved("the moved comment's new anchor in the sidecar", (s) => s !== before);
      const sidecar = sidecarText();
      assert.doesNotMatch(sidecar, /copied-from/);
      assert.equal(sidecar.match(/a closed order was already refunded by support by hand/g)?.length, 1);
      assert.match(sidecar, /## ewiw\n/);

      await document.save();
      await waitFor("one lens for the moved comment, on the pasted function", async () => {
        const lenses = (await placedNow(api, editor)).lenses.filter((l) => l.title === REFUND_LENS);
        return lenses.length === 1 && lenses[0]?.line === pasteAt + 2;
      });
    });

    test("a cut function whose entry the paste leaves unchanged shows its comments where it lands, before a save", async () => {
      const { api, editor } = await shown("codelens");
      const document = editor.document;
      // Its comment sits on `return None`, the third of `refund`'s five lines.
      const refundLens = (line: number) => async () =>
        (await placedNow(api, editor)).lenses.some((l) => l.line === line && l.title === REFUND_LENS);

      // The fixture's anchors are hand-written, so the first move records them afresh.
      const committed = sidecarText();
      await cutAndPasteRefund(api, editor, "last line");
      await sidecarSaved("the first move's anchors in the sidecar", (s) => s !== committed);
      await document.save();
      await waitFor("refund's comment on the pasted function", refundLens(16));
      // A late file watcher event for that sidecar change would place the comments again.
      await settle(1_500);

      // Moved again, the comment records exactly the entry it already has.
      const recorded = sidecarText();
      await cutAndPasteRefund(api, editor, 9);
      assert.equal(document.lineAt(9).text, "def refund(order):");
      assert.ok(document.isDirty);
      await waitFor("refund's comment on the pasted function, unsaved", refundLens(11));
      assert.equal(sidecarText(), recorded);
    });
  });

  suite("undo and redo of a cut and paste", () => {
    test("undoing a cut and paste in a dirty buffer shows the comment on the restored function", async () => {
      const { api, editor } = await shown("codelens");
      const document = editor.document;
      await editor.edit((b) => b.insert(new vscode.Position(1, 0), "VERSION = 2\n"));
      const beforeCut = document.getText();
      const committed = sidecarText();
      await cutAndPasteRefund(api, editor, "last line");
      await sidecarSaved("the moved comment's anchors in the sidecar", (s) => s !== committed);
      await waitFor("refund's comment on the pasted function", () => refundCommentShown(api, editor));

      await undoStep("undo", editor);
      await sidecarSaved("the sidecar back as committed", (s) => s === committed);
      await settle(1_500); // the file watcher's event for that save
      await api.refresh(editor);
      await undoStep("undo", editor);
      assert.equal(document.getText(), beforeCut);
      assert.ok(document.isDirty);
      await waitFor("refund's comment on the restored function", () => refundCommentShown(api, editor));
    });

    test("undoing a cut and paste back to the saved text shows the comment on the restored function", async () => {
      const { api, editor } = await shown("codelens");
      const document = editor.document;
      const beforeCut = document.getText();
      const committed = sidecarText();
      await cutAndPasteRefund(api, editor, "last line");
      await sidecarSaved("the moved comment's anchors in the sidecar", (s) => s !== committed);
      await waitFor("refund's comment on the pasted function", () => refundCommentShown(api, editor));

      await undoStep("undo", editor);
      await sidecarSaved("the sidecar back as committed", (s) => s === committed);
      await settle(1_500);
      await api.refresh(editor);
      await undoStep("undo", editor);
      assert.equal(document.getText(), beforeCut);
      assert.ok(!document.isDirty);
      await waitFor("refund's comment on the restored function", () => refundCommentShown(api, editor));
    });

    test("undoing a cut and paste that left the sidecar unchanged, in a dirty buffer, shows the comment on the restored function", async () => {
      const { api, editor } = await shown("codelens");
      const document = editor.document;
      await recordRefundAnchors(api, editor);
      const recorded = sidecarText();
      await editor.edit((b) => b.insert(new vscode.Position(1, 0), "VERSION = 2\n"));
      const beforeCut = document.getText();
      const audit = document
        .getText()
        .split("\n")
        .findIndex((l) => l.startsWith("def audit"));
      await cutAndPasteRefund(api, editor, audit - 2);
      await waitFor("refund's comment on the pasted function", () => refundCommentShown(api, editor));
      assert.equal(sidecarText(), recorded);

      await undoStep("undo", editor);
      await api.refresh(editor);
      await undoStep("undo", editor);
      assert.equal(document.getText(), beforeCut);
      assert.ok(document.isDirty);
      await waitFor("refund's comment on the restored function", () => refundCommentShown(api, editor));
    });

    test("redoing an undone cut and paste that left the sidecar unchanged shows the comment on the moved function", async () => {
      const { api, editor } = await shown("codelens");
      const document = editor.document;
      await recordRefundAnchors(api, editor);
      const recorded = sidecarText();
      await editor.edit((b) => b.insert(new vscode.Position(1, 0), "VERSION = 2\n"));
      const beforeCut = document.getText();
      const audit = document
        .getText()
        .split("\n")
        .findIndex((l) => l.startsWith("def audit"));
      await cutAndPasteRefund(api, editor, audit - 2);
      const afterPaste = document.getText();
      await waitFor("refund's comment on the pasted function", () => refundCommentShown(api, editor));

      await undoStep("undo", editor);
      await api.refresh(editor);
      await undoStep("undo", editor);
      assert.equal(document.getText(), beforeCut);
      await api.refresh(editor);
      await undoStep("redo", editor);
      await api.refresh(editor);
      await undoStep("redo", editor);
      assert.equal(document.getText(), afterPaste);
      assert.equal(sidecarText(), recorded);
      await waitFor("refund's comment on the moved function", () => refundCommentShown(api, editor));
    });

    test("undo and redo of a cut and paste write neither the sidecar nor the seen record", async () => {
      const { api, editor } = await shown("codelens");
      const document = editor.document;
      await recordRefundAnchors(api, editor);
      // The CLI's record of the ids it last wrote into this worktree's files (design.md § Anchoring, "Deleting").
      const seenDir = path.join(repo(), ".git", "cairn", "seen");
      const seenRecord = () =>
        existsSync(seenDir) ? readdirSync(seenDir).map((f) => f + readFileSync(path.join(seenDir, f), "utf8")) : [];
      const recorded = { sidecar: readFileSync(sidecarPath()), seen: seenRecord() };
      const unchanged = (step: string) => {
        assert.ok(readFileSync(sidecarPath()).equals(recorded.sidecar), `the sidecar changed on disk after ${step}`);
        assert.deepEqual(seenRecord(), recorded.seen, `the seen record changed after ${step}`);
      };
      await editor.edit((b) => b.insert(new vscode.Position(1, 0), "VERSION = 2\n"));
      const audit = document
        .getText()
        .split("\n")
        .findIndex((l) => l.startsWith("def audit"));
      await cutAndPasteRefund(api, editor, audit - 2);
      await api.refresh(editor);
      unchanged("the paste");

      for (const [i, step] of (["undo", "undo", "redo", "redo"] as const).entries()) {
        await undoStep(step, editor);
        await api.refresh(editor);
        unchanged(`${step} ${i + 1}`);
      }
    });

    test("an undo leaves the comments of a function with unsaved edits where tracking put them, not stale", async () => {
      const { api, editor } = await shown("codelens");
      const document = editor.document;
      // A late file watcher event for the previous test's sidecar reset would place the dirty buffer from anchors.
      await settle(1_500);
      // Inside `settle`, between its commented lines: placed from anchors, its comments would turn stale.
      await editor.edit((b) => b.insert(new vscode.Position(5, 0), "    log(order)\n"));
      const tracked = (await api.refresh(editor)).placed;
      const trackedSites = api.placed.sites(document);
      assert.ok(
        tracked?.lenses.some((l) => l.line === 7 && l.title === RETURN_LENS),
        "ip6u moved down with its line, not stale",
      );

      await editor.edit((b) => b.insert(new vscode.Position(0, 0), "VERSION = 2\n"));
      await api.refresh(editor);
      await undoStep("undo", editor);
      assert.equal(document.lineAt(0).text, "import ledger");
      assert.deepEqual((await api.refresh(editor)).placed, tracked);
      assert.deepEqual(api.placed.sites(document), trackedSites);
    });

    test("two refreshes at once after an undo both keep the tracked comments as tracked", async () => {
      const { api, editor } = await shown("codelens");
      const document = editor.document;
      // As above: a late watcher event from an earlier sidecar reset would place from anchors.
      await settle(1_500);
      await editor.edit((b) => b.insert(new vscode.Position(5, 0), "    log(order)\n"));
      const tracked = (await api.refresh(editor)).placed;
      const trackedSites = api.placed.sites(document);
      await editor.edit((b) => b.insert(new vscode.Position(0, 0), "VERSION = 2\n"));
      await api.refresh(editor);

      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand("undo");
      assert.equal(document.lineAt(0).text, "import ledger");
      // The debounced refresh after an edit can run while another refresh is still placing.
      const both = await Promise.all([api.refresh(editor), api.refresh(editor)]);
      assert.deepEqual(
        both.map((applied) => applied.placed),
        [tracked, tracked],
      );
      assert.deepEqual(api.placed.sites(document), trackedSites);
      assert.deepEqual((await api.refresh(editor)).placed, tracked);
    });

    test("a save after undoing or redoing a cut and paste shows the comment where refund is", async () => {
      const { api, editor } = await shown("codelens");
      const document = editor.document;
      await recordRefundAnchors(api, editor);
      await editor.edit((b) => b.insert(new vscode.Position(1, 0), "VERSION = 2\n"));
      const audit = document
        .getText()
        .split("\n")
        .findIndex((l) => l.startsWith("def audit"));
      await cutAndPasteRefund(api, editor, audit - 2);
      await waitFor("refund's comment on the pasted function", () => refundCommentShown(api, editor));

      await undoStep("undo", editor);
      await undoStep("undo", editor);
      await document.save();
      await waitFor("refund's comment on the restored function after a save", () => refundCommentShown(api, editor));
      await undoStep("redo", editor);
      await undoStep("redo", editor);
      await document.save();
      await waitFor("refund's comment on the moved function after a save", () => refundCommentShown(api, editor));
    });
  });

  suite("lines and blocks", () => {
    test("a highlighted line, whatever whitespace the highlight leaves out, pastes like a whole-line copy", async () => {
      const { api, editor } = await shown("codelens");
      const document = editor.document;
      const copiedRange = new vscode.Range(4, 4, 4, document.lineAt(4).text.length);
      const transfer = await copied(api, document, copiedRange, document.getText(copiedRange));
      const pasted = await pasteEdit(api, document, new vscode.Range(18, 4, 18, 4), transfer);
      assert.equal(pasted.insertText, "");
      await applyAdditionalEdit(pasted);
      assert.equal(document.lineAt(18).text, WRITE_LINE, "the whole line, indentation included, above the cursor");
      await bothSettleNotesCopied();
    });

    test("a line cut without a selection moves its comments to where it is pasted", async () => {
      const { api, editor } = await shown("codelens");
      const document = editor.document;
      const line = document.lineAt(4);
      // Ctrl+X with no selection deletes the line and its break; the copy request comes after.
      await editor.edit((b) => b.delete(new vscode.Range(4, 0, 5, 0)));
      const transfer = await copied(api, document, new vscode.Range(4, 0, 4, line.text.length), `${line.text}\n`);
      const pasted = await pasteEdit(api, document, new vscode.Range(5, 4, 5, 4), transfer);
      const before = sidecarText();
      await applyAdditionalEdit(pasted);
      assert.equal(document.lineAt(5).text, WRITE_LINE);
      await sidecarSaved("the moved comments' new anchors in the sidecar", (s) => s !== before);
      assert.doesNotMatch(sidecarText(), /copied-from/);
      await document.save();
      await waitFor("the moved comments on the pasted line", () => settleNotesShownOn(api, editor, 5));
    });

    test("a line moved with Alt+Down keeps its comments, before and after a save", async () => {
      const { api, editor } = await shown("codelens");
      editor.selection = new vscode.Selection(4, 0, 4, 0);
      await vscode.commands.executeCommand("editor.action.moveLinesDownAction");
      assert.equal(editor.document.lineAt(5).text, WRITE_LINE);
      assert.ok(await settleNotesShownOn(api, editor, 5), "the comments follow the line while the file is unsaved");
      await editor.document.save();
      await waitFor("the comments on the moved line after placing from anchors", () =>
        settleNotesShownOn(api, editor, 5),
      );
    });

    test("a line cut from its first non-blank character moves its comments to where it is pasted", async () => {
      const { api, editor } = await shown("codelens");
      const document = editor.document;
      const line = document.lineAt(4);
      // A highlight from the first non-blank character to the end of the line, then Ctrl+X.
      const cut = new vscode.Range(4, 4, 4, line.text.length);
      await editor.edit((b) => b.delete(cut));
      const transfer = await copied(api, document, cut, line.text.trimStart());
      const pasted = await pasteEdit(api, document, new vscode.Range(18, 4, 18, 4), transfer);
      const before = sidecarText();
      await applyAdditionalEdit(pasted);
      assert.equal(document.lineAt(18).text, WRITE_LINE);
      await sidecarSaved("the moved comments' new anchors in the sidecar", (s) => s !== before);
      assert.doesNotMatch(sidecarText(), /copied-from/);
      assert.equal(
        sidecarText().match(/keyed on order\.id/g)?.length,
        1,
        "the trailing comment moved rather than being copied",
      );
      await document.save();
      await waitFor("the moved comments on the pasted line", () => settleNotesShownOn(api, editor, 18));
    });

    test("a block cut from its first non-blank character moves the comments on its first line too", async () => {
      const { api, editor } = await shown("codelens");
      const document = editor.document;
      // settle's body, highlighted from `ledger` on its first line to the end of its last.
      const cut = new vscode.Range(4, 4, 6, document.lineAt(6).text.length);
      const text = document.getText(cut);
      await editor.edit((b) => b.delete(cut));
      const transfer = await copied(api, document, cut, text);
      // Two lines shorter, audit's return is now line 16; the block goes above it.
      const pasted = await pasteEdit(api, document, new vscode.Range(16, 4, 16, 4), transfer);
      const before = sidecarText();
      await applyAdditionalEdit(pasted);
      assert.deepEqual(
        [16, 17, 18, 19].map((l) => document.lineAt(l).text),
        [WRITE_LINE, "    notify(order)", "    return order", "    return ledger.balance(order.account, strict=True)"],
      );
      await sidecarSaved("the moved comments' new anchors in the sidecar", (s) => s !== before);
      const sidecar = sidecarText();
      assert.doesNotMatch(sidecar, /copied-from/);
      for (const id of ["1kjy", "f7eo", "ip6u"]) {
        assert.equal(sidecar.match(new RegExp(`## ${id}\\n`, "g"))?.length, 1, `one entry for ${id}`);
      }
      await document.save();
      await waitFor("the moved comments on the pasted block", async () => {
        const placed = await placedNow(api, editor);
        return settleNotesOn(placed, 16) && lensEndingWith(placed, 18, RETURN_LENS);
      });
    });

    test("a line moved with Alt+Down or Alt+Up past a commented line keeps both lines' comments", async () => {
      const { api, editor } = await shown("codelens");
      const document = editor.document;
      /** Whether each `[line, title]` lens and the trailing label on `label` are rendered now. */
      const shows = async (lens: [number, string][], label: number) => {
        const placed = await placedNow(api, editor);
        return (
          lens.every(([line, title]) => lensEndingWith(placed, line, title)) &&
          labelEndingWith(placed, label, TRAILING_LABEL)
        );
      };
      const afterDown: [number, string][] = [
        [4, SETTLE_LENS],
        [5, RETURN_LENS],
      ];
      const afterUps: [number, string][] = [
        [5, SETTLE_LENS],
        [6, RETURN_LENS],
      ];
      // `notify(order)` has no comments; the lines it passes do.
      editor.selection = new vscode.Selection(5, 0, 5, 0);
      await vscode.commands.executeCommand("editor.action.moveLinesDownAction");
      assert.equal(document.lineAt(5).text, "    return order");
      assert.ok(await shows(afterDown, 4), "the return's comment moves up with it");

      await vscode.commands.executeCommand("editor.action.moveLinesUpAction");
      await vscode.commands.executeCommand("editor.action.moveLinesUpAction");
      assert.equal(document.lineAt(4).text, "    notify(order)");
      assert.equal(document.lineAt(5).text, WRITE_LINE);
      assert.ok(await shows(afterUps, 5), "the write's comments move down with it");

      await document.save();
      await waitFor("the same comments after placing from anchors", () => shows(afterUps, 5));
    });
  });

  suite("lists", () => {
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
});
