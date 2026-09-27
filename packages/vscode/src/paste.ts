// Copy and paste carry markerless comments (design.md § Overlay rendering, "Copy and paste"):
// a copy records the comments it covers, and a paste of that same text adds them to the
// target file's sidecar, anchored where they landed. A comment whose original no longer
// places by then was cut, so it moves instead of being copied.
import * as vscode from "vscode";
import { BRAND, carryComments, serializeSidecar, type CommentSite, type Sidecar, type SidecarEntry } from "@cairn-comments/core";
import { copiedSites } from "./tracking.js";

const MIME = `application/vnd.${BRAND}.comments+json`;
export const PASTE_KIND = vscode.DocumentDropOrPasteEditKind.Text.append(BRAND);

/** A markerless file the extension can read comments from or add them to. */
export interface PasteTarget {
  /** The repository (sidecar) root, absolute. */
  root: string;
  /** Root-relative source path. */
  file: string;
  sidecarPath: string;
  sidecar: Sidecar;
  /** Whether the sidecar already anchors comments without markers. */
  placed: boolean;
}

export interface PasteDeps {
  /** The document as a markerless file, or undefined when it holds markers or is not a source file. */
  target(document: vscode.TextDocument): Promise<PasteTarget | undefined>;
  /** Current comment sites of a markerless document. */
  sites(document: vscode.TextDocument): Promise<readonly CommentSite[]>;
  entries(target: PasteTarget): ReadonlyMap<string, SidecarEntry>;
  /** Called with a sidecar a paste edit is about to change, so it can be saved once it has. */
  willChange(sidecarPath: string): void;
}

interface Payload {
  root: string;
  /** The copied document's absolute path, where a cut comment's original entry lives. */
  source: string;
  text: string;
  comments: { relRow: number; kind: CommentSite["kind"]; body: string; meta: [string, string][]; from: string }[];
}

const sameText = (a: string, b: string) => a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");

export class CommentPaste implements vscode.DocumentPasteEditProvider {
  static readonly metadata: vscode.DocumentPasteProviderMetadata = {
    providedPasteEditKinds: [PASTE_KIND],
    copyMimeTypes: [MIME],
    pasteMimeTypes: [MIME],
  };

  constructor(private readonly deps: PasteDeps) {}

  async prepareDocumentPaste(document: vscode.TextDocument, ranges: readonly vscode.Range[], dataTransfer: vscode.DataTransfer): Promise<void> {
    if (ranges.length !== 1) return;
    const target = await this.deps.target(document);
    if (!target) return;
    const range = ranges[0]!;
    const shape = (row: number) => {
      if (row >= document.lineCount) return undefined;
      const line = document.lineAt(row);
      return { indent: line.firstNonWhitespaceCharacterIndex, length: line.text.length };
    };
    const entries = this.deps.entries(target);
    const comments = copiedSites(await this.deps.sites(document), range.start, range.end, shape).flatMap((site) => {
      const entry = entries.get(site.id);
      if (!entry) return [];
      return [{ relRow: site.row - range.start.line, kind: site.kind, body: entry.body, meta: [...entry.meta], from: entry.id }];
    });
    if (!comments.length) return;
    const payload: Payload = { root: target.root, source: document.fileName, text: document.getText(range), comments };
    dataTransfer.set(MIME, new vscode.DataTransferItem(JSON.stringify(payload)));
  }

  async provideDocumentPasteEdits(
    document: vscode.TextDocument,
    ranges: readonly vscode.Range[],
    dataTransfer: vscode.DataTransfer,
  ): Promise<vscode.DocumentPasteEdit[] | undefined> {
    const item = dataTransfer.get(MIME);
    const text = await dataTransfer.get("text/plain")?.asString();
    if (!item || text === undefined || ranges.length !== 1) return undefined;
    const payload = JSON.parse(await item.asString()) as Payload;
    // A copy with no selection reports the line as its range but puts the line and its
    // break on the clipboard; VS Code pastes that on its own line above the cursor.
    const wholeLine = sameText(text, `${payload.text}\n`);
    // The clipboard may have been replaced from outside the editor since the copy.
    if (!wholeLine && !sameText(text, payload.text)) return undefined;
    const target = await this.deps.target(document);
    // A file with no placed comments yet is markerless only if the copy came from the same repository.
    if (!target || (!target.placed && target.root !== payload.root)) return undefined;

    const range = ranges[0]!;
    const onNewLine = wholeLine && range.isEmpty;
    const at = onNewLine ? new vscode.Range(range.start.line, 0, range.start.line, 0) : range;
    const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const pasted = text.replace(/\r?\n/g, eol);
    const whole = document.getText();
    const code = whole.slice(0, document.offsetAt(at.start)) + pasted + whole.slice(document.offsetAt(at.end));

    const source = await this.source(payload.source);
    const moved = new Set(payload.comments.filter((c) => source && !source.placed.has(c.from)).map((c) => c.from));
    const sameSidecar = source?.target.sidecarPath === target.sidecarPath;
    const withoutMoved = (sidecar: Sidecar): Sidecar => ({ preamble: sidecar.preamble, entries: sidecar.entries.filter((e) => !moved.has(e.id)) });
    const carried = payload.comments.map((c) => ({
      row: at.start.line + c.relRow,
      kind: c.kind,
      body: c.body,
      meta: new Map(c.meta),
      from: c.from,
      moved: moved.has(c.from),
    }));
    const result = await carryComments(target.file, code, sameSidecar ? withoutMoved(target.sidecar) : target.sidecar, carried);
    if (!result.ids.some(Boolean)) return undefined;

    const edit = new vscode.DocumentPasteEdit(onNewLine ? "" : text, "Paste with AI comments", PASTE_KIND);
    edit.additionalEdit = new vscode.WorkspaceEdit();
    // VS Code applies only the additional edit when the insert text is empty.
    if (onNewLine) edit.additionalEdit.insert(document.uri, at.start, pasted);
    await addSidecarEdit(edit.additionalEdit, target.sidecarPath, result.sidecar);
    this.deps.willChange(target.sidecarPath);
    if (source && !sameSidecar && moved.size) {
      await addSidecarEdit(edit.additionalEdit, source.target.sidecarPath, withoutMoved(source.target.sidecar));
      this.deps.willChange(source.target.sidecarPath);
    }
    return [edit];
  }

  /** The copied file's sidecar and the ids that still place in it, or undefined when it is not markerless. */
  private async source(file: string): Promise<{ target: PasteTarget; placed: ReadonlySet<string> } | undefined> {
    const document = await vscode.workspace.openTextDocument(file).then(
      (d) => d,
      () => undefined,
    );
    const target = document && (await this.deps.target(document));
    if (!document || !target) return undefined;
    return { target, placed: new Set((await this.deps.sites(document)).map((s) => s.id)) };
  }
}

/**
 * Adds to `edit` what makes the sidecar file hold `sidecar`: created when missing, deleted
 * when left with nothing, as the CLI does.
 */
async function addSidecarEdit(edit: vscode.WorkspaceEdit, sidecarPath: string, sidecar: Sidecar): Promise<void> {
  const uri = vscode.Uri.file(sidecarPath);
  const text = serializeSidecar(sidecar);
  const exists = await vscode.workspace.fs.stat(uri).then(
    () => true,
    () => false,
  );
  if (!exists) {
    edit.createFile(uri, { contents: new TextEncoder().encode(text) });
    return;
  }
  if (!sidecar.entries.length && !sidecar.preamble) {
    edit.deleteFile(uri);
    return;
  }
  const document = await vscode.workspace.openTextDocument(uri);
  edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
}
