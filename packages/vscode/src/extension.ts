import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import {
  BRAND,
  SIDECAR_ROOT,
  confirm,
  demoteTarget,
  findMarkers,
  languageForPath,
  parseSidecar,
  serializeSidecar,
  sidecarPathFor,
  type CommentSite,
  type Marker,
  type Sidecar,
  type SidecarEntry,
} from "@cairn-comments/core";
import { MarkerlessActions, type CommentRef, type Located } from "./actions.js";
import { registerLists, type ListsApi } from "./lists.js";
import { entryIsStale, findSidecarRoot, hoverMarkdown, planOverlay, type OverlayMode, type PlannedDecoration } from "./overlay.js";
import { applyPrinted } from "./edits.js";
import { CommentPaste } from "./paste.js";
import { OWN_LINE_STYLES, PlacedComment, PlacedView, SHOW_COMMENT, type OwnLineStyle, type PlacedRender } from "./placed.js";
import { findRepo, orphansOf, runCli, type OrphanComment, type StaleComment } from "./review.js";
import { registerReviewTree, type ReviewApi } from "./reviewTree.js";

export const COMMANDS = {
  toggle: `${BRAND}.toggleOverlay`,
  edit: `${BRAND}.editComment`,
  confirm: `${BRAND}.confirmComment`,
  reviewStale: `${BRAND}.reviewStale`,
  promote: `${BRAND}.promoteComment`,
  demote: `${BRAND}.demoteComment`,
  delete: `${BRAND}.deleteComment`,
  saveEdit: `${BRAND}.saveComment`,
  cancelEdit: `${BRAND}.cancelCommentEdit`,
} as const;

/** How long a paste's sidecar change is expected before a later change is no longer taken for it. */
const PASTE_SAVE_WINDOW_MS = 5_000;

const STATE_KEY = "overlay.on";
const DEBOUNCE_MS = 100;

/**
 * VS Code language ids for every extension `LANGUAGES` covers. `kotlin` is not built in, so
 * the manifest registers it for `.kt`/`.kts`; VS Code merges that with a Kotlin extension's.
 */
const VSCODE_LANGUAGE_IDS = ["python", "typescript", "typescriptreact", "javascript", "javascriptreact", "csharp", "java", "kotlin"];

/** What the e2e test (and a debugger) can reach through `activate`'s return value. */
export interface TestApi {
  mode(): OverlayMode;
  /** Recomputes and applies the overlay for one editor, returning what was applied. */
  refresh(editor: vscode.TextEditor): Promise<Applied>;
  review: ReviewApi;
  /** What the stale comment list offers, from `check --stale --json`; a string explains an empty list. */
  staleComments(): Promise<StaleComment[] | string>;
  orphanComments(): Promise<OrphanComment[] | string>;
  lists: ListsApi;
  /** The copy and paste provider, driven directly: a test window has no focus, so native copy never reaches it. */
  paste: CommentPaste;
  placed: {
    sites(document: vscode.TextDocument): readonly CommentSite[];
    /** The thread comment for `id`, while the overlay shows it. */
    comment(document: vscode.TextDocument, id: string): PlacedComment | undefined;
  };
}

export interface Applied {
  hidden: vscode.DecorationOptions[];
  revealed: vscode.DecorationOptions[];
  missing: vscode.DecorationOptions[];
  /** A markerless file's comments; absent when the file holds markers or the overlay is off. */
  placed?: PlacedRender;
}

/**
 * Sidecar contents keyed by absolute path. An open document wins over the disk copy so
 * edits show in the overlay as they are typed; disk reads are cached until the watcher
 * reports a change.
 */
class SidecarStore {
  private readonly disk = new Map<string, Sidecar | undefined>();

  invalidate(file?: string): void {
    if (file) this.disk.delete(file);
    else this.disk.clear();
  }

  get(file: string): Sidecar | undefined {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.fileName === file);
    if (open) return parseSidecar(open.getText());
    if (!this.disk.has(file)) this.disk.set(file, existsSync(file) ? parseSidecar(readFileSync(file, "utf8")) : undefined);
    return this.disk.get(file);
  }

  entries(file: string): Map<string, SidecarEntry> {
    return new Map((this.get(file)?.entries ?? []).map((e) => [e.id, e]));
  }
}

