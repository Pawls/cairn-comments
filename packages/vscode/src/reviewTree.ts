import { mkdirSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { BRAND, SCAN_IGNORE, SIDECAR_ROOT } from "@cairn-comments/core";
import { ReviewModel, findRepo, runCli, type Repo, type ReviewComment, type ReviewFile, type ReviewItem } from "./review.js";

export const REVIEW_VIEW = `${BRAND}.review`;
export const REVIEW_COMMANDS = {
  scan: `${BRAND}.scan`,
  markSelected: `${BRAND}.markSelectedAsAi`,
  keepSelected: `${BRAND}.keepSelectedAsOrdinary`,
} as const;
/** Enables the two decision buttons; package.json names it in their `enablement`. */
const HAS_SELECTION = `${BRAND}.reviewHasSelection`;

type Node = { kind: "file"; group: ReviewFile } | { kind: "comment"; group: ReviewFile; comment: ReviewItem };

/** What the e2e test drives in place of clicking checkboxes. */
export interface ReviewApi {
  scan(): Promise<void>;
  files(): readonly ReviewFile[];
  setSelected(file: string, line: number | undefined, selected: boolean): void;
  /** Runs `scan --apply` on the selected comments and rescans; resolves to the CLI's report. */
  apply(asAi: boolean): Promise<string>;
  message(): string | undefined;
  visible(): boolean;
}

const checkbox = (on: boolean) => (on ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked);

/**
 * The scan review tree: files, then their candidate comments, checked to select. The title
 * buttons convert the selected ones to AI comments or record them in the ignore file, so a
 * rescan stays quiet about both; unselected ones stay listed. The CLI does the work (see
 * ./review.ts).
 */
export function registerReviewTree(context: vscode.ExtensionContext): ReviewApi {
  const model = new ReviewModel();
  let repo: Repo | undefined;
  const changed = new vscode.EventEmitter<void>();

  const provider: vscode.TreeDataProvider<Node> = {
    onDidChangeTreeData: changed.event,
    getChildren: (node) =>
      node
        ? node.kind === "file"
          ? node.group.comments.map((comment) => ({ kind: "comment", group: node.group, comment }))
          : []
        : model.files().map((group) => ({ kind: "file", group })),
    getTreeItem: (node) => {
      if (node.kind === "file") {
        const item = new vscode.TreeItem(node.group.file, vscode.TreeItemCollapsibleState.Expanded);
        item.resourceUri = vscode.Uri.file(path.join(repo!.root, node.group.file));
        const selected = node.group.comments.filter((c) => c.selected).length;
        const total = node.group.comments.length;
        item.description = selected ? `${selected} of ${total} selected` : `${total}`;
        // Checked only when all are, so clicking a partly selected file selects the rest.
        item.checkboxState = checkbox(selected === total);
        item.contextValue = "file";
        return item;
      }
      const { comment } = node;
      const item = new vscode.TreeItem(comment.text.split("\n")[0]!, vscode.TreeItemCollapsibleState.None);
      item.description = `${comment.line} · ${comment.detectors.join(", ")}`;
      item.tooltip = new vscode.MarkdownString(`${comment.text}\n\n*${comment.detectors.join(", ")} · score ${comment.score}*`);
      item.checkboxState = checkbox(comment.selected);
      item.command = {
        command: "vscode.open",
        title: "Open",
        arguments: [
          vscode.Uri.file(path.join(repo!.root, comment.file)),
          { selection: new vscode.Range(comment.line - 1, 0, comment.endLine - 1, 0) } satisfies vscode.TextDocumentShowOptions,
        ],
      };
      return item;
    },
  };

  const view = vscode.window.createTreeView(REVIEW_VIEW, { treeDataProvider: provider, manageCheckboxStateManually: true });
  const setMessage = (message: string | undefined) => (view.message = message);

  /** Redraws the tree and syncs the context key behind the decision buttons. */
  const refresh = () => {
    changed.fire();
    void vscode.commands.executeCommand("setContext", HAS_SELECTION, model.selectedCount() > 0);
  };

  const setSelected = (file: string, line: number | undefined, selected: boolean) => {
    model.setSelected(file, line, selected);
    refresh();
  };

  /** The workspace folder of the active editor's file, else the first one. */
  function scanFolder(): vscode.WorkspaceFolder | undefined {
    const active = vscode.window.activeTextEditor?.document.uri;
    return (active && vscode.workspace.getWorkspaceFolder(active)) || vscode.workspace.workspaceFolders?.[0];
  }

  async function scan(): Promise<void> {
    const folder = scanFolder();
    repo = folder ? await findRepo(folder.uri.fsPath) : undefined;
    model.load([]);
    if (!repo?.cli) {
      setMessage(repo ? `Run \`${BRAND} init\` in this repository to review AI comments.` : "Open a git repository to review AI comments.");
    } else {
      const cli = repo.cli;
      const root = repo.root;
      // The extension activates on this folder (package.json), and `init` does not create it.
      mkdirSync(path.join(root, SIDECAR_ROOT), { recursive: true });
      setMessage(`Scanning ${path.basename(root)}…`);
      refresh();
      const output = await vscode.window.withProgress({ location: { viewId: REVIEW_VIEW } }, () => runCli(cli, "scan --json", root));
      const review = JSON.parse(output) as { comments: ReviewComment[] };
      model.load(review.comments);
      const count = review.comments.length;
      setMessage(
        count
          ? `${count} likely AI comment(s). Check the ones to decide now, then mark them as AI comments or keep them as ordinary comments. The rest stay listed.`
          : "No likely AI comments found.",
      );
    }
    refresh();
  }

  async function apply(asAi: boolean): Promise<string> {
    if (!repo?.cli || !model.selectedCount()) return "";
    const report = await runCli(repo.cli, "scan --apply -", repo.root, JSON.stringify(model.toReview(asAi)));
    await scan();
    return report;
  }

  const guarded = (fn: () => Promise<unknown>) => async () => {
    try {
      const result = await fn();
      if (typeof result === "string" && result) void vscode.window.showInformationMessage(result.trim().replaceAll("\n", "; "));
    } catch (error) {
      void vscode.window.showErrorMessage(`${BRAND}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  context.subscriptions.push(
    changed,
    view,
    view.onDidChangeCheckboxState((e) => {
      for (const [node, state] of e.items) {
        const selected = state === vscode.TreeItemCheckboxState.Checked;
        model.setSelected(node.group.file, node.kind === "comment" ? node.comment.line : undefined, selected);
      }
      refresh();
    }),
    // From the palette the view may be collapsed or closed, so bring it forward first.
    vscode.commands.registerCommand(
      REVIEW_COMMANDS.scan,
      guarded(async () => {
        await vscode.commands.executeCommand(`${REVIEW_VIEW}.focus`);
        await scan();
      }),
    ),
    vscode.commands.registerCommand(REVIEW_COMMANDS.markSelected, guarded(() => apply(true))),
    vscode.commands.registerCommand(REVIEW_COMMANDS.keepSelected, guarded(() => apply(false))),
  );
  setMessage(`Scan to list likely AI comments. The ones you keep as ordinary comments are remembered in ${SCAN_IGNORE}.`);
  return { scan, files: () => model.files(), setSelected, apply, message: () => view.message, visible: () => view.visible };
}
