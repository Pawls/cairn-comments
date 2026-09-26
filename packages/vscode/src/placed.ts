// Markerless view (design.md § Anchoring): the owner's file holds no trace of a comment, so
// each one renders against the site `placeComments` reports, and the sites follow the
// owner's edits until the next save or external change places them from anchors again.
import * as vscode from "vscode";
import { BRAND, STALE_TAG, placeComments, type CommentSite, type Sidecar, type SidecarEntry } from "@cairn-comments/core";
import { labelFor, provenanceLine } from "./overlay.js";
import { shiftSites } from "./tracking.js";

/**
 * How an own-line comment renders (design.md § Overlay rendering): a CodeLens above its
 * code line, its comment thread expanded in place, or a label at the end of the line above.
 */
export type OwnLineStyle = "codelens" | "thread" | "eol";
export const OWN_LINE_STYLES: readonly OwnLineStyle[] = ["codelens", "thread", "eol"];

export const SHOW_COMMENT = `${BRAND}.showComment`;
const CONTROLLER_ID = `${BRAND}.comments`;

export interface PlacedRender {
  /** Own-line comments as CodeLens titles, by line. */
  lenses: { line: number; title: string }[];
  /** Comment threads, by the line they are attached to. */
  threads: { line: number; id: string; expanded: boolean }[];
  /** End-of-line labels, own-line ones on the line above included. */
  labels: { line: number; text: string; stale: boolean }[];
}

/**
 * One comment in a thread. `file` and `id` make it a valid argument for the comment
 * commands, which the thread's action buttons pass it to.
 */
export class PlacedComment implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  body: string | vscode.MarkdownString;
  author: vscode.CommentAuthorInformation;
  label: string | undefined;
  contextValue: "stale" | "current";

  constructor(
    readonly file: string,
    readonly id: string,
    entry: SidecarEntry,
    stale: boolean,
    readonly thread: () => vscode.CommentThread | undefined,
  ) {
    this.body = new vscode.MarkdownString(entry.body);
    this.author = { name: provenanceLine(entry.meta) ?? "AI comment" };
    this.label = stale ? "possibly stale" : undefined;
    this.contextValue = stale ? "stale" : "current";
  }
}

interface DocState {
  /** The document version `sites` describe. */
  version: number;
  sites: CommentSite[];
  stale: Set<string>;
  /** Whether edits moved the sites since they were placed. */
  tracked: boolean;
}

interface ThreadRecord {
  thread: vscode.CommentThread;
  comment: PlacedComment;
  /** What the thread was last built from, so an unchanged comment keeps its widget state. */
  key: string;
  style: OwnLineStyle;
}