function locate(document: vscode.TextDocument): Located | undefined {
  if (document.uri.scheme !== "file" || !languageForPath(document.fileName)) return undefined;
  const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? path.dirname(document.fileName);
  const root = findSidecarRoot(path.dirname(document.fileName), folder);
  const file = path.relative(root, document.fileName).split(path.sep).join("/");
  return { root, file, sidecar: path.join(root, sidecarPathFor(file)) };
}

async function markersIn(document: vscode.TextDocument, located: Located): Promise<Marker[]> {
  return findMarkers(languageForPath(located.file)!, document.getText(), { anchors: true });
}

export function activate(context: vscode.ExtensionContext): TestApi {
  const store = new SidecarStore();
  const overlayColor = (): string | vscode.ThemeColor => {
    const configured = vscode.workspace.getConfiguration(BRAND).get<string>("overlayColor", "");
    return configured || new vscode.ThemeColor("editorCodeLens.foreground");
  };

  // Spike result (design.md § Overlay rendering): the token is removed from the rendered
  // line by injecting `display: none` through `textDecoration`, and the label is drawn
  // as an `after` attachment, which VS Code renders as a sibling of the hidden span.
  const hiddenType = vscode.window.createTextEditorDecorationType({
    textDecoration: "none; display: none",
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  const revealedType = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  const missingType = vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor("editorWarning.foreground"),
    textDecoration: "underline wavy",
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  const placedView = new PlacedView();
  context.subscriptions.push(hiddenType, revealedType, missingType, placedView);
  /** Documents that showed no markers and had comments in their sidecar at their last refresh. */
  const markerless = new Set<string>();
  const ownLineStyle = (): OwnLineStyle => {
    const configured = vscode.workspace.getConfiguration(BRAND).get<string>("ownLineStyle", "codelens");
    return OWN_LINE_STYLES.find((s) => s === configured) ?? "codelens";
  };

  const mode = (): OverlayMode => (context.workspaceState.get<boolean>(STATE_KEY, false) ? "on" : "off");

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  status.command = COMMANDS.toggle;
  const renderStatus = () => {
    const on = mode() === "on";
    status.text = on ? "$(eye) AI comments" : "$(eye-closed) AI comments";
    status.tooltip = on ? "AI comment overlay is on: click to show bare markers" : "AI comment overlay is off: click to show comment text";
    status.show();
  };
  renderStatus();
  context.subscriptions.push(status);

  async function refresh(editor: vscode.TextEditor): Promise<Applied> {
    const applied: Applied = { hidden: [], revealed: [], missing: [] };
    const located = locate(editor.document);
    if (located) {
      const document = editor.document;
      const markers = await markersIn(document, located);
      if (editor.document !== document || document.isClosed) return applied;
      const sidecar = store.get(located.sidecar);
      if (!markers.length && sidecar?.entries.length) {
        markerless.add(document.uri.toString());
        if (!placedView.isCurrent(document) && !(await placedView.place(document, located.file, sidecar))) {
          // The document changed while placing; the refresh its change scheduled places it again.
          return applied;
        }
        if (editor.document !== document || document.isClosed) return applied;
        if (mode() === "on") applied.placed = placedView.render(editor, store.entries(located.sidecar), ownLineStyle(), overlayColor());
        else placedView.clear(editor);
      } else {
        markerless.delete(document.uri.toString());
        placedView.forget(document);
        placedView.clear(editor);
      }
      const cursorRows = new Set(editor.selections.flatMap((s) => rows(document, s)));
      const planned = planOverlay(markers, store.entries(located.sidecar), mode(), (m) =>
        cursorRows.has(document.positionAt(m.start).line),
      );
      const color = overlayColor();
      for (const p of planned) applied[p.kind].push(toOptions(document, p, color));
    }
    editor.setDecorations(hiddenType, applied.hidden);
    editor.setDecorations(revealedType, applied.revealed);
    editor.setDecorations(missingType, applied.missing);
    return applied;
  }

  const timers = new Map<vscode.TextEditor, NodeJS.Timeout>();
  const schedule = (editor: vscode.TextEditor) => {
    clearTimeout(timers.get(editor));
    timers.set(
      editor,
      setTimeout(() => {
        timers.delete(editor);
        void refresh(editor);
      }, DEBOUNCE_MS),
    );
  };
  const refreshAll = () => vscode.window.visibleTextEditors.forEach(schedule);
  const editorsOf = (document: vscode.TextDocument) => vscode.window.visibleTextEditors.filter((e) => e.document === document);
  const isSidecar = (document: vscode.TextDocument) =>
    document.uri.scheme === "file" && document.fileName.split(path.sep).join("/").includes(`/${SIDECAR_ROOT}/`);

  const lists = registerLists(context, { stale: staleComments, orphans: orphanComments }, COMMANDS.edit);
  const watcher = vscode.workspace.createFileSystemWatcher(`**/${SIDECAR_ROOT}/**/*.md`);
  const onSidecarChange = (uri: vscode.Uri) => {
    store.invalidate(uri.fsPath);
    // A sidecar change is an external change to every file it anchors: place them again.
    placedView.forget();
    refreshAll();
    lists.scheduleRefresh();
  };
  const actions = new MarkerlessActions({
    view: placedView,
    locate,
    isMarkerless: (document) => markerless.has(document.uri.toString()),
    sidecar: (file) => store.get(file),
    written: (file) => onSidecarChange(vscode.Uri.file(file)),
  });

  // A paste edit changes the sidecar's buffer; it is saved once the change arrives.
  const pasteSaves = new Map<string, NodeJS.Timeout>();
  const paste = new CommentPaste({
    target: async (document) => {
      const located = locate(document);
      if (!located || (await markersIn(document, located)).length) return undefined;
      const sidecar = store.get(located.sidecar) ?? { preamble: "", entries: [] };
      return { root: located.root, file: located.file, sidecarPath: located.sidecar, sidecar, placed: sidecar.entries.some((e) => e.meta.has("pos")) };
    },
    sites: async (document) => {
      const located = locate(document);
      const sidecar = located && store.get(located.sidecar);
      if (located && sidecar && !placedView.isCurrent(document)) await placedView.place(document, located.file, sidecar);
      return placedView.sites(document);
    },
    beforeCut: (document, range) => placedView.beforeCut(document, range),
    willPaste: (document, text, sites) => placedView.expectPaste(document, text, sites),
    entries: (target) => store.entries(target.sidecarPath),
    willChange: (file) => {
      clearTimeout(pasteSaves.get(file));
      pasteSaves.set(
        file,
        setTimeout(() => pasteSaves.delete(file), PASTE_SAVE_WINDOW_MS),
      );
    },
  });

  context.subscriptions.push(
    watcher,
    watcher.onDidChange(onSidecarChange),
    watcher.onDidCreate(onSidecarChange),
    watcher.onDidDelete(onSidecarChange),
    { dispose: () => pasteSaves.forEach((t) => clearTimeout(t)) },
    vscode.window.onDidChangeVisibleTextEditors(refreshAll),
    vscode.window.onDidChangeTextEditorSelection((e) => schedule(e.textEditor)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (isSidecar(e.document)) {
        const pending = pasteSaves.get(e.document.fileName);
        if (pending && e.document.isDirty) {
          clearTimeout(pending);
          pasteSaves.delete(e.document.fileName);
          void e.document.save();
        }
        placedView.forget();
        refreshAll();
      } else {
        placedView.track(e);
        editorsOf(e.document).forEach(schedule);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (isSidecar(d)) return;
      placedView.forget(d);
      editorsOf(d).forEach(schedule);
    }),
    vscode.workspace.onDidCloseTextDocument((d) => {
      // The disk copy is authoritative again once the editor buffer is gone.
      if (isSidecar(d)) onSidecarChange(d.uri);
      else {
        placedView.forget(d);
        markerless.delete(d.uri.toString());
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(BRAND)) refreshAll();
    }),
    vscode.commands.registerCommand(COMMANDS.toggle, async () => {
      await context.workspaceState.update(STATE_KEY, mode() === "off");
      renderStatus();
      refreshAll();
    }),
    // A thread's Edit button edits in place; from the palette or a list, the sidecar entry opens.
    vscode.commands.registerCommand(COMMANDS.edit, (arg?: CommentRef) => (arg instanceof PlacedComment ? actions.startEdit(arg) : editComment(arg))),
    vscode.commands.registerCommand(COMMANDS.saveEdit, (comment: PlacedComment) => actions.saveEdit(comment)),
    vscode.commands.registerCommand(COMMANDS.cancelEdit, (comment: PlacedComment) => actions.cancelEdit(comment)),
    vscode.commands.registerCommand(COMMANDS.confirm, async (arg?: CommentRef) => {
      const placed = await actions.resolve(arg);
      if (placed) await actions.confirm(placed);
      else await confirmComment(arg);
      refreshAll();
    }),
    vscode.commands.registerCommand(COMMANDS.reviewStale, () => reviewStale()),
    vscode.commands.registerCommand(COMMANDS.promote, async (arg?: CommentRef) => {
      const placed = await actions.resolve(arg);
      return placed ? actions.promote(placed) : promoteComment(arg);
    }),
    vscode.commands.registerCommand(COMMANDS.delete, async (arg?: CommentRef) => {
      const placed = await actions.resolve(arg);
      if (placed) await actions.delete(placed);
      else void vscode.window.showInformationMessage("No AI comment on this line.");
    }),
    vscode.commands.registerCommand(COMMANDS.demote, (arg?: LineRef) => demoteComment(arg)),
    vscode.commands.registerCommand(SHOW_COMMENT, (uri: vscode.Uri, id: string) => placedView.toggle(uri, id)),
    ...VSCODE_LANGUAGE_IDS.map((language) => vscode.languages.registerDocumentPasteEditProvider({ scheme: "file", language }, paste, CommentPaste.metadata)),
    ...VSCODE_LANGUAGE_IDS.map((language) =>
      vscode.languages.registerHoverProvider(
        { scheme: "file", language },
        { provideHover: (document, position) => provideHover(store, document, position) },
      ),
    ),
    ...VSCODE_LANGUAGE_IDS.map((language) => vscode.languages.registerCodeLensProvider({ scheme: "file", language }, placedView)),
    ...VSCODE_LANGUAGE_IDS.map((language) =>
      vscode.languages.registerCodeActionsProvider(
        { scheme: "file", language },
        { provideCodeActions: (document, range) => provideCodeActions(document, range.start.line) },
        { providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite] },
      ),
    ),
  );
  refreshAll();
  return {
    mode,
    refresh,
    review: registerReviewTree(context),
    staleComments,
    orphanComments,
    lists,
    paste,
    placed: { sites: (document) => placedView.sites(document), comment: (document, id) => placedView.comment(document, id) },
  };
}

export function deactivate(): void {}

function rows(document: vscode.TextDocument, selection: vscode.Selection): number[] {
  const out: number[] = [];
  for (let line = selection.start.line; line <= selection.end.line; line++) out.push(line);
  return out;
}

function toOptions(document: vscode.TextDocument, p: PlannedDecoration, color: string | vscode.ThemeColor): vscode.DecorationOptions {
  const range = new vscode.Range(document.positionAt(p.start), document.positionAt(p.end));
  const text = p.kind === "hidden" ? p.label : `  ${p.label}`;
  const after: vscode.ThemableDecorationAttachmentRenderOptions = {
    contentText: text,
    color: p.kind === "missing" || p.stale ? new vscode.ThemeColor("editorWarning.foreground") : color,
    fontStyle: "italic",
  };
  return { range, renderOptions: { after } };
}

/**
 * The bare marker on `line`, at or after `column` when one is given. A hidden token has
 * no width, so its overlay label maps to the token's end column; accepting anything from
 * the sigil to the end of the line covers it without claiming the code before it.
 */
async function markerAt(document: vscode.TextDocument, line: number, column?: number): Promise<{ marker: Marker; located: Located } | undefined> {
  const located = locate(document);
  if (!located) return undefined;
  for (const marker of await markersIn(document, located)) {
    const start = document.positionAt(marker.start);
    if (marker.kind === "bare" && marker.id && start.line === line && (column === undefined || column >= start.character)) {
      return { marker, located };
    }
  }
  return undefined;
}

async function provideHover(store: SidecarStore, document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
  const hit = await markerAt(document, position.line, position.character);
  if (!hit) return undefined;
  const { marker, located } = hit;
  const entry = store.entries(located.sidecar).get(marker.id!);
  const stale = entryIsStale(marker, entry);
  const args = encodeURIComponent(JSON.stringify({ file: document.fileName, id: marker.id }));
  const links = [`[Edit comment](command:${COMMANDS.edit}?${args})`];
  if (stale) links.push(`[Confirm: still accurate](command:${COMMANDS.confirm}?${args})`);
  const markdown = new vscode.MarkdownString(`${hoverMarkdown(marker.id!, entry, sidecarPathFor(located.file), stale)}\n\n${links.join(" · ")}`, true);
  markdown.isTrusted = { enabledCommands: [COMMANDS.edit, COMMANDS.confirm] };
  const range = new vscode.Range(document.positionAt(marker.start), document.positionAt(marker.end));
  return new vscode.Hover(markdown, range);
}

async function resolveRef(arg?: CommentRef): Promise<{ document: vscode.TextDocument; located: Located; id: string } | undefined> {
  if (arg) {
    const document = await vscode.workspace.openTextDocument(arg.file);
    const located = locate(document);
    return located && { document, located, id: arg.id };
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const hit = await markerAt(editor.document, editor.selection.active.line);
  if (!hit) {
    void vscode.window.showInformationMessage("No AI comment marker on this line.");
    return undefined;
  }
  return { document: editor.document, located: hit.located, id: hit.marker.id! };
}

/**
 * Records the anchor the open document shows now, so a stale comment reads as current
 * again. Runs in process rather than through `confirm`, which would hash the saved file.
 */
async function confirmComment(arg?: CommentRef): Promise<void> {
  const ref = await resolveRef(arg);
  if (!ref || !existsSync(ref.located.sidecar)) return;
  const uri = vscode.Uri.file(ref.located.sidecar);
  const sidecarDocument = await vscode.workspace.openTextDocument(uri);
  const result = await confirm(ref.located.file, ref.document.getText(), parseSidecar(sidecarDocument.getText()), [ref.id]);
  if (!result.changed) return;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(sidecarDocument.positionAt(0), sidecarDocument.positionAt(sidecarDocument.getText().length)), serializeSidecar(result.sidecar));
  await vscode.workspace.applyEdit(edit);
  await sidecarDocument.save();
}

/** Stale comments across the repository through the CLI, as CI would see them. */
async function staleComments(): Promise<StaleComment[] | string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const repo = folder ? await findRepo(folder.uri.fsPath) : undefined;
  if (!repo?.cli) return repo ? `Run \`${BRAND} init\` in this repository to check for stale comments.` : "Open a git repository to check for stale comments.";
  // Exit 1 means stale comments were found; the list is still on stdout.
  const found = JSON.parse(await runCli(repo.cli, "check --stale --json", repo.root, undefined, [0, 1])) as StaleComment[];
  return found.map((c) => ({ ...c, file: path.join(repo.root, c.file) }));
}

