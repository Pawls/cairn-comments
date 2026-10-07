import * as vscode from "vscode";
import { BRAND } from "@cairn-comments/core";
import type { OrphanComment, StaleComment } from "./review.js";

export const STALE_VIEW = `${BRAND}.stale`;
export const ORPHANS_VIEW = `${BRAND}.orphans`;
export const REFRESH_LISTS = `${BRAND}.refreshLists`;
const REFRESH_DEBOUNCE_MS = 500;

/** A list's items, or a string explaining why there are none to show. */
type Load<T> = () => Promise<T[] | string>;

export interface ListsApi {
  refresh(): Promise<void>;
  /** Refreshes whichever list is visible, shortly: for a burst of saves or sidecar changes. */
  scheduleRefresh(): void;
  stale(): readonly StaleComment[];
  orphans(): readonly OrphanComment[];
}

/**
 * The stale and orphan lists in the Activity Bar container. Both come from the CLI
 * (`check --stale`, `check --orphans`), so they cover the whole repository as CI sees it.
 */
export function registerLists(
  context: vscode.ExtensionContext,
  load: { stale: Load<StaleComment>; orphans: Load<OrphanComment> },
  editCommand: string,
): ListsApi {
  const stale = list<StaleComment>(STALE_VIEW, "No stale AI comments.", (c) => {
    const item = new vscode.TreeItem(c.text.split("\n")[0]!, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon("warning");
    item.description = `${vscode.workspace.asRelativePath(c.file)}:${c.line}`;
    item.tooltip = new vscode.MarkdownString(c.text);
    const at = new vscode.Range(c.line - 1, 0, c.line - 1, 0);
    item.command = { command: "vscode.open", title: "Open", arguments: [vscode.Uri.file(c.file), { selection: at } satisfies vscode.TextDocumentShowOptions] };
    return item;
  });
  const orphans = list<OrphanComment>(ORPHANS_VIEW, "Every AI comment places in its code.", (c) => {
    const item = new vscode.TreeItem(c.text || c.id, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon("debug-disconnect");
    item.description = `${vscode.workspace.asRelativePath(c.source)} · ${c.scope ?? "module level"}`;
    item.tooltip = new vscode.MarkdownString(`Last placed in \`${c.scope ?? "module level"}\`; its code changed or was removed. Open the entry to move or delete it.`);
    item.command = { command: editCommand, title: "Open entry", arguments: [{ file: c.source, id: c.id }] };
    return item;
  });

  async function refresh(): Promise<void> {
    await Promise.all([stale.load(load.stale), orphans.load(load.orphans)]);
  }

  let timer: NodeJS.Timeout | undefined;
  const scheduleRefresh = () => {
    if (!stale.view.visible && !orphans.view.visible) return;
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), REFRESH_DEBOUNCE_MS);
  };

  context.subscriptions.push(
    stale,
    orphans,
    { dispose: () => clearTimeout(timer) },
    stale.view.onDidChangeVisibility((e) => {
      if (e.visible) void stale.load(load.stale);
    }),
    orphans.view.onDidChangeVisibility((e) => {
      if (e.visible) void orphans.load(load.orphans);
    }),
    vscode.workspace.onDidSaveTextDocument(scheduleRefresh),
    vscode.commands.registerCommand(REFRESH_LISTS, refresh),
  );
  return { refresh, scheduleRefresh, stale: () => stale.items, orphans: () => orphans.items };
}

interface List<T> extends vscode.Disposable {
  view: vscode.TreeView<T>;
  items: T[];
  load(from: Load<T>): Promise<void>;
}

function list<T>(id: string, empty: string, toItem: (item: T) => vscode.TreeItem): List<T> {
  const changed = new vscode.EventEmitter<void>();
  const state: { items: T[] } = { items: [] };
  const view = vscode.window.createTreeView<T>(id, {
    treeDataProvider: { onDidChangeTreeData: changed.event, getChildren: (node) => (node ? [] : state.items), getTreeItem: toItem },
  });
  return {
    view,
    get items() {
      return state.items;
    },
    async load(from) {
      let found: T[] | string;
      try {
        found = await from();
      } catch (error) {
        found = `${BRAND}: ${error instanceof Error ? error.message : String(error)}`;
      }
      state.items = typeof found === "string" ? [] : found;
      if (typeof found === "string") view.message = found;
      else view.message = found.length ? undefined : empty;
      view.badge = state.items.length ? { value: state.items.length, tooltip: `${state.items.length}` } : undefined;
      changed.fire();
    },
    dispose() {
      view.dispose();
      changed.dispose();
    },
  };
}
