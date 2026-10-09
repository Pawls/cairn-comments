// The overlay on a repository in private mode (design.md § Private mode): the fixture's sidecar
// lives in the git dir's store, outside the workspace's file glob and out of `git checkout`'s reach.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { comment, LENSES, lensRows, placedNow, repo, reset, samplePath, shown } from "./overlay-helpers.js";
import { waitFor } from "./wait.js";

const storedSidecar = () => path.join(repo(), ".git", "cairn", "comments", "sample.py.md");
const storedText = () => readFileSync(storedSidecar(), "utf8");

suite("private store", () => {
  let committed: string;

  suiteSetup(async () => {
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
    await vscode.commands.executeCommand("notifications.clearAll");
    committed = storedText();
  });

  // `reset` restores the worktree; the store is put back first, so its buffer reloads with it.
  teardown(async () => {
    if (storedText() !== committed) writeFileSync(storedSidecar(), committed);
    await reset();
  });

  test("the overlay shows the comments kept in the git dir", async () => {
    const { placed } = await shown("codelens");
    assert.deepEqual(lensRows(placed), LENSES);
  });

  test("a write to the store from outside the editor reaches the overlay", async () => {
    const { api, editor } = await shown("codelens");
    writeFileSync(storedSidecar(), committed.replace("Settlement entry point;", "Entry point;"));
    await waitFor("the edited comment", async () => {
      const lenses = (await api.refresh(editor)).placed?.lenses ?? [];
      return lenses.some((l) => l.title.startsWith("Entry point;"));
    });
  });

  test("Edit stores the new body in the git dir", async () => {
    const { api, editor } = await shown("codelens");
    const refund = comment(api, editor, "ewiw");
    await vscode.commands.executeCommand("cairn.editComment", refund);
    refund.body = "support refunds a closed order by hand";
    await vscode.commands.executeCommand("cairn.saveComment", refund);
    assert.match(storedText(), /## ewiw\n<!--[^\n]*-->\nsupport refunds a closed order by hand\n/);
  });

  test("Ctrl+Z after Promote puts back both the source and the stored sidecar", async () => {
    const { api, editor } = await shown("codelens");
    const source = readFileSync(samplePath(), "utf8");
    await vscode.commands.executeCommand("cairn.promoteComment", comment(api, editor, "ewiw"));
    assert.doesNotMatch(storedText(), /## ewiw/);
    await vscode.window.showTextDocument(editor.document);
    await vscode.commands.executeCommand("undo");
    await waitFor(
      "the undo saved in both files",
      () => readFileSync(samplePath(), "utf8") === source && storedText() === committed,
    );
    await waitFor("the comment back in the overlay", async () => (await placedNow(api, editor)).lenses.length === 5);
  });
});