/** Comments that no longer place in their code, through the CLI (`check --orphans`). */
async function orphanComments(): Promise<OrphanComment[] | string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const repo = folder ? await findRepo(folder.uri.fsPath) : undefined;
  if (!repo?.cli) return repo ? `Run \`${BRAND} init\` in this repository to check for orphaned comments.` : "Open a git repository to check for orphaned comments.";
  // Exit 1 means problems were found; the report is still on stdout.
  const report = JSON.parse(await runCli(repo.cli, "check --orphans --json", repo.root, undefined, [0, 1])) as { problems: { kind: string }[] };
  return orphansOf(report).map((c) => ({ ...c, source: path.join(repo.root, c.source) }));
}

async function reviewStale(): Promise<void> {
  const found = await staleComments();
  if (typeof found === "string" || !found.length) {
    void vscode.window.showInformationMessage(typeof found === "string" ? found : "No stale AI comments.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    found.map((c) => ({
      label: `$(warning) ${c.text.split("\n")[0]}`,
      description: `${vscode.workspace.asRelativePath(c.file)}:${c.line}`,
      comment: c,
    })),
    { title: "Stale AI comments: the code changed after the comment was written", matchOnDescription: true },
  );
  if (!picked) return;
  const at = new vscode.Position(picked.comment.line - 1, 0);
  await vscode.window.showTextDocument(vscode.Uri.file(picked.comment.file), { selection: new vscode.Range(at, at) });
}

