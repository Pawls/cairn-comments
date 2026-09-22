import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import {
  BRAND,
  SIDECAR_ROOT,
  findMarkers,
  languageForPath,
  parseSidecar,
  serializeSidecar,
  sidecarPathFor,
  type Marker,
  type Sidecar,
  type SidecarEntry,
} from "@tildenote/core";
import { findSidecarRoot, hoverMarkdown, planOverlay, type OverlayMode, type PlannedDecoration } from "./overlay.js";

export const COMMANDS = {
  toggle: `${BRAND}.toggleOverlay`,
  edit: `${BRAND}.editComment`,
} as const;

const STATE_KEY = "overlay.on";
const DEBOUNCE_MS = 100;

/** What the e2e test (and a debugger) can reach through `activate`'s return value. */
export interface TestApi {
  mode(): OverlayMode;
  /** Recomputes and applies the overlay for one editor, returning what was applied. */
  refresh(editor: vscode.TextEditor): Promise<Applied>;
}

export interface Applied {
  hidden: vscode.DecorationOptions[];
  revealed: vscode.DecorationOptions[];
  missing: vscode.DecorationOptions[];
}

interface Located {
  root: string;
  /** Root-relative, forward-slash path used for the sidecar and the language lookup. */
  file: string;
  sidecar: string;
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
  return findMarkers(languageForPath(located.file)!, document.getText());
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
  context.subscriptions.push(hiddenType, revealedType, missingType);

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

  const watcher = vscode.workspace.createFileSystemWatcher(`**/${SIDECAR_ROOT}/**/*.md`);
  const onSidecarChange = (uri: vscode.Uri) => {
    store.invalidate(uri.fsPath);
    refreshAll();
  };
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(onSidecarChange),
    watcher.onDidCreate(onSidecarChange),
    watcher.onDidDelete(onSidecarChange),
    vscode.window.onDidChangeVisibleTextEditors(refreshAll),
    vscode.window.onDidChangeTextEditorSelection((e) => schedule(e.textEditor)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (isSidecar(e.document)) refreshAll();
      else editorsOf(e.document).forEach(schedule);
    }),
    vscode.workspace.onDidCloseTextDocument((d) => {
      // The disk copy is authoritative again once the editor buffer is gone.
      if (isSidecar(d)) onSidecarChange(d.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(BRAND)) refreshAll();
    }),
    vscode.commands.registerCommand(COMMANDS.toggle, async () => {
      await context.workspaceState.update(STATE_KEY, mode() === "off");
      renderStatus();
      refreshAll();
    }),
    vscode.commands.registerCommand(COMMANDS.edit, (arg?: { file: string; id: string }) => editComment(arg)),
    vscode.languages.registerHoverProvider(
      { scheme: "file", language: "python" },
      { provideHover: (document, position) => provideHover(store, document, position) },
    ),
  );
  refreshAll();
  return { mode, refresh };
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
    color: p.kind === "missing" ? new vscode.ThemeColor("editorWarning.foreground") : color,
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
  const args = encodeURIComponent(JSON.stringify({ file: document.fileName, id: marker.id }));
  const markdown = new vscode.MarkdownString(
    `${hoverMarkdown(marker.id!, entry, sidecarPathFor(located.file))}\n\n[Edit comment](command:${COMMANDS.edit}?${args})`,
    true,
  );
  markdown.isTrusted = { enabledCommands: [COMMANDS.edit] };
  const range = new vscode.Range(document.positionAt(marker.start), document.positionAt(marker.end));
  return new vscode.Hover(markdown, range);
}

/** Opens the sidecar at `## <id>`, creating the file or the entry when either is missing. */
async function editComment(arg?: { file: string; id: string }): Promise<void> {
  let located: Located | undefined;
  let id: string | undefined;
  if (arg) {
    const document = await vscode.workspace.openTextDocument(arg.file);
    located = locate(document);
    id = arg.id;
  } else {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const hit = await markerAt(editor.document, editor.selection.active.line);
    if (!hit) {
      void vscode.window.showInformationMessage("No AI comment marker on this line.");
      return;
    }
    located = hit.located;
    id = hit.marker.id;
  }
  if (!located || !id) return;

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
