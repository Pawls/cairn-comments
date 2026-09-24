import path from "node:path";
import * as vscode from "vscode";
import { BRAND, SCAN_IGNORE } from "@cairn-comments/core";
import { ReviewModel, findRepo, runCli, type Repo, type ReviewComment, type ReviewFile } from "./review.js";

export const REVIEW_VIEW = `${BRAND}.review`;
export const REVIEW_COMMANDS = {
  scan: `${BRAND}.scan`,
  apply: `${BRAND}.applyReview`,
} as const;

type Node = { kind: "file"; group: ReviewFile } | { kind: "comment"; group: ReviewFile; comment: ReviewComment };

/** What the e2e test drives in place of clicking checkboxes. */
export interface ReviewApi {
  scan(): Promise<void>;
  files(): readonly ReviewFile[];
  setAccepted(file: string, line: number | undefined, accept: boolean): void;
  /** Runs `scan --apply` and rescans; resolves to the CLI's report. */
  apply(): Promise<string>;
  message(): string | undefined;
}

const checkbox = (on: boolean) => (on ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked);

/**
 * The scan review tree: files, then their candidate comments, checked to accept. Apply
 * converts the checked ones and records the unchecked ones in the ignore file, so a rescan
 * stays quiet about both. The CLI does the work (see ./review.ts).
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
        item.description = `${node.group.comments.length}`;
        item.checkboxState = checkbox(node.group.comments.some((c) => c.accept));
        item.contextValue = "file";
        return item;
      }
      const { comment } = node;
      const item = new vscode.TreeItem(comment.text.split("\n")[0]!, vscode.TreeItemCollapsibleState.None);
      item.description = `${comment.line} · ${comment.detectors.join(", ")}`;
      item.tooltip = new vscode.MarkdownString(`${comment.text}\n\n*${comment.detectors.join(", ")} · score ${comment.score}*`);
      item.checkboxState = checkbox(comment.accept);
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

  const setAccepted = (file: string, line: number | undefined, accept: boolean) => {
    model.setAccepted(file, line, accept);
    changed.fire();
  };

  async function scan(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    repo = folder ? await findRepo(folder.uri.fsPath) : undefined;
    model.load([]);
    if (!repo?.cli) {
      setMessage(repo ? `Run \`${BRAND} init\` in this repository to review AI comments.` : "Open a git repository to review AI comments.");
    } else {
      const review = JSON.parse(await runCli(repo.cli, "scan --json", repo.root)) as { comments: ReviewComment[] };
      model.load(review.comments);
      const count = review.comments.length;
      setMessage(count ? `${count} likely AI comment(s). Uncheck the ones to keep as they are, then apply.` : "No likely AI comments found.");
    }
    changed.fire();
  }

  async function apply(): Promise<string> {
    if (!repo?.cli || !model.files().length) return "";
    const report = await runCli(repo.cli, "scan --apply -", repo.root, JSON.stringify(model.toReview()));
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
        const accept = state === vscode.TreeItemCheckboxState.Checked;
        model.setAccepted(node.group.file, node.kind === "comment" ? node.comment.line : undefined, accept);
      }
      changed.fire();
    }),
    vscode.commands.registerCommand(REVIEW_COMMANDS.scan, guarded(scan)),
    vscode.commands.registerCommand(REVIEW_COMMANDS.apply, guarded(apply)),
  );
  setMessage(`Scan to list likely AI comments. Rejected ones are remembered in ${SCAN_IGNORE}.`);
  return { scan, files: () => model.files(), setAccepted, apply, message: () => view.message };
}
