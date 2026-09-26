// Copy and paste carry markerless comments (design.md § Overlay rendering, "Copy and paste"):
// a copy records the comments it covers, and a paste of that same text adds them to the
// target file's sidecar, anchored where they landed.
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
    const payload: Payload = { root: target.root, text: document.getText(range), comments };
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
    // The clipboard may have been replaced from outside the editor since the copy.
    if (!sameText(text, payload.text)) return undefined;
    const target = await this.deps.target(document);
    // A file with no placed comments yet is markerless only if the copy came from the same repository.
    if (!target || (!target.placed && target.root !== payload.root)) return undefined;

    const range = ranges[0]!;
    const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const whole = document.getText();
    const code = whole.slice(0, document.offsetAt(range.start)) + text.replace(/\r?\n/g, eol) + whole.slice(document.offsetAt(range.end));
    const carried = payload.comments.map((c) => ({ row: range.start.line + c.relRow, kind: c.kind, body: c.body, meta: new Map(c.meta), from: c.from }));
    const result = await carryComments(target.file, code, target.sidecar, carried);
    if (!result.ids.some(Boolean)) return undefined;

    const edit = new vscode.DocumentPasteEdit(text, "Paste with AI comments", PASTE_KIND);
    edit.additionalEdit = await sidecarEdit(target.sidecarPath, result.sidecar);
    this.deps.willChange(target.sidecarPath);
    return [edit];
  }
}

/** A workspace edit that makes the sidecar file hold `sidecar`, creating the file if needed. */
async function sidecarEdit(sidecarPath: string, sidecar: Sidecar): Promise<vscode.WorkspaceEdit> {
  const uri = vscode.Uri.file(sidecarPath);
  const text = serializeSidecar(sidecar);
  const edit = new vscode.WorkspaceEdit();
  const exists = await vscode.workspace.fs.stat(uri).then(
    () => true,
    () => false,
  );
  if (!exists) {
    edit.createFile(uri, { contents: new TextEncoder().encode(text) });
    return edit;
  }
  const document = await vscode.workspace.openTextDocument(uri);
  edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
  return edit;
}
