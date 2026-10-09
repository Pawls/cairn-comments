import { mkdirSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { BRAND, BRAND_TITLE, SIDECAR_ROOT, privateSidecarDir } from "@cairn-comments/core";
import { applyPrinted, saveOpen } from "./edits.js";
import type { PrivateMode } from "./privateMode.js";
import { runInit } from "./setup.js";
import { existingStorage, type Storage } from "./storage.js";
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
  setup: `${BRAND}.setup`,
} as const;
/** Context keys behind the title buttons' `enablement` in package.json. */
const HAS_DECISIONS = `${BRAND}.reviewHasDecisions`;
const HAS_COMMENTS = `${BRAND}.reviewHasComments`;
/** Shows the setup welcome (package.json viewsWelcome) in a repository `init` never ran in. */
const SETUP_NEEDED = `${BRAND}.setupNeeded`;

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
  /**
   * Runs `init`, asking a fresh repository where its comments go, once `confirm` accepts the
   * dry run; then scans. Resolves to the report, or "" when declined.
   */
  setup(choices?: SetupChoices): Promise<string>;
  message(): string | undefined;
  visible(): boolean;
}

export interface SetupChoices {
  /** Where a fresh repository keeps its comments; undefined cancels. */
  choose?: (root: string) => Promise<Storage | undefined>;
  /** Accepts the plan `init --dry-run` printed. */
  confirm?: (root: string, plan: string) => Promise<boolean>;
}

const DECISION_ICON: Record<Decision, string> = { ai: "eye-closed", keep: "comment" };
const DECISION_LABEL: Record<Decision, string> = { ai: "→ AI comment", keep: "→ keep" };

/**
 * The scan review tree: files, then their candidate comments. Each row's buttons mark it as
 * an AI comment, keep it as an ordinary comment, or skip it until the next scan; the title
 * buttons apply the decisions in one pass, optionally deciding everything left undecided.
 * The CLI does the work (see ./review.ts).
 */
export function registerReviewTree(context: vscode.ExtensionContext, privateMode: PrivateMode): ReviewApi {
  const tree = new ReviewTree(privateMode);
  context.subscriptions.push(
    tree,
    // From the palette the view may be collapsed or closed, so bring it forward first.
    vscode.commands.registerCommand(
      REVIEW_COMMANDS.scan,
      guarded(async () => {
        await vscode.commands.executeCommand(`${REVIEW_VIEW}.focus`);
        await tree.scan();
      }),
    ),
    vscode.commands.registerCommand(REVIEW_COMMANDS.apply, guarded(() => tree.apply())),
    vscode.commands.registerCommand(REVIEW_COMMANDS.markRestAsAi, guarded(() => tree.apply("ai"))),
    vscode.commands.registerCommand(REVIEW_COMMANDS.keepRestAsOrdinary, guarded(() => tree.apply("keep"))),
    vscode.commands.registerCommand(REVIEW_COMMANDS.markAi, onRow((file, line) => tree.decide(file, line, "ai"))),
    vscode.commands.registerCommand(REVIEW_COMMANDS.keep, onRow((file, line) => tree.decide(file, line, "keep"))),
    vscode.commands.registerCommand(REVIEW_COMMANDS.skip, onRow((file, line) => tree.skip(file, line))),
    vscode.commands.registerCommand(REVIEW_COMMANDS.setup, guarded(() => tree.setup())),
  );
  tree.setMessage("Scan to list likely AI comments. The ones you keep as ordinary comments are remembered, so later scans skip them.");
  void tree.showSetupIfNeeded();
  return {
    scan: () => tree.scan(),
    files: () => tree.files(),
    decide: (file, line, decision) => tree.decide(file, line, decision),
    skip: (file, line) => tree.skip(file, line),
    apply: (rest) => tree.apply(rest),
    setup: (choices) => tree.setup(choices),
    message: () => tree.view.message,
    visible: () => tree.view.visible,
  };
}

class ReviewTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly model = new ReviewModel();
  /** The repository the last scan looked in. */
  private repo: Repo | undefined;
  /** Whether the model holds a finished scan, so the message counts its comments. */
  private loaded = false;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly view = vscode.window.createTreeView(REVIEW_VIEW, { treeDataProvider: this });

  constructor(private readonly privateMode: PrivateMode) {}

  dispose(): void {
    this.changed.dispose();
    this.view.dispose();
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.model.files().map((group) => ({ kind: "file", group }));
    if (node.kind !== "file") return [];
    return node.group.comments.map((comment) => ({ kind: "comment", group: node.group, comment }));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const root = this.repo!.root;
    return node.kind === "file" ? fileItem(root, node.group) : commentItem(root, node.comment);
  }

  files(): readonly ReviewFile[] {
    return this.model.files();
  }

  setMessage(message: string | undefined): void {
    this.view.message = message;
  }

  decide(file: string, line: number | undefined, decision: Decision): void {
    this.model.decide(file, line, decision);
    this.refresh();
  }

  skip(file: string, line: number | undefined): void {
    this.model.skip(file, line);
    this.refresh();
  }

  async scan(options: { keepSkipped?: boolean } = {}): Promise<void> {
    this.repo = await scanRepo();
    this.loaded = false;
    this.model.load([], options);
    void vscode.commands.executeCommand("setContext", SETUP_NEEDED, !!this.repo && !this.repo.cli);
    this.privateMode.update(this.repo?.root);
    this.view.description = this.repo && privateSidecarDir(this.repo.root) ? "private" : undefined;
    if (!this.repo) {
      this.setMessage("Open a git repository to review AI comments.");
    } else if (!this.repo.cli) {
      // The setup welcome takes the view's place.
      this.setMessage(undefined);
    } else {
      await this.load(this.repo.root, options);
    }
    this.refresh();
  }

  async apply(rest?: Decision): Promise<string> {
    const review = this.model.toReview(rest);
    if (!this.repo?.cli || !review.comments.length) return "";
    const root = this.repo.root;
    await saveOpen(review.comments.map((c) => path.join(root, c.file)));
    // The extension writes the rewrite itself, as one edit Ctrl+Z reverts in every file.
    const report = await applyPrinted(root, await runCli(["scan", "--apply", "-", "--print"], root, JSON.stringify(review)));
    await this.scan({ keepSkipped: true });
    return report;
  }

  async setup({ choose = chooseStorage, confirm = confirmSetup }: SetupChoices = {}): Promise<string> {
    const found = await scanRepo();
    if (!found) throw new Error(`open a git repository to set up ${BRAND_TITLE}`);
    const storage = existingStorage(found.root) ?? (await choose(found.root));
    if (!storage) return "";
    if (!(await confirm(found.root, await runInit(found.root, true, storage)))) return "";
    const report = await runInit(found.root, false, storage);
    await this.scan();
    return report;
  }

  /** Shows the setup welcome in place of the scan prompt when the repository has not run `init`. */
  async showSetupIfNeeded(): Promise<void> {
    const found = await scanRepo();
    if (found && !found.cli) {
      this.setMessage(undefined);
      await vscode.commands.executeCommand("setContext", SETUP_NEEDED, true);
    }
  }

  /** Runs the scan in `root` and loads its candidates. */
  private async load(root: string, options: { keepSkipped?: boolean }): Promise<void> {
    // The extension activates on this folder (package.json), and `init` does not create it.
    // A private repository keeps nothing of the tool's in the worktree.
    if (!privateSidecarDir(root)) mkdirSync(path.join(root, SIDECAR_ROOT), { recursive: true });
    this.setMessage(`Scanning ${path.basename(root)}…`);
    this.refresh();
    const output = await vscode.window.withProgress({ location: { viewId: REVIEW_VIEW } }, () => runCli(["scan", "--json"], root));
    const review = JSON.parse(output) as { comments: ReviewComment[] };
    this.model.load(review.comments, options);
    this.loaded = true;
  }

  /** Redraws the tree, its message, and the context keys behind the title buttons. */
  private refresh(): void {
    this.changed.fire();
    if (this.loaded) this.setMessage(reviewMessage(this.model));
    void vscode.commands.executeCommand("setContext", HAS_DECISIONS, this.model.decidedCount() > 0);
    void vscode.commands.executeCommand("setContext", HAS_COMMENTS, this.model.commentCount() > 0);
  }
}

/** The repository of the active editor's workspace folder, else of the first folder. */
/** The repository of the active editor's folder, else of the first folder. */
export async function scanRepo(): Promise<Repo | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri;
  const folder = (active && vscode.workspace.getWorkspaceFolder(active)) || vscode.workspace.workspaceFolders?.[0];
  return folder ? findRepo(folder.uri.fsPath) : undefined;
}

function fileItem(root: string, group: ReviewFile): vscode.TreeItem {
  const item = new vscode.TreeItem(group.file, vscode.TreeItemCollapsibleState.Expanded);
  item.resourceUri = vscode.Uri.file(path.join(root, group.file));
  const decided = group.comments.filter((c) => c.decision).length;
  const total = group.comments.length;
  item.description = decided ? `${decided} of ${total} decided` : `${total}`;
  item.contextValue = "file";
  return item;
}

function commentItem(root: string, comment: ReviewItem): vscode.TreeItem {
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
      vscode.Uri.file(path.join(root, comment.file)),
      { selection: new vscode.Range(comment.line - 1, 0, comment.endLine - 1, 0) } satisfies vscode.TextDocumentShowOptions,
    ],
  };
  return item;
}

function reviewMessage(model: ReviewModel): string {
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

async function chooseStorage(root: string): Promise<Storage | undefined> {
  const choice = await vscode.window.showInformationMessage(
    `Where should ${BRAND_TITLE} keep the comments in ${path.basename(root)}?`,
    {
      modal: true,
      detail:
        "On the Branch: the comment text is committed beside the code, so teammates and cloud agents get it by cloning.\n\n" +
        "Private: everything stays in the repository's .git folder and nothing of Cairn Comments reaches the branch. Share Comments sends them to the remote when you choose.",
    },
    "On the Branch",
    "Private",
  );
  if (choice === "On the Branch") return "branch";
  return choice === "Private" ? "private" : undefined;
}

async function confirmSetup(root: string, plan: string): Promise<boolean> {
  const choice = await vscode.window.showInformationMessage(
    `Set up ${BRAND_TITLE} in ${path.basename(root)}?`,
    { modal: true, detail: plan.trim() },
    "Set Up",
  );
  return choice === "Set Up";
}

/** A command that shows its string result, or its error, as a notification. */
export function guarded(fn: () => Promise<unknown>): () => Promise<void> {
  return async () => {
    try {
      const result = await fn();
      if (typeof result === "string" && result) void vscode.window.showInformationMessage(result.trim().replaceAll("\n", "; "));
    } catch (error) {
      void vscode.window.showErrorMessage(`${BRAND}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

/** A row button: the node it was clicked on names one comment, or a whole file. */
function onRow(act: (file: string, line: number | undefined) => void): (node: Node) => void {
  return (node) => act(node.group.file, node.kind === "comment" ? node.comment.line : undefined);
}
