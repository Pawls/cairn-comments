// Where an open document's comments live: its sidecar's path, and the sidecar's contents.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import {
  SIDECAR_ROOT,
  findMarkers,
  languageForPath,
  parseSidecar,
  sidecarPathFor,
  type Marker,
  type Sidecar,
  type SidecarEntry,
} from "@cairn-comments/core";
import type { Located } from "./actions.js";
import { findSidecarRoot } from "./overlay.js";

/**
 * Sidecar contents keyed by absolute path. An open document wins over the disk copy so
 * edits show in the overlay as they are typed; disk reads are cached until the watcher
 * reports a change.
 */
export class SidecarStore {
  private readonly disk = new Map<string, Sidecar | undefined>();

  invalidate(file?: string): void {
    if (file) this.disk.delete(file);
    else this.disk.clear();
  }

  get(file: string): Sidecar | undefined {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.fileName === file);
    if (open) return parseSidecar(open.getText());
    if (!this.disk.has(file)) this.disk.set(file, existsSync(file) ? parseSidecar(readFileSync(file, "utf8")) : undefined);
    return this.disk.get(file);
  }

  entries(file: string): Map<string, SidecarEntry> {
    return new Map((this.get(file)?.entries ?? []).map((e) => [e.id, e]));
  }
}

export function locate(document: vscode.TextDocument): Located | undefined {
  if (document.uri.scheme !== "file" || !languageForPath(document.fileName)) return undefined;
  const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? path.dirname(document.fileName);
  const root = findSidecarRoot(path.dirname(document.fileName), folder);
  const file = path.relative(root, document.fileName).split(path.sep).join("/");
  return { root, file, sidecar: path.join(root, sidecarPathFor(file)) };
}

export function isSidecar(document: vscode.TextDocument): boolean {
  return document.uri.scheme === "file" && document.fileName.split(path.sep).join("/").includes(`/${SIDECAR_ROOT}/`);
}

/** The sigil comments a document shows inline: an agent worktree's, or a file after `expand`. */
export function markersIn(document: vscode.TextDocument, located: Located): Promise<Marker[]> {
  return findMarkers(languageForPath(located.file)!, document.getText());
}
