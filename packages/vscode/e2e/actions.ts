import * as vscode from "vscode";

/** The code actions from this extension on `line` of `uri`. */
export async function cairnActions(uri: vscode.Uri, line: number): Promise<vscode.CodeAction[]> {
  const found = await vscode.commands.executeCommand<vscode.CodeAction[]>(
    "vscode.executeCodeActionProvider",
    uri,
    new vscode.Range(line, 0, line, 0),
  );
  return found.filter((action) => action.command?.command.startsWith("cairn."));
}