/** Opens the sidecar at `## <id>`, creating the file or the entry when either is missing. */
async function editComment(arg?: CommentRef): Promise<void> {
  const ref = await resolveRef(arg);
  if (!ref) return;
  const { located, id } = ref;

  const uri = vscode.Uri.file(located.sidecar);
  if (!existsSync(located.sidecar)) await vscode.workspace.fs.writeFile(uri, new Uint8Array());
  const document = await vscode.workspace.openTextDocument(uri);
  const sidecar = parseSidecar(document.getText());
  if (!sidecar.entries.some((e) => e.id === id)) {
    sidecar.entries.push({ id, meta: new Map(), body: "" });
    const edit = new vscode.WorkspaceEdit();
    const whole = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
    edit.replace(uri, whole, serializeSidecar(sidecar));
    await vscode.workspace.applyEdit(edit);
  }
  const heading = `## ${id}`;
  let line = 0;
  for (; line < document.lineCount; line++) if (document.lineAt(line).text.trimEnd() === heading) break;
  const target = Math.min(line + 1, document.lineCount - 1);
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const at = new vscode.Position(target, 0);
  editor.selection = new vscode.Selection(at, at);
  editor.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** An ordinary comment named by a code action (absolute path, 1-based line) or by the cursor. */
interface LineRef {
  file: string;
  line: number;
}

/** The marker, bare or expanded, whose lines include 0-based `line`. */
async function markerCovering(document: vscode.TextDocument, line: number): Promise<Marker | undefined> {
  const located = locate(document);
  if (!located) return undefined;
  return (await findMarkers(languageForPath(located.file)!, document.getText())).find(
    (m) => m.id && document.positionAt(m.start).line <= line && line <= document.positionAt(m.end).line,
  );
}

/** Promote on an AI comment's lines; demote on an ordinary comment that may leave the code. */
async function provideCodeActions(document: vscode.TextDocument, line: number): Promise<vscode.CodeAction[]> {
  const located = locate(document);
  if (!located) return [];
  const marker = await markerCovering(document, line);
  if (marker) {
    const action = new vscode.CodeAction("Promote AI comment to an ordinary comment", vscode.CodeActionKind.RefactorRewrite);
    action.command = { command: COMMANDS.promote, title: action.title, arguments: [{ file: document.fileName, id: marker.id }] };
    return [action];
  }
  const target = await demoteTarget(located.file, document.getText(), line + 1);
  if (typeof target === "string") return [];
  const what = target.style === "string" ? "string" : "comment";
  const action = new vscode.CodeAction(`Demote ${what} to an AI comment (move it to the sidecar)`, vscode.CodeActionKind.RefactorRewrite);
  action.command = { command: COMMANDS.demote, title: action.title, arguments: [{ file: document.fileName, line: target.line }] };
  return [action];
}

/**
 * Saves `document` and runs `<cli> <verb> <target>` from its repository, so promote and
 * demote follow the same sync and collapse rules as the CLI. With `print`, the CLI only
 * reports the rewrite and the extension applies it (see ./edits.ts). Resolves to the CLI's
 * report, or undefined after telling the user why it did not run.
 */
async function runOnFile(document: vscode.TextDocument, verb: string, suffix: string, options: { print?: boolean } = {}): Promise<string | undefined> {
  if (document.isDirty && !(await document.save())) return undefined;
  const repo = await findRepo(path.dirname(document.fileName));
  if (!repo?.cli) {
    void vscode.window.showInformationMessage(repo ? `Run \`${BRAND} init\` in this repository first.` : "Open a file in a git repository.");
    return undefined;
  }
  const file = path.relative(repo.root, document.fileName).split(path.sep).join("/");
  const target = JSON.stringify(`${file}:${suffix}`);
  try {
    if (!options.print) return await runCli(repo.cli, `${verb} ${target}`, repo.root);
    // The extension writes the rewrite itself, as one edit Ctrl+Z reverts in every file.
    return await applyPrinted(repo.root, await runCli(repo.cli, `${verb} --print ${target}`, repo.root));
  } catch (error) {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

async function promoteComment(arg?: CommentRef): Promise<string | undefined> {
  let ref = arg && { document: await vscode.workspace.openTextDocument(arg.file), id: arg.id };
  const editor = vscode.window.activeTextEditor;
  if (!ref && editor) {
    const marker = await markerCovering(editor.document, editor.selection.active.line);
    ref = marker && { document: editor.document, id: marker.id! };
  }
  if (!ref) {
    void vscode.window.showInformationMessage("No AI comment on this line.");
    return undefined;
  }
  return runOnFile(ref.document, "promote", ref.id);
}

async function demoteComment(arg?: LineRef): Promise<string | undefined> {
  const editor = vscode.window.activeTextEditor;
  const document = arg ? await vscode.workspace.openTextDocument(arg.file) : editor?.document;
  const line = arg ? arg.line : editor && editor.selection.active.line + 1;
  if (!document || line === undefined) return undefined;
  return runOnFile(document, "demote", String(line), { print: true });
}
