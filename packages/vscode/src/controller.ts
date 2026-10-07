// The overlay's state across editors: whether it is on, which documents show their comments
// through the placed view, and the debounced refresh that redraws an editor after a change.
import * as vscode from "vscode";
import { BRAND } from "@cairn-comments/core";
import type { OverlayMode } from "./overlay.js";
import { OWN_LINE_STYLES, PlacedView, type OwnLineStyle, type PlacedRender } from "./placed.js";
import { SidecarStore, locate, markersIn } from "./sidecars.js";

const STATE_KEY = "overlay.on";
const DEBOUNCE_MS = 100;

export interface Applied {
  /** The file's placed comments; absent when it shows its comments inline or the overlay is off. */
  placed?: PlacedRender;
}

export class OverlayController {
  readonly store = new SidecarStore();
  readonly view = new PlacedView();
  /** Documents that showed no comments inline and had comments in their sidecar at their last refresh. */
  private readonly placedDocuments = new Set<string>();
  private readonly timers = new Map<vscode.TextEditor, NodeJS.Timeout>();
  private readonly status: vscode.StatusBarItem;

  /** Registers the placed view and the status bar toggle, which runs `toggleCommand`. */
  constructor(
    private readonly context: vscode.ExtensionContext,
    toggleCommand: string,
  ) {
    context.subscriptions.push(this.view);
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    this.status.command = toggleCommand;
    this.renderStatus();
    context.subscriptions.push(this.status);
  }

  mode(): OverlayMode {
    return this.context.workspaceState.get<boolean>(STATE_KEY, false) ? "on" : "off";
  }

  async toggle(): Promise<void> {
    await this.context.workspaceState.update(STATE_KEY, this.mode() === "off");
    this.renderStatus();
    this.refreshAll();
  }

  isPlaced(document: vscode.TextDocument): boolean {
    return this.placedDocuments.has(document.uri.toString());
  }

  /** Recomputes and applies the overlay for one editor, returning what was applied. */
  async refresh(editor: vscode.TextEditor): Promise<Applied> {
    const applied: Applied = {};
    const located = locate(editor.document);
    if (!located) return applied;
    const document = editor.document;
    const markers = await markersIn(document, located);
    if (editor.document !== document || document.isClosed) return applied;
    const sidecar = this.store.get(located.sidecar);
    if (markers.length || !sidecar?.entries.length) {
      this.placedDocuments.delete(document.uri.toString());
      this.view.forget(document);
      this.view.clear(editor);
      return applied;
    }
    this.placedDocuments.add(document.uri.toString());
    if (!this.view.isCurrent(document) && !(await this.view.place(document, located.file, sidecar))) {
      // The document changed while placing; the refresh its change scheduled places it again.
      return applied;
    }
    if (editor.document !== document || document.isClosed) return applied;
    if (this.mode() === "on") applied.placed = this.view.render(editor, this.store.entries(located.sidecar), ownLineStyle(), overlayColor());
    else this.view.clear(editor);
    return applied;
  }

  refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) this.schedule(editor);
  }

  /** A sidecar changed on disk: an external change to every file it anchors, so place them again. */
  sidecarChanged(uri: vscode.Uri): void {
    this.store.invalidate(uri.fsPath);
    this.view.forget();
    this.refreshAll();
  }

  /** A sidecar's open buffer changed. */
  sidecarEdited(): void {
    this.view.forget();
    this.refreshAll();
  }

  /** A source file's open buffer changed: its sites move with the edit. */
  sourceEdited(event: vscode.TextDocumentChangeEvent): void {
    this.view.track(event);
    this.scheduleEditorsOf(event.document);
  }

  sourceSaved(source: vscode.TextDocument): void {
    this.view.forget(source);
    this.scheduleEditorsOf(source);
  }

  sourceClosed(source: vscode.TextDocument): void {
    this.view.forget(source);
    this.placedDocuments.delete(source.uri.toString());
  }

  private schedule(editor: vscode.TextEditor): void {
    clearTimeout(this.timers.get(editor));
    this.timers.set(
      editor,
      setTimeout(() => {
        this.timers.delete(editor);
        void this.refresh(editor);
      }, DEBOUNCE_MS),
    );
  }

  private scheduleEditorsOf(document: vscode.TextDocument): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === document) this.schedule(editor);
    }
  }

  private renderStatus(): void {
    const on = this.mode() === "on";
    this.status.text = on ? "$(eye) AI comments" : "$(eye-closed) AI comments";
    this.status.tooltip = on ? "AI comments are shown: click to hide them" : "AI comments are hidden: click to show them";
    this.status.show();
  }
}

function overlayColor(): string | vscode.ThemeColor {
  const configured = vscode.workspace.getConfiguration(BRAND).get<string>("overlayColor", "");
  return configured || new vscode.ThemeColor("editorCodeLens.foreground");
}

function ownLineStyle(): OwnLineStyle {
  const configured = vscode.workspace.getConfiguration(BRAND).get<string>("ownLineStyle", "codelens");
  return OWN_LINE_STYLES.find((s) => s === configured) ?? "codelens";
}
