/* global require, exports */
/* eslint-disable @typescript-eslint/no-require-imports -- VS Code loads this file as CommonJS */
// A stand-in for Pylance's paste provider: it marks every copy with its own MIME type and
// offers a plain paste of the clipboard text. It activates after Cairn Comments
// (`extensionDependencies`), so its provider is the newer registration, which VS Code asks
// first and whose edit it applies unless `editor.pasteAs.preferences` names another kind.
const vscode = require("vscode");

const MIME = "application/vnd.paste-competitor";

exports.activate = (context) => {
  const provider = {
    prepareDocumentPaste(_document, _ranges, dataTransfer) {
      dataTransfer.set(MIME, new vscode.DataTransferItem("copied"));
    },
    async provideDocumentPasteEdits(_document, _ranges, dataTransfer) {
      const text = await dataTransfer.get("text/plain")?.asString();
      return text === undefined ? undefined : [new vscode.DocumentPasteEdit(text, "Paste", vscode.DocumentDropOrPasteEditKind.Text)];
    },
  };
  context.subscriptions.push(
    vscode.languages.registerDocumentPasteEditProvider({ language: "python" }, provider, {
      providedPasteEditKinds: [vscode.DocumentDropOrPasteEditKind.Text],
      copyMimeTypes: [MIME],
      pasteMimeTypes: [MIME],
    }),
  );
};