export class PlacedView implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly labelType = vscode.window.createTextEditorDecorationType({});
  private readonly controller = vscode.comments.createCommentController(CONTROLLER_ID, "AI comments");
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensesChanged.event;
  private readonly states = new Map<string, DocState>();
  private readonly lenses = new Map<string, vscode.CodeLens[]>();
  private readonly threads = new Map<string, Map<string, ThreadRecord>>();

  dispose(): void {
    this.labelType.dispose();
    for (const uri of this.threads.keys()) this.disposeThreads(uri);
    this.controller.dispose();
    this.lensesChanged.dispose();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    return this.lenses.get(document.uri.toString()) ?? [];
  }

  /**
   * Whether `document` has sites for its current text. Sites moved by edits stop counting
   * once the document is clean again (saved, reverted, or reloaded after a change on disk):
   * its text then matches what the anchors describe, so they are placed from those.
   */
  isCurrent(document: vscode.TextDocument): boolean {
    const state = this.states.get(document.uri.toString());
    return state?.version === document.version && !(state.tracked && !document.isDirty);
  }

  /**
   * Places `document`'s comments from their anchors. False when the document changed while
   * placing, so the result would not describe it.
   */
  async place(document: vscode.TextDocument, file: string, sidecar: Sidecar): Promise<boolean> {
    const version = document.version;
    const placed = await placeComments(file, document.getText(), sidecar);
    if (document.version !== version || document.isClosed) return false;
    this.states.set(document.uri.toString(), { version, sites: placed.sites, stale: new Set(placed.stale.map((s) => s.id)), tracked: false });
    return true;
  }

  /**
   * Moves the sites through an edit of the open buffer. `isDirty` cannot say here whether
   * the edit left the document clean (VS Code updates it in a later event), so `isCurrent`
   * judges that. Events arrive in order, and one that lands while `place` runs makes `place`
   * discard its result.
   */
  track(event: vscode.TextDocumentChangeEvent): void {
    const state = this.states.get(event.document.uri.toString());
    if (!state || !event.contentChanges.length) return;
    state.sites = shiftSites(state.sites, event.contentChanges.map((c) => ({ start: c.range.start, end: c.range.end, text: c.text })));
    state.version = event.document.version;
    state.tracked = true;
  }

  /** Drops what is known about one document, or about every document. */
  forget(document?: vscode.TextDocument): void {
    if (document) this.states.delete(document.uri.toString());
    else this.states.clear();
  }

  sites(document: vscode.TextDocument): readonly CommentSite[] {
    return this.states.get(document.uri.toString())?.sites ?? [];
  }

  /** The comment described by `line`: an own-line comment above it, else its trailing one. */
  idAt(document: vscode.TextDocument, line: number): string | undefined {
    const onLine = this.sites(document).filter((s) => s.row === line);
    return (onLine.find((s) => s.kind === "own") ?? onLine[0])?.id;
  }

  /** The thread comment for `id`, when the overlay is showing it. */
  comment(document: vscode.TextDocument, id: string): PlacedComment | undefined {
    return this.threads.get(document.uri.toString())?.get(id)?.comment;
  }

  /** Opens the comment's thread in the editor. */
  reveal(uri: vscode.Uri, id: string): void {
    const record = this.threads.get(uri.toString())?.get(id);
    if (record) record.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  /** Clears everything this view drew in `editor`; what it knows about the sites stays. */
  clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.labelType, []);
    this.setLenses(editor.document, []);
    this.disposeThreads(editor.document.uri.toString());
  }

  render(editor: vscode.TextEditor, entries: ReadonlyMap<string, SidecarEntry>, style: OwnLineStyle, color: string | vscode.ThemeColor): PlacedRender {
    const document = editor.document;
    const state = this.states.get(document.uri.toString());
    const shown = (state?.sites ?? []).flatMap((site) => {
      const entry = entries.get(site.id);
      return entry ? [{ site, entry, stale: state!.stale.has(site.id) }] : [];
    });
    const lastLine = document.lineCount - 1;
    // An own-line comment goes above `row`; past the last line it goes above nothing, so
    // it is drawn on the last line instead.
    const anchorLine = (row: number) => Math.min(row, lastLine);
    const lineAbove = (row: number) => Math.max(Math.min(row - 1, lastLine), 0);
    const title = (s: (typeof shown)[number]) => (s.stale ? `${STALE_TAG} ` : "") + labelFor(s.entry.body, "on");

    const out: PlacedRender = { lenses: [], threads: [], labels: [] };
    for (const s of shown) {
      const { row, kind, id } = s.site;
      if (kind === "trail") out.labels.push({ line: row, text: title(s), stale: s.stale });
      else if (style === "codelens") out.lenses.push({ line: anchorLine(row), title: title(s) });
      else if (style === "eol") out.labels.push({ line: lineAbove(row), text: title(s), stale: s.stale });
      const expanded = kind === "own" && style === "thread";
      out.threads.push({ line: expanded ? lineAbove(row) : anchorLine(row), id, expanded });
    }

    const byLine = new Map<number, PlacedRender["labels"]>();
    for (const l of out.labels) byLine.set(l.line, [...(byLine.get(l.line) ?? []), l]);
    const warn = new vscode.ThemeColor("editorWarning.foreground");
    editor.setDecorations(
      this.labelType,
      [...byLine].map(([line, labels]) => {
        const end = document.lineAt(line).range.end;
        const gap = document.lineAt(line).isEmptyOrWhitespace ? "" : "  ";
        const text = gap + labels.map((l) => l.text).join("  ·  ");
        const stale = labels.some((l) => l.stale);
        return { range: new vscode.Range(end, end), renderOptions: { after: { contentText: text, color: stale ? warn : color, fontStyle: "italic" } } };
      }),
    );

    const lensIds = shown.filter((s) => s.site.kind === "own").map((s) => s.site.id);
    this.setLenses(
      document,
      out.lenses.map((l, i) => new vscode.CodeLens(document.lineAt(l.line).range, { title: `~ ${l.title}`, command: SHOW_COMMENT, arguments: [document.uri, lensIds[i]] })),
    );

    const threadOf = new Map(out.threads.map((t) => [t.id, t]));
    this.setThreads(
      document,
      style,
      shown.map((s) => ({ ...s, line: threadOf.get(s.site.id)!.line, expanded: threadOf.get(s.site.id)!.expanded })),
    );
    return out;
  }

  private setLenses(document: vscode.TextDocument, lenses: vscode.CodeLens[]): void {
    const uri = document.uri.toString();
    const before = this.lenses.get(uri) ?? [];
    if (!before.length && !lenses.length) return;
    this.lenses.set(uri, lenses);
    this.lensesChanged.fire();
  }

  /**
   * Keeps one thread per comment: a moved comment's thread moves, a changed one is rebuilt,
   * and one in the middle of an edit is left alone.
   */
  private setThreads(
    document: vscode.TextDocument,
    style: OwnLineStyle,
    wanted: { site: CommentSite; entry: SidecarEntry; stale: boolean; line: number; expanded: boolean }[],
  ): void {
    const uri = document.uri.toString();
    const records = this.threads.get(uri) ?? new Map<string, ThreadRecord>();
    this.threads.set(uri, records);
    const keep = new Set(wanted.map((w) => w.site.id));
    for (const [id, record] of records) {
      if (keep.has(id) || record.comment.mode === vscode.CommentMode.Editing) continue;
      record.thread.dispose();
      records.delete(id);
    }
    for (const w of wanted) {
      const id = w.site.id;
      const range = new vscode.Range(w.line, 0, w.line, 0);
      const key = JSON.stringify([w.stale, w.entry.body, [...w.entry.meta]]);
      const record = records.get(id);
      if (record?.comment.mode === vscode.CommentMode.Editing) continue;
      if (record && record.key === key && record.style === style) {
        if (!record.thread.range?.isEqual(range)) record.thread.range = range;
        continue;
      }
      record?.thread.dispose();
      const comment = new PlacedComment(document.fileName, id, w.entry, w.stale, () => records.get(id)?.thread);
      const thread = this.controller.createCommentThread(document.uri, range, [comment]);
      thread.canReply = false;
      thread.label = "AI comment";
      thread.contextValue = comment.contextValue;
      thread.collapsibleState = w.expanded ? vscode.CommentThreadCollapsibleState.Expanded : vscode.CommentThreadCollapsibleState.Collapsed;
      records.set(id, { thread, comment, key, style });
    }
  }

  /** Switches a thread comment between reading and editing, keeping the stored body to cancel back to. */
  setEditing(comment: PlacedComment, editing: boolean, body?: string): void {
    const thread = comment.thread();
    if (!thread) return;
    comment.mode = editing ? vscode.CommentMode.Editing : vscode.CommentMode.Preview;
    if (body !== undefined) comment.body = new vscode.MarkdownString(body);
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.comments = [comment];
  }

  private disposeThreads(uri: string): void {
    for (const record of this.threads.get(uri)?.values() ?? []) record.thread.dispose();
    this.threads.delete(uri);
  }
}
