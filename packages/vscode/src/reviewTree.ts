import { mkdirSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { BRAND, SCAN_IGNORE, SIDECAR_ROOT } from "@cairn-comments/core";
import { applyPrinted, saveOpen } from "./edits.js";
import { ReviewModel, findRepo, runCli, type Decision, type Repo, type ReviewComment, type ReviewFile, type ReviewItem } from "./review.js";

export const REVIEW_VIEW = `${BRAND}.review`;
export const REVIEW_COMMANDS = {
  scan: `${BRAND}.scan`,
  apply: `${BRAND}.applyReview`,
  markRestAsAi: `${BRAND}.markRestAsAi`,
  keepRestAsOrdinary: `${BRAND}.keepRestAsOrdinary`,
  markAi: `${BRAND}.review.markAi`,
  keep: `${BRAND}.review.keep`,
  skip: `${BRAND}.review.skip`,
} as const;
/** Context keys behind the title buttons' `enablement` in package.json. */
const HAS_DECISIONS = `${BRAND}.reviewHasDecisions`;
const HAS_COMMENTS = `${BRAND}.reviewHasComments`;

type Node = { kind: "file"; group: ReviewFile } | { kind: "comment"; group: ReviewFile; comment: ReviewItem };

/** What the e2e test drives in place of clicking the row buttons. */
export interface ReviewApi {
  /** Starts the review over: every candidate listed again, skipped ones included. */
  scan(): Promise<void>;
  files(): readonly ReviewFile[];
  decide(file: string, line: number | undefined, decision: Decision): void;
  skip(file: string, line: number | undefined): void;
  /** Runs `scan --apply` on the decided comments (and, with `rest`, the undecided ones) and rescans; resolves to the CLI's report. */
  apply(rest?: Decision): Promise<string>;
  message(): string | undefined;
  visible(): boolean;
}

const DECISION_ICON: Record<Decision, string> = { ai: "eye-closed", keep: "comment" };
const DECISION_LABEL: Record<Decision, string> = { ai: "→ AI comment", keep: "→ keep" };

/**
 * The scan review tree: files, then their candidate comments. Each row's buttons mark it as
 * an AI comment, keep it as an ordinary comment, or skip it until the next scan; the title
 * buttons apply the decisions in one pass, optionally deciding everything left undecided.
 * The CLI does the work (see ./review.ts).
 */
export function registerReviewTree(context: vscode.ExtensionContext): ReviewApi {
  const model = new ReviewModel();
  let repo: Repo | undefined;
  let loaded = false;
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
        const decided = node.group.comments.filter((c) => c.decision).length;
        const total = node.group.comments.length;
        item.description = decided ? `${decided} of ${total} decided` : `${total}`;
        item.contextValue = "file";
        return item;
      }
      const { comment } = node;
      const item = new vscode.TreeItem(comment.text.split("\n")[0]!, vscode.TreeItemCollapsibleState.None);
      const where = `${comment.line} · ${comment.detectors.join(", ")}`;
      item.description = comment.decision ? `${DECISION_LABEL[comment.decision]} · ${where}` : where;
      item.iconPath = new vscode.ThemeIcon(comment.decision ? DECISION_ICON[comment.decision] : "circle-outline");
      item.tooltip = new vscode.MarkdownString(`${comment.text}\n\n*${comment.detectors.join(", ")} · score ${comment.score}*`);
      item.contextValue = "comment";
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

  const view = vscode.window.createTreeView(REVIEW_VIEW, { treeDataProvider: provider });
  const setMessage = (message: string | undefined) => (view.message = message);

  function reviewMessage(): string {
    const count = model.commentCount();
    const skipped = model.skippedCount();
    const later = skipped ? ` ${skipped} skipped until the next scan.` : "";
    if (count) {
      return (
        `${count} likely AI comment(s). Mark each one as an AI comment or keep it as an ordinary comment, then apply the decisions. ` +
        `Skip the ones to decide later.${later}`
      );
    }
    return skipped ? `No comments left to decide.${later}` : "No likely AI comments found.";
  }

  /** Redraws the tree, its message, and the context keys behind the title buttons. */
  const refresh = () => {
    changed.fire();
    if (loaded) setMessage(reviewMessage());
    void vscode.commands.executeCommand("setContext", HAS_DECISIONS, model.decidedCount() > 0);
    void vscode.commands.executeCommand("setContext", HAS_COMMENTS, model.commentCount() > 0);
  };

  const decide = (file: string, line: number | undefined, decision: Decision) => {
    model.decide(file, line, decision);
    refresh();
  };
  const skip = (file: string, line: number | undefined) => {
    model.skip(file, line);
    refresh();
  };

  /** The workspace folder of the active editor's file, else the first one. */
  function scanFolder(): vscode.WorkspaceFolder | undefined {
    const active = vscode.window.activeTextEditor?.document.uri;
    return (active && vscode.workspace.getWorkspaceFolder(active)) || vscode.workspace.workspaceFolders?.[0];
  }

  async function scan(options: { keepSkipped?: boolean } = {}): Promise<void> {
    const folder = scanFolder();
    repo = folder ? await findRepo(folder.uri.fsPath) : undefined;
    loaded = false;
    model.load([], options);
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
      model.load(review.comments, options);
      loaded = true;
    }
    refresh();
  }

  async function apply(rest?: Decision): Promise<string> {
    const review = model.toReview(rest);
    if (!repo?.cli || !review.comments.length) return "";
    const root = repo.root;
    await saveOpen(review.comments.map((c) => path.join(root, c.file)));
    // The extension writes the rewrite itself, as one edit Ctrl+Z reverts in every file.
    const report = await applyPrinted(root, await runCli(repo.cli, "scan --apply - --print", root, JSON.stringify(review)));
    await scan({ keepSkipped: true });
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
  /** A row button: the node it was clicked on names one comment, or a whole file. */
  const onRow = (act: (file: string, line: number | undefined) => void) => (node: Node) =>
    act(node.group.file, node.kind === "comment" ? node.comment.line : undefined);

  context.subscriptions.push(
    changed,
    view,
    // From the palette the view may be collapsed or closed, so bring it forward first.
    vscode.commands.registerCommand(
      REVIEW_COMMANDS.scan,
      guarded(async () => {
        await vscode.commands.executeCommand(`${REVIEW_VIEW}.focus`);
        await scan();
      }),
    ),
    vscode.commands.registerCommand(REVIEW_COMMANDS.apply, guarded(() => apply())),
    vscode.commands.registerCommand(REVIEW_COMMANDS.markRestAsAi, guarded(() => apply("ai"))),
    vscode.commands.registerCommand(REVIEW_COMMANDS.keepRestAsOrdinary, guarded(() => apply("keep"))),
    vscode.commands.registerCommand(REVIEW_COMMANDS.markAi, onRow((file, line) => decide(file, line, "ai"))),
    vscode.commands.registerCommand(REVIEW_COMMANDS.keep, onRow((file, line) => decide(file, line, "keep"))),
    vscode.commands.registerCommand(REVIEW_COMMANDS.skip, onRow(skip)),
  );
  setMessage(`Scan to list likely AI comments. The ones you keep as ordinary comments are remembered in ${SCAN_IGNORE}.`);
  return { scan: () => scan(), files: () => model.files(), decide, skip, apply, message: () => view.message, visible: () => view.visible };
}
