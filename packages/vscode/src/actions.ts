// Actions on markerless comments, from their thread's buttons or from the palette with the
// cursor on the code a comment describes. They change the sidecar in process against the
// open document, which may be unsaved, as confirm does for markers.
import * as vscode from "vscode";
import { confirmPlaced, normalizeBody, promotePlaced, serializeSidecar, type Sidecar } from "@cairn-comments/core";
import { applyFiles } from "./edits.js";
import { PlacedComment, type PlacedView } from "./placed.js";

export interface Located {
  root: string;
  /** Root-relative, forward-slash path used for the sidecar and the language lookup. */
  file: string;
  sidecar: string;
}

/** A comment named by a thread, a hover link, or a list (absolute source path). */
export interface CommentRef {
  file: string;
  id: string;
}

export interface PlacedRef {
  document: vscode.TextDocument;
  located: Located;
  id: string;
}

export interface ActionDeps {
  view: PlacedView;
  locate(document: vscode.TextDocument): Located | undefined;
  /** Whether `document` shows its comments without markers. */
  isMarkerless(document: vscode.TextDocument): boolean;
  sidecar(path: string): Sidecar | undefined;
  /** Called after a sidecar was written, so everything showing it refreshes. */
  written(path: string): void;
}

export class MarkerlessActions {
  constructor(private readonly deps: ActionDeps) {}

  /** The markerless comment `arg` names, or the one at the cursor; undefined in a file with markers. */
  async resolve(arg?: CommentRef): Promise<PlacedRef | undefined> {
    const editor = vscode.window.activeTextEditor;
    const document = arg ? await vscode.workspace.openTextDocument(arg.file) : editor?.document;
    if (!document || !this.deps.isMarkerless(document)) return undefined;
    const located = this.deps.locate(document);
    const id = arg?.id ?? (editor && this.deps.view.idAt(document, editor.selection.active.line));
    return located && id ? { document, located, id } : undefined;
  }

  async confirm(ref: PlacedRef): Promise<void> {
    const sidecar = this.deps.sidecar(ref.located.sidecar);
    if (!sidecar) return;
    const result = await confirmPlaced(ref.located.file, ref.document.getText(), sidecar, [ref.id]);
    if (result.changed) await this.write(ref.located.sidecar, result.sidecar, ref.document);
  }

  /**
   * Writes the body into the file as an ordinary comment and drops its entry, in one edit
   * so Ctrl+Z restores both, then saves both, as the CLI's promote leaves them.
   */
  async promote(ref: PlacedRef): Promise<void> {
    const sidecar = this.deps.sidecar(ref.located.sidecar);
    if (!sidecar) return;
    const result = await promotePlaced(ref.located.file, ref.document.getText(), sidecar, [ref.id]);
    if (result.missing.length) {
      void vscode.window.showInformationMessage("This AI comment no longer places in the code, so there is nowhere to promote it to.");
      return;
    }
    const files = new Map([
      [ref.document.fileName, result.source],
      [ref.located.sidecar, sidecarText(result.sidecar)],
    ]);
    if (await applyFiles(files)) this.deps.written(ref.located.sidecar);
  }

  async delete(ref: PlacedRef): Promise<void> {
    const sidecar = this.deps.sidecar(ref.located.sidecar);
    if (!sidecar?.entries.some((e) => e.id === ref.id)) return;
    await this.write(ref.located.sidecar, { preamble: sidecar.preamble, entries: sidecar.entries.filter((e) => e.id !== ref.id) }, ref.document);
  }

  startEdit(comment: PlacedComment): void {
    this.deps.view.setEditing(comment, true, this.entryOf(comment)?.body);
  }

  cancelEdit(comment: PlacedComment): void {
    const entry = this.entryOf(comment);
    this.deps.view.setEditing(comment, false, entry?.body);
  }

  /** Stores the edited body; an emptied body cancels, since deleting has its own action. */
  async saveEdit(comment: PlacedComment): Promise<void> {
    const text = normalizeBody(typeof comment.body === "string" ? comment.body : comment.body.value);
    const document = await vscode.workspace.openTextDocument(comment.file);
    const located = this.deps.locate(document);
    const sidecar = located && this.deps.sidecar(located.sidecar);
    const entry = sidecar?.entries.find((e) => e.id === comment.id);
    if (!located || !sidecar || !entry || !text) {
      this.cancelEdit(comment);
      return;
    }
    this.deps.view.setEditing(comment, false, text);
    if (text === entry.body) return;
    const entries = sidecar.entries.map((e) => (e.id === comment.id ? { ...e, body: text } : e));
    await this.write(located.sidecar, { preamble: sidecar.preamble, entries }, document);
  }

  private entryOf(comment: PlacedComment) {
    const document = vscode.workspace.textDocuments.find((d) => d.fileName === comment.file);
    const located = document && this.deps.locate(document);
    return located && this.deps.sidecar(located.sidecar)?.entries.find((e) => e.id === comment.id);
  }

  /** Writes a sidecar in one edit that Ctrl+Z in `source`, the file it describes, undoes. */
  private async write(path: string, sidecar: Sidecar, source: vscode.TextDocument): Promise<void> {
    await applyFiles(new Map([[path, sidecarText(sidecar)]]), source);
    this.deps.written(path);
  }
}

/** A sidecar's file contents; null once it has no entries, since the CLI deletes an emptied sidecar. */
export function sidecarText(sidecar: Sidecar): string | null {
  return sidecar.entries.length || sidecar.preamble ? serializeSidecar(sidecar) : null;
}
