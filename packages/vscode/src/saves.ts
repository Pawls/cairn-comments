// Saves the extension makes on the owner's behalf, after edits VS Code applies without saving:
// a paste's sidecar change, and an undo of one of the extension's own edits.
import * as vscode from "vscode";
import { isSidecar, locate } from "./sidecars.js";

/** How long a paste's sidecar change is expected before a later change is no longer taken for it. */
const PASTE_SAVE_WINDOW_MS = 5_000;

/** How close together a source's and its sidecar's undo events must come to count as one undo step. */
const UNDO_PAIR_MS = 1_000;

/** Sidecars a paste edit is about to change, each saved once the change arrives. */
export class PasteSaves implements vscode.Disposable {
  private readonly pending = new Map<string, NodeJS.Timeout>();

  /** Called with a sidecar a paste edit is about to change. */
  expect(file: string): void {
    clearTimeout(this.pending.get(file));
    this.pending.set(
      file,
      setTimeout(() => this.pending.delete(file), PASTE_SAVE_WINDOW_MS),
    );
  }

  /** Saves a changed sidecar when a paste edit was expected to change it. */
  saveIfExpected(sidecar: vscode.TextDocument): void {
    const pending = this.pending.get(sidecar.fileName);
    if (!pending || !sidecar.isDirty) return;
    clearTimeout(pending);
    this.pending.delete(sidecar.fileName);
    void sidecar.save();
  }

  dispose(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
  }
}

/**
 * An undo or redo that reaches a sidecar reverts one of the extension's own edits (Ctrl+Z
 * asks to undo across files). Its buffer is saved at once, and the source too when the same
 * step changed it and it had no unsaved edits before; see design.md § Promote and demote,
 * "Undo". The two files' changes arrive as separate events, in either order, so each is
 * remembered for a moment.
 */
export class UndoSaves {
  private readonly undoneAt = new Map<string, number>();
  private readonly unchangedSinceSave = new Set<string>();

  changed(event: vscode.TextDocumentChangeEvent): void {
    const uri = event.document.uri.toString();
    // An event with no changes only reports the dirty flag.
    if (event.reason !== undefined) {
      void this.saveUndone(event.document);
    } else if (event.contentChanges.length) {
      this.undoneAt.delete(uri);
      this.unchangedSinceSave.delete(uri);
    }
  }

  /** Called when a source file (not a sidecar) is saved. */
  saved(source: vscode.TextDocument): void {
    this.unchangedSinceSave.add(source.uri.toString());
  }

  /** Called when a source file (not a sidecar) is closed. */
  closed(source: vscode.TextDocument): void {
    this.unchangedSinceSave.delete(source.uri.toString());
  }

  private justUndone(document: vscode.TextDocument): boolean {
    return Date.now() - (this.undoneAt.get(document.uri.toString()) ?? -Infinity) < UNDO_PAIR_MS;
  }

  private async saveUndone(document: vscode.TextDocument): Promise<void> {
    this.undoneAt.set(document.uri.toString(), Date.now());
    const sidecarFile = isSidecar(document) ? document.fileName : locate(document)?.sidecar;
    const sidecar = vscode.workspace.textDocuments.find((d) => sameFile(sidecarFile, d.uri));
    if (!sidecar || !this.justUndone(sidecar) || isInTab(sidecar.uri)) return;
    const source = vscode.workspace.textDocuments.find((d) => !isSidecar(d) && sameFile(locate(d)?.sidecar, sidecar.uri));
    // Not guarded by isDirty: the change event arrives before the dirty flag does.
    await sidecar.save();
    if (source && this.justUndone(source) && this.unchangedSinceSave.has(source.uri.toString())) await source.save();
  }
}

function sameFile(file: string | undefined, uri: vscode.Uri): boolean {
  return file !== undefined && vscode.Uri.file(file).toString() === uri.toString();
}

/** Whether a tab shows `uri`, so its unsaved changes are the user's to keep or discard. */
function isInTab(uri: vscode.Uri): boolean {
  return vscode.window.tabGroups.all.some((group) =>
    group.tabs.some((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString()),
  );
}
