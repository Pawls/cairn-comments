// Actions on markerless comments, from their thread's buttons or from the palette with the
// cursor on the code a comment describes. They change the sidecar in process against the
// open document, which may be unsaved, as confirm does for markers.
import * as vscode from "vscode";
import { confirmPlaced, normalizeBody, promotePlaced, serializeSidecar, type Sidecar } from "@cairn-comments/core";
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
    if (result.changed) await this.write(ref.located.sidecar, result.sidecar);
  }

  /** Writes the body into the file as an ordinary comment, then saves both, as the CLI's promote leaves them. */
  async promote(ref: PlacedRef): Promise<void> {
    const sidecar = this.deps.sidecar(ref.located.sidecar);
    if (!sidecar) return;
    const code = ref.document.getText();
    const result = await promotePlaced(ref.located.file, code, sidecar, [ref.id]);
    if (result.missing.length) {
      void vscode.window.showInformationMessage("This AI comment no longer places in the code, so there is nowhere to promote it to.");
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    const changed = changedSpan(code, result.source);
    edit.replace(ref.document.uri, new vscode.Range(ref.document.positionAt(changed.start), ref.document.positionAt(changed.end)), changed.text);
    if (!(await vscode.workspace.applyEdit(edit))) return;
    await ref.document.save();
    await this.write(ref.located.sidecar, result.sidecar);
  }

  async delete(ref: PlacedRef): Promise<void> {
    const sidecar = this.deps.sidecar(ref.located.sidecar);
    if (!sidecar?.entries.some((e) => e.id === ref.id)) return;
    await this.write(ref.located.sidecar, { preamble: sidecar.preamble, entries: sidecar.entries.filter((e) => e.id !== ref.id) });
  }

  startEdit(comment: PlacedComment): void {
    this.deps.view.setEditing(comment, true);
  }

  cancelEdit(comment: PlacedComment): void {
    const entry = this.entryOf(comment);
    this.deps.view.setEditing(comment, false, entry?.body);
  }

  /** Stores the edited body; an emptied body cancels, since deleting has its own action. */
  async saveEdit(comment: PlacedComment): Promise<void> {
    const text = normalizeBody(typeof comment.body === "string" ? comment.body : comment.body.value);
    const located = this.deps.locate(await vscode.workspace.openTextDocument(comment.file));
    const sidecar = located && this.deps.sidecar(located.sidecar);
    const entry = sidecar?.entries.find((e) => e.id === comment.id);
    if (!located || !sidecar || !entry || !text) {
      this.cancelEdit(comment);
      return;
    }
    this.deps.view.setEditing(comment, false, text);
    if (text === entry.body) return;
    const entries = sidecar.entries.map((e) => (e.id === comment.id ? { ...e, body: text } : e));
    await this.write(located.sidecar, { preamble: sidecar.preamble, entries });
  }

  private entryOf(comment: PlacedComment) {
    const document = vscode.workspace.textDocuments.find((d) => d.fileName === comment.file);
    const located = document && this.deps.locate(document);
    return located && this.deps.sidecar(located.sidecar)?.entries.find((e) => e.id === comment.id);
  }

  private async write(path: string, sidecar: Sidecar): Promise<void> {
    await writeSidecar(path, sidecar);
    this.deps.written(path);
  }
}

/**
 * Writes a sidecar: through its editor when one is open, so the buffer and disk agree, else
 * straight to disk as LF bytes. A sidecar left with no entries is deleted, as the CLI does.
 */
export async function writeSidecar(path: string, sidecar: Sidecar): Promise<void> {
  const uri = vscode.Uri.file(path);
  const text = serializeSidecar(sidecar);
  const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.fileName === path);
  if (open) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length)), text);
    if (await vscode.workspace.applyEdit(edit)) await open.save();
    return;
  }
  if (!sidecar.entries.length && !sidecar.preamble) await vscode.workspace.fs.delete(uri);
  else await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

/** The one span that turns `before` into `after`, so an edit leaves the rest of the buffer (and its undo history) alone. */
export function changedSpan(before: string, after: string): { start: number; end: number; text: string } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let tail = 0;
  while (tail < before.length - start && tail < after.length - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  return { start, end: before.length - tail, text: after.slice(start, after.length - tail) };
}
