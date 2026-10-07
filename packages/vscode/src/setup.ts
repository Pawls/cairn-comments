import { existsSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { BRAND, BRAND_TITLE, cliHome, homeCommand, installCli } from "@cairn-comments/core";
import { requireNode } from "./node.js";
import { findRepo, recordedMain, runCli, type Repo } from "./review.js";

/**
 * Installs the CLI bundled in the extension into the CLI home, unless the home has the same
 * or a newer one (design.md § Packaging). Every repository `init` set up records the home's
 * copy, so updating the extension never breaks them.
 */
export function installBundledCli(context: vscode.ExtensionContext): void {
  try {
    installCli(path.join(context.extensionPath, "dist"), cliHome());
  } catch (error) {
    void vscode.window.showWarningMessage(`${BRAND}: could not install the CLI into ${cliHome()}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Runs `init` through the home's CLI, which is also what it records. Throws before running
 * anything when no `node` on PATH can run that recorded command.
 */
export async function runInit(root: string, dryRun: boolean): Promise<string> {
  await requireNode();
  return runCli(homeCommand(cliHome()), dryRun ? "init --dry-run" : "init", root);
}

/** The recorded CLI script when it no longer exists, so every commit in `repo` fails its hook. */
export function missingCli(repo: Repo): string | undefined {
  const main = repo.cli && recordedMain(repo.cli);
  return main && !existsSync(main) ? main : undefined;
}

async function askRepair(root: string, missing: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `${BRAND_TITLE}: ${path.basename(root)} runs its git filter from ${missing}, which no longer exists, so commits fail. Repair it?`,
    "Repair",
  );
  return choice === "Repair";
}

/**
 * Offers to point a repository whose recorded CLI is gone at the home's copy, and runs
 * `init` when `ask` accepts; `init` rewrites the filter, the hooks, and any agent hooks.
 * Resolves to whether it repaired.
 */
export async function offerRepair(folder: string, ask = askRepair): Promise<boolean> {
  const repo = await findRepo(folder);
  const missing = repo && missingCli(repo);
  if (!repo || !missing || !(await ask(repo.root, missing))) return false;
  try {
    await runInit(repo.root, false);
    void vscode.window.showInformationMessage(`${BRAND_TITLE}: repaired ${path.basename(repo.root)}.`);
    return true;
  } catch (error) {
    void vscode.window.showErrorMessage(`${BRAND}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
