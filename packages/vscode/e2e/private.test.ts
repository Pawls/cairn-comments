// The overlay on a repository in private mode (design.md § Private mode): the fixture's sidecar
// lives in the git dir's store, outside the workspace's file glob.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { LENSES, lensRows, repo, shown } from "./overlay-helpers.js";
import { waitFor } from "./wait.js";

const storedSidecar = () => path.join(repo(), ".git", "cairn", "comments", "sample.py.md");

suite("private store", () => {
  suiteSetup(async () => {
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
    await vscode.commands.executeCommand("notifications.clearAll");
  });

  test("the overlay shows the comments kept in the git dir", async () => {
    const { placed } = await shown("codelens");
    assert.deepEqual(lensRows(placed), LENSES);
  });

  test("a write to the store from outside the editor reaches the overlay", async () => {
    const { api, editor } = await shown("codelens");
    const original = readFileSync(storedSidecar(), "utf8");
    writeFileSync(storedSidecar(), original.replace("Settlement entry point;", "Entry point;"));
    try {
      await waitFor("the edited comment", async () => {
        const lenses = (await api.refresh(editor)).placed?.lenses ?? [];
        return lenses.some((l) => l.title.startsWith("Entry point;"));
      });
    } finally {
      writeFileSync(storedSidecar(), original);
    }
  });
});
