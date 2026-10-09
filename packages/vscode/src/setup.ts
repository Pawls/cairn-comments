import { existsSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { BRAND, BRAND_TITLE, cliHome, installCli } from "@cairn-comments/core";
import { findRepo, recordedScript, runCli, type Repo } from "./review.js";
import { initArgs, type Storage } from "./storage.js";

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
 * Runs `init` through the home's CLI, whose launcher is what it records. Without `storage`,
 * `init` keeps the mode the repository has, as repair needs.
 */
export function runInit(root: string, dryRun: boolean, storage?: Storage): Promise<string> {
  const args = storage ? initArgs(storage) : ["init"];
  return runCli(dryRun ? [...args, "--dry-run"] : args, root);
}

/** The recorded launcher or script when it no longer exists, so every commit in `repo` fails its hook. */
export function missingCli(repo: Repo): string | undefined {
  const script = repo.cli && recordedScript(repo.cli);
  return script && !existsSync(script) ? script : undefined;
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
