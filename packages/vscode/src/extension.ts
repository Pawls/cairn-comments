import { existsSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import {
  BRAND,
  BRAND_TITLE,
  SIDECAR_ROOT,
  demoteTarget,
  parseSidecar,
  serializeSidecar,
  type CommentSite,
  type Marker,
} from "@cairn-comments/core";
import { PlacedActions, type CommentRef } from "./actions.js";
import { OverlayController, type Applied } from "./controller.js";
import { registerLists, type ListsApi } from "./lists.js";
import type { OverlayMode } from "./overlay.js";
import { applyPrinted } from "./edits.js";
import { CommentPaste } from "./paste.js";
import { PlacedComment, SHOW_COMMENT, type PlacedView } from "./placed.js";
import { findRepo, orphansOf, runCli, shellQuote, type OrphanComment, type Repo, type StaleComment } from "./review.js";
import { registerReviewTree, type ReviewApi } from "./reviewTree.js";
import { PasteSaves, UndoSaves } from "./saves.js";
import { installBundledCli, offerRepair } from "./setup.js";
import { isSidecar, locate, markersIn } from "./sidecars.js";

export type { Applied } from "./controller.js";

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

/**
 * VS Code language ids for every extension `LANGUAGES` covers. `kotlin` is not built in, so
 * the manifest registers it for `.kt`/`.kts`; VS Code merges that with a Kotlin extension's.
 */
const VSCODE_LANGUAGE_IDS = ["python", "typescript", "typescriptreact", "javascript", "javascriptreact", "csharp", "java", "kotlin"];

const NO_COMMENT_HERE = "No AI comment on this line.";

/** What the e2e test (and a debugger) can reach through `activate`'s return value. */
export interface TestApi {
  mode(): OverlayMode;
  /** Recomputes and applies the overlay for one editor, returning what was applied. */
  refresh(editor: vscode.TextEditor): Promise<Applied>;
  review: ReviewApi;
  /** The repair offer for a repository whose recorded CLI is gone, with `ask` in place of the prompt. */
  repair(ask: (root: string, missing: string) => Promise<boolean>): Promise<boolean>;
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

export function activate(context: vscode.ExtensionContext): TestApi {
  // Before anything runs the CLI: setup and repair record the home's copy.
  installBundledCli(context);
  const overlay = new OverlayController(context, COMMANDS.toggle);
  const lists = registerLists(context, { stale: staleComments, orphans: orphanComments }, COMMANDS.edit);
  const watcher = vscode.workspace.createFileSystemWatcher(`**/${SIDECAR_ROOT}/**/*.md`);
  const sidecarChanged = (uri: vscode.Uri) => {
    overlay.sidecarChanged(uri);
    lists.scheduleRefresh();
  };
  const actions = new PlacedActions({
    view: overlay.view,
    locate,
    isPlaced: (document) => overlay.isPlaced(document),
    sidecar: (file) => overlay.store.get(file),
    written: (file) => sidecarChanged(vscode.Uri.file(file)),
  });
  // A paste edit changes the sidecar's buffer; it is saved once the change arrives.
  const pasteSaves = new PasteSaves();
  const paste = createPaste(overlay, pasteSaves);

  context.subscriptions.push(
    watcher,
    watcher.onDidChange(sidecarChanged),
    watcher.onDidCreate(sidecarChanged),
    watcher.onDidDelete(sidecarChanged),
    pasteSaves,
    ...trackDocuments(overlay, new UndoSaves(), pasteSaves, sidecarChanged),
    ...registerCommentCommands(overlay, actions),
    ...registerProviders(paste, overlay.view),
  );
  overlay.refreshAll();
  const folder = firstFolder();
  if (folder) void offerRepair(folder);
  return {
    mode: () => overlay.mode(),
    refresh: (editor) => overlay.refresh(editor),
    review: registerReviewTree(context),
    repair: async (ask) => {
      const at = firstFolder();
      return at ? offerRepair(at, ask) : false;
    },
    staleComments,
    orphanComments,
    lists,
    paste,
    placed: { sites: (document) => overlay.view.sites(document), comment: (document, id) => overlay.view.comment(document, id) },
  };
}

export function deactivate(): void {
  // Nothing to release: activate registers every disposable on context.subscriptions.
}

function firstFolder(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function createPaste(overlay: OverlayController, pasteSaves: PasteSaves): CommentPaste {
  const { store, view } = overlay;
  return new CommentPaste({
    target: async (document) => {
      const located = locate(document);
      if (!located || (await markersIn(document, located)).length) return undefined;
      const sidecar = store.get(located.sidecar) ?? { preamble: "", entries: [] };
      const placed = sidecar.entries.some((e) => e.meta.has("pos"));
      return { root: located.root, file: located.file, sidecarPath: located.sidecar, sidecar, placed };
    },
    sites: async (document) => {
      const located = locate(document);
      const sidecar = located && store.get(located.sidecar);
      if (located && sidecar && !view.isCurrent(document)) await view.place(document, located.file, sidecar);
      return view.sites(document);
    },
    beforeCut: (document, range) => view.beforeCut(document, range),
    willPaste: (document, text, sites) => view.expectPaste(document, text, sites),
    entries: (target) => store.entries(target.sidecarPath),
    willChange: (file) => pasteSaves.expect(file),
  });
}

/** Keeps the overlay and the extension's own saves in step with the open documents and the settings. */
function trackDocuments(
  overlay: OverlayController,
  undoSaves: UndoSaves,
  pasteSaves: PasteSaves,
  sidecarChanged: (uri: vscode.Uri) => void,
): vscode.Disposable[] {
  return [
    vscode.window.onDidChangeVisibleTextEditors(() => overlay.refreshAll()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      undoSaves.changed(e);
      if (isSidecar(e.document)) {
        pasteSaves.saveIfExpected(e.document);
        overlay.sidecarEdited();
      } else {
        overlay.sourceEdited(e);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (isSidecar(d)) return;
      undoSaves.saved(d);
      overlay.sourceSaved(d);
    }),
    vscode.workspace.onDidCloseTextDocument((d) => {
      // The disk copy is authoritative again once the editor buffer is gone.
      if (isSidecar(d)) {
        sidecarChanged(d.uri);
      } else {
        overlay.sourceClosed(d);
        undoSaves.closed(d);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(BRAND)) overlay.refreshAll();
    }),
  ];
}

function registerCommentCommands(overlay: OverlayController, actions: PlacedActions): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(COMMANDS.toggle, () => overlay.toggle()),
    // A thread's Edit button edits in place; from the palette or a list, the sidecar entry opens.
    vscode.commands.registerCommand(COMMANDS.edit, async (arg?: CommentRef) => {
      if (arg instanceof PlacedComment) return actions.startEdit(arg);
      const atCursor = arg ? undefined : await actions.resolve();
      const ref = arg ?? (atCursor && { file: atCursor.document.fileName, id: atCursor.id });
      if (ref) await editComment(ref);
      else void vscode.window.showInformationMessage(NO_COMMENT_HERE);
    }),
    vscode.commands.registerCommand(COMMANDS.saveEdit, (comment: PlacedComment) => actions.saveEdit(comment)),
    vscode.commands.registerCommand(COMMANDS.cancelEdit, (comment: PlacedComment) => actions.cancelEdit(comment)),
    vscode.commands.registerCommand(COMMANDS.confirm, async (arg?: CommentRef) => {
      const placed = await actions.resolve(arg);
      if (placed) await actions.confirm(placed);
      else void vscode.window.showInformationMessage(NO_COMMENT_HERE);
      overlay.refreshAll();
    }),
    vscode.commands.registerCommand(COMMANDS.reviewStale, () => reviewStale()),
    vscode.commands.registerCommand(COMMANDS.promote, async (arg?: CommentRef) => {
      const placed = await actions.resolve(arg);
      return placed ? actions.promote(placed) : promoteComment(arg);
    }),
    vscode.commands.registerCommand(COMMANDS.delete, async (arg?: CommentRef) => {
      const placed = await actions.resolve(arg);
      if (placed) await actions.delete(placed);
      else void vscode.window.showInformationMessage(NO_COMMENT_HERE);
    }),
    vscode.commands.registerCommand(COMMANDS.demote, (arg?: LineRef) => demoteComment(arg)),
    vscode.commands.registerCommand(SHOW_COMMENT, (uri: vscode.Uri, id: string) => overlay.view.toggle(uri, id)),
  ];
}

function registerProviders(paste: CommentPaste, view: PlacedView): vscode.Disposable[] {
  const selectors = VSCODE_LANGUAGE_IDS.map((language) => ({ scheme: "file", language }));
  const codeActions: vscode.CodeActionProvider = {
    provideCodeActions: (document, range) => provideCodeActions(document, range.start.line),
  };
  const codeActionKinds = { providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite] };
  return [
    ...selectors.map((selector) => vscode.languages.registerDocumentPasteEditProvider(selector, paste, CommentPaste.metadata)),
    ...selectors.map((selector) => vscode.languages.registerCodeLensProvider(selector, view)),
    ...selectors.map((selector) => vscode.languages.registerCodeActionsProvider(selector, codeActions, codeActionKinds)),
  ];
}

