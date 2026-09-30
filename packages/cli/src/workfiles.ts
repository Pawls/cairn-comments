// Where rewrites of working files go: the disk, or under `--print` an overlay that later
// reads see and that is printed instead of written, so the VS Code extension can apply the
// whole rewrite as one edit the owner can undo (design.md § Promote and demote).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Absolute path to new contents; null for a file the rewrite deletes. */
let overlay: Map<string, string | null> | undefined;

/** From now on, writes land in the overlay instead of on disk. */
export function captureWrites(): void {
  overlay = new Map();
}

export function capturing(): boolean {
  return overlay !== undefined;
}

/** What the rewrite would write, by forward-slash path relative to `root`. */
export function capturedWrites(root: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [file, text] of overlay ?? []) out[path.relative(root, file).split(path.sep).join("/")] = text;
  return out;
}

/** The file's bytes, or undefined when it does not exist. */
export function readWorkFile(file: string): Buffer | undefined {
  const pending = overlay?.get(file);
  if (pending !== undefined) return pending === null ? undefined : Buffer.from(pending, "utf8");
  return existsSync(file) ? readFileSync(file) : undefined;
}

export function writeWorkFile(file: string, text: string): void {
  if (overlay) {
    overlay.set(file, text);
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

export function removeWorkFile(file: string): void {
  if (overlay) overlay.set(file, null);
  else rmSync(file, { force: true });
}
