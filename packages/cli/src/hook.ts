import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { FILTER_DRIVER } from "@slopstash/core";
import { adapterFor } from "./adapters.js";
import { changedFiles, gitQuiet, toRepoPath } from "./git.js";
import { tag, type TagReport } from "./tag.js";

/** The repository holding `dir`, when `init` has configured the filter there. */
function managedRoot(dir: string): string | undefined {
  const top = gitQuiet(["rev-parse", "--show-toplevel"], dir)?.trim();
  if (!top || !gitQuiet(["config", "--get", `filter.${FILTER_DRIVER}.clean`], top)?.trim()) return undefined;
  return realpathSync.native(top);
}

/**
 * Runs one harness hook call: tags the edited files in each repository they belong to.
 * An edit outside a repository, or in one without `init`, is not an error: the hook may
 * be installed user-wide, so it stays silent there.
 */
export async function runHook(harness: string, payloadText: string): Promise<TagReport[]> {
  const adapter = adapterFor(harness);
  const event = adapter.parse(JSON.parse(payloadText) as Record<string, unknown>);
  const byRoot = new Map<string, string[]>();
  if (!event.files.length) {
    const root = managedRoot(event.cwd);
    if (root) byRoot.set(root, changedFiles(root));
  }
  for (const file of event.files) {
    const absolute = path.resolve(event.cwd, file);
    if (!existsSync(absolute)) continue;
    const root = managedRoot(path.dirname(absolute));
    if (!root) continue;
    byRoot.set(root, [...(byRoot.get(root) ?? []), toRepoPath(root, absolute)]);
  }
  const reports: TagReport[] = [];
  for (const [root, files] of byRoot) reports.push(await tag(root, files, event.provenance));
  return reports;
}
