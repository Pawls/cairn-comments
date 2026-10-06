// Rewrites of several files applied as one WorkspaceEdit, so a single Ctrl+Z (VS Code asks
// whether to undo across the files) reverts a source file and its sidecar together. A
// rewrite written to disk instead reaches an open editor as a reload, which Ctrl+Z undoes
// in that file alone, leaving the sidecar out of step.
import path from "node:path";
import * as vscode from "vscode";

/** The one span that turns `before` into `after`, so an edit leaves the rest of the buffer (and its undo history) alone. */
export function changedSpan(before: string, after: string): { start: number; end: number; text: string } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let tail = 0;
  const maxTail = Math.min(before.length, after.length) - start;
  while (tail < maxTail && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  return { start, end: before.length - tail, text: after.slice(start, after.length - tail) };
}

/** Adds to `edit` what makes the file at `file` (absolute) hold `text`; null deletes it. */
export async function addFileEdit(edit: vscode.WorkspaceEdit, file: string, text: string | null): Promise<void> {
  const uri = vscode.Uri.file(file);
  const exists = await vscode.workspace.fs.stat(uri).then(
    () => true,
    () => false,
  );
  if (text === null) {
    if (exists) edit.deleteFile(uri, { ignoreIfNotExists: true });
    return;
  }
  if (!exists) {
    edit.createFile(uri, { contents: new TextEncoder().encode(text) });
    return;
  }
  const document = await vscode.workspace.openTextDocument(uri);
  const span = changedSpan(document.getText(), text);
  if (span.start === span.end && !span.text) return;
  edit.replace(uri, new vscode.Range(document.positionAt(span.start), document.positionAt(span.end)), span.text);
}

/**
 * Applies `files` (absolute path to new contents, null to delete) as one edit, then saves
 * each document it changed, as a CLI rewrite would leave them. False when VS Code refused the edit.
 * Ctrl+Z in `undoFrom` also undoes the edit: an empty edit to it puts it in the same undo
 * step without changing or dirtying it.
 */
export async function applyFiles(files: ReadonlyMap<string, string | null>, undoFrom?: vscode.TextDocument): Promise<boolean> {
  const edit = new vscode.WorkspaceEdit();
  for (const [file, text] of files) await addFileEdit(edit, file, text);
  if (undoFrom && !files.has(undoFrom.fileName)) edit.insert(undoFrom.uri, new vscode.Position(0, 0), "");
  if (!(await vscode.workspace.applyEdit(edit))) return false;
  const changed = new Set([...files.keys()].map((f) => vscode.Uri.file(f).toString()));
  for (const document of vscode.workspace.textDocuments) {
    if (changed.has(document.uri.toString()) && document.isDirty) await document.save();
  }
  return true;
}

/** Applies what `<cli> ... --print` reported (`{report, files}`, paths relative to `root`); resolves to its report. */
export async function applyPrinted(root: string, output: string): Promise<string> {
  const printed = JSON.parse(output) as { report: string; files: Record<string, string | null> };
  const files = new Map(Object.entries(printed.files).map(([file, text]) => [path.join(root, file), text]));
  if (!(await applyFiles(files))) throw new Error("VS Code did not apply the rewrite");
  return printed.report;
}

/** Saves the open, modified documents among `files` (absolute), so a CLI run reads what the owner sees. */
export async function saveOpen(files: readonly string[]): Promise<void> {
  const wanted = new Set(files.map((f) => vscode.Uri.file(f).toString()));
  for (const document of vscode.workspace.textDocuments) {
    if (wanted.has(document.uri.toString()) && document.isDirty) await document.save();
  }
}