/**
 * The first workspace folder's repository, once `init` set it up; otherwise the message that
 * explains why there is nothing to check for `what`.
 */
async function checkableRepo(what: string): Promise<(Repo & { cli: string }) | string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const repo = folder ? await findRepo(folder.uri.fsPath) : undefined;
  if (!repo) return `Open a git repository to check for ${what}.`;
  if (!repo.cli) return `Set up ${BRAND_TITLE} from the AI Comments Review view to check for ${what}.`;
  return { root: repo.root, cli: repo.cli };
}

/** Stale comments across the repository through the CLI, as CI would see them. */
async function staleComments(): Promise<StaleComment[] | string> {
  const repo = await checkableRepo("stale comments");
  if (typeof repo === "string") return repo;
  // Exit 1 means stale comments were found; the list is still on stdout.
  const found = JSON.parse(await runCli(repo.cli, "check --stale --json", repo.root, undefined, [0, 1])) as StaleComment[];
  return found.map((c) => ({ ...c, file: path.join(repo.root, c.file) }));
}

/** Comments that no longer place in their code, through the CLI (`check --orphans`). */
async function orphanComments(): Promise<OrphanComment[] | string> {
  const repo = await checkableRepo("orphaned comments");
  if (typeof repo === "string") return repo;
  // Exit 1 means problems were found; the report is still on stdout.
  const output = await runCli(repo.cli, "check --orphans --json", repo.root, undefined, [0, 1]);
  const report = JSON.parse(output) as { problems: { kind: string }[] };
  return orphansOf(report).map((c) => ({ ...c, source: path.join(repo.root, c.source) }));
}

