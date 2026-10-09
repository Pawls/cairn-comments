// Private mode from the extension (design.md § Private mode): the menus that follow a
// repository's mode, the watcher on its store, and the commands that move the comments into
// the git dir and share them through their own ref, so no one needs the CLI for it.
import path from "node:path";
import * as vscode from "vscode";
import { BRAND, BRAND_TITLE, privateSidecarDir } from "@cairn-comments/core";
import { runCli, type Repo } from "./review.js";
import { guarded, scanRepo } from "./reviewTree.js";

export const PRIVATE_COMMANDS = {
  makePrivate: `${BRAND}.makePrivate`,
  share: `${BRAND}.shareComments`,
  getShared: `${BRAND}.getSharedComments`,
} as const;

/** Context key behind the menus in package.json: the repository keeps its comments private. */
const PRIVATE_CONTEXT = `${BRAND}.private`;

/** What the e2e tests drive in place of the menus. */
export interface PrivateModeApi {
  /** Runs `init --private --migrate` once `confirm` accepts its dry run; resolves to the report, or "" when declined. */
  makePrivate(confirm?: (root: string, plan: string) => Promise<boolean>): Promise<string>;
  /** `push`: commits the store to its ref and pushes it to origin. */
  share(): Promise<string>;
  /** `fetch`: brings origin's comments into the store. */
  getShared(): Promise<string>;
}

/** Keeps the menus and the store watchers in line with each repository's mode. */
export class PrivateMode implements vscode.Disposable {
  private readonly watched = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];

  /** `watchStore` makes the watchers for a private store, which sits outside the workspace glob. */
  constructor(private readonly watchStore: (store: string) => vscode.Disposable[]) {}

  /** Sets the menus for the repository at `root` and watches its store, once, when it is private. */
  update(root: string | undefined): void {
    const store = root ? privateSidecarDir(root) : undefined;
    void vscode.commands.executeCommand("setContext", PRIVATE_CONTEXT, store !== undefined);
    if (!store || this.watched.has(store)) return;
    this.watched.add(store);
    this.disposables.push(...this.watchStore(store));
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }
}

/** The repository the commands act on, which must be set up already. */
async function setUpRepo(): Promise<Repo> {
  const repo = await scanRepo();
  if (!repo?.cli) throw new Error(`set up ${BRAND_TITLE} in this repository first`);
  return repo;
}

async function confirmMakePrivate(root: string, plan: string): Promise<boolean> {
  const choice = await vscode.window.showInformationMessage(
    `Make the comments in ${path.basename(root)} private?`,
    {
      modal: true,
      detail: `${plan.trim()}\n\nThe comments move into the repository's .git folder. Their removal from the branch is staged for you to commit.`,
    },
    "Make Private",
  );
  return choice === "Make Private";
}

export function registerPrivateMode(mode: PrivateMode): { api: PrivateModeApi; disposables: vscode.Disposable[] } {
  const api: PrivateModeApi = {
    async makePrivate(confirm = confirmMakePrivate) {
      const repo = await setUpRepo();
      if (privateSidecarDir(repo.root)) return `${path.basename(repo.root)} already keeps its comments private`;
      const args = ["init", "--private", "--migrate"];
      if (!(await confirm(repo.root, await runCli([...args, "--dry-run"], repo.root)))) return "";
      const report = await runCli(args, repo.root);
      mode.update(repo.root);
      return `${report}Commit the staged changes to take the comments off the branch.`;
    },
    async share() {
      const repo = await setUpRepo();
      return runCli(["push"], repo.root);
    },
    async getShared() {
      const repo = await setUpRepo();
      const report = await runCli(["fetch"], repo.root);
      mode.update(repo.root);
      return report;
    },
  };
  const disposables = [
    vscode.commands.registerCommand(PRIVATE_COMMANDS.makePrivate, guarded(() => api.makePrivate())),
    vscode.commands.registerCommand(PRIVATE_COMMANDS.share, guarded(() => api.share())),
    vscode.commands.registerCommand(PRIVATE_COMMANDS.getShared, guarded(() => api.getShared())),
  ];
  return { api, disposables };
}
