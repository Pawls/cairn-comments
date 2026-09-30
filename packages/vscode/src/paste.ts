// Copy and paste carry placed comments (design.md § Overlay rendering, "Copy and paste"):
// a copy records the comments it covers, and a paste of that same text adds them to the
// target file's sidecar, anchored where they landed. A comment whose original no longer
// places by then was cut, so it moves instead of being copied. A copy of whole lines,
// whitespace aside, pastes at an empty cursor on its own lines, as a copy with no selection does.
import * as vscode from "vscode";
import { BRAND, carryComments, type CommentSite, type Sidecar, type SidecarEntry } from "@cairn-comments/core";
import { sidecarText } from "./actions.js";
import { addFileEdit } from "./edits.js";
import { copiedSites, shapeOf } from "./tracking.js";

const MIME = `application/vnd.${BRAND}.comments+json`;
export const PASTE_KIND = vscode.DocumentDropOrPasteEditKind.Text.append(BRAND);

/** A file whose comments live in its sidecar, which the extension can read comments from or add them to. */
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
  /** The document as a paste target, or undefined when it shows its comments inline or is not a source file. */
  target(document: vscode.TextDocument): Promise<PasteTarget | undefined>;
  /** Current comment sites of a document that shows none inline. */
  sites(document: vscode.TextDocument): Promise<readonly CommentSite[]>;
  /** The text and sites before the latest edit, when that edit was a cut of `range` (`PlacedView.beforeCut`). */
  beforeCut(document: vscode.TextDocument, range: vscode.Range): { text: string; sites: readonly CommentSite[] } | undefined;
  entries(target: PasteTarget): ReadonlyMap<string, SidecarEntry>;
  /** Called with a sidecar a paste edit is about to change, so it can be saved once it has. */
  willChange(sidecarPath: string): void;
  /** Called with the text a paste edit will leave in `document` and the sites of the comments it carries there. */
  willPaste(document: vscode.TextDocument, text: string, sites: readonly CommentSite[]): void;
}

interface Payload {
  root: string;
  /** The copied document's absolute path, where a cut comment's original entry lives. */
  source: string;
  text: string;
  /**
   * The copied lines in full, indentation and final line break included, when the copy
   * covered whole lines apart from whitespace at either end. Pasted at an empty cursor,
   * they go on their own lines above it, as a copy with no selection does.
   */
  lines?: string;
  comments: { relRow: number; kind: CommentSite["kind"]; body: string; meta: [string, string][]; from: string }[];
}

const sameText = (a: string, b: string) => a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");

/** A document's text split into lines, for reading a copy against text the editor no longer shows. */
class Lines {
  private readonly lines: string[];
  private readonly starts: number[] = [];

  constructor(private readonly text: string) {
    this.lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
    let offset = 0;
    for (const raw of text.split("\n")) {
      this.starts.push(offset);
      offset += raw.length + 1;
    }
  }

  get count(): number {
    return this.lines.length;
  }

  line(row: number): string | undefined {
    return this.lines[row];
  }

  slice(start: vscode.Position, end: vscode.Position): string {
    const at = (p: vscode.Position) => Math.min(this.starts[p.line]! + p.character, this.text.length);
    return this.text.slice(at(start), at(end));
  }

  /** Rows `first`..`last` in full, each ending in "\n". */
  whole(first: number, last: number): string {
    return this.lines.slice(first, last + 1).map((l) => `${l}\n`).join("");
  }
}

/** The rows a copy of `start`..`end` covers in full, ignoring whitespace at either end, if it does. */
function wholeRows(lines: Lines, start: vscode.Position, end: vscode.Position): { first: number; last: number } | undefined {
  const last = end.character === 0 && end.line > start.line ? end.line - 1 : end.line;
  const first = lines.line(start.line);
  const final = lines.line(last);
  if (first === undefined || final === undefined) return undefined;
  const indent = first.length - first.trimStart().length;
  const trimmedEnd = final.trimEnd().length;
  const reachesEnd = last < end.line || end.character >= trimmedEnd;
  if (start.character > indent || !reachesEnd || !lines.slice(start, end).trim()) return undefined;
  return { first: start.line, last };
}

export class CommentPaste implements vscode.DocumentPasteEditProvider {
  static readonly metadata: vscode.DocumentPasteProviderMetadata = {
    providedPasteEditKinds: [PASTE_KIND],
    copyMimeTypes: [MIME],
    pasteMimeTypes: [MIME],
  };

  constructor(private readonly deps: PasteDeps) {}

  async prepareDocumentPaste(document: vscode.TextDocument, ranges: readonly vscode.Range[], dataTransfer: vscode.DataTransfer): Promise<void> {
    if (ranges.length !== 1) return;
    const range = ranges[0]!;
    // Before any await: later edits would replace what a cut left behind.
    const cut = this.deps.beforeCut(document, range);
    const lines = new Lines(cut?.text ?? document.getText());
    const target = await this.deps.target(document);
    if (!target) return;
    const shape = (row: number) => {
      const line = lines.line(row);
      return line === undefined ? undefined : shapeOf(line);
    };
    const entries = this.deps.entries(target);
    const sites = cut?.sites ?? (await this.deps.sites(document));
    const comments = copiedSites(sites, range.start, range.end, shape).flatMap((site) => {
      const entry = entries.get(site.id);
      if (!entry) return [];
      return [{ relRow: site.row - range.start.line, kind: site.kind, body: entry.body, meta: [...entry.meta], from: entry.id }];
    });
    if (!comments.length) return;
    const rows = wholeRows(lines, range.start, range.end);
    const payload: Payload = {
      root: target.root,
      source: document.fileName,
      text: lines.slice(range.start, range.end),
      lines: rows && lines.whole(rows.first, rows.last),
      comments,
    };
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
    // break on the clipboard. The clipboard may also have been replaced from outside the
    // editor since the copy.
    if (!sameText(text, payload.text) && !sameText(text, `${payload.text}\n`)) return undefined;
    const target = await this.deps.target(document);
    // A file with no placed comments yet may sit outside any set-up repository; take it only when the copy came from the same one.
    if (!target || (!target.placed && target.root !== payload.root)) return undefined;

    const range = ranges[0]!;
    const onNewLine = payload.lines !== undefined && range.isEmpty;
    const at = onNewLine ? new vscode.Range(range.start.line, 0, range.start.line, 0) : range;
    const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const pasted = (onNewLine ? payload.lines! : text).replace(/\r?\n/g, eol);
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
    this.deps.willPaste(
      document,
      code,
      carried.flatMap((c, i) => (result.ids[i] ? [{ id: result.ids[i]!, row: c.row, kind: c.kind }] : [])),
    );

    const edit = new vscode.DocumentPasteEdit(onNewLine ? "" : text, "Paste with AI comments", PASTE_KIND);
    edit.additionalEdit = new vscode.WorkspaceEdit();
    // VS Code applies only the additional edit when the insert text is empty.
    if (onNewLine) edit.additionalEdit.insert(document.uri, at.start, pasted);
    await addFileEdit(edit.additionalEdit, target.sidecarPath, sidecarText(result.sidecar));
    this.deps.willChange(target.sidecarPath);
    if (source && !sameSidecar && moved.size) {
      await addFileEdit(edit.additionalEdit, source.target.sidecarPath, sidecarText(withoutMoved(source.target.sidecar)));
      this.deps.willChange(source.target.sidecarPath);
    }
    return [edit];
  }

  /** The copied file's sidecar and the ids that still place in it, or undefined when it shows its comments inline. */
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