async function reviewStale(): Promise<void> {
  const found = await staleComments();
  if (typeof found === "string") {
    void vscode.window.showInformationMessage(found);
    return;
  }
  if (!found.length) {
    void vscode.window.showInformationMessage("No stale AI comments.");
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
async function editComment(ref: CommentRef): Promise<void> {
  const located = locate(await vscode.workspace.openTextDocument(ref.file));
  if (!located) return;
  const { id } = ref;

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
  while (line < document.lineCount && document.lineAt(line).text.trimEnd() !== heading) line++;
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
  return (await markersIn(document, located)).find(
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
async function runOnFile(
  document: vscode.TextDocument,
  verb: string,
  suffix: string,
  options: { print?: boolean } = {},
): Promise<string | undefined> {
  if (document.isDirty && !(await document.save())) return undefined;
  const repo = await findRepo(path.dirname(document.fileName));
  if (!repo) {
    void vscode.window.showInformationMessage("Open a file in a git repository.");
    return undefined;
  }
  if (!repo.cli) {
    void vscode.window.showInformationMessage(`Run \`${BRAND} init\` in this repository first.`);
    return undefined;
  }
  const file = path.relative(repo.root, document.fileName).split(path.sep).join("/");
  try {
    const target = shellQuote(`${file}:${suffix}`);
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
    void vscode.window.showInformationMessage(NO_COMMENT_HERE);
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
