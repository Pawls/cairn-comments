/**
 * Gate GN of the notes loop (docs/plans/benchmark-deep-context.md § D7), with no model: for each
 * writer repetition that has frozen notes, a reader's checkout is made with them placed, and the
 * notes Cairn placed are counted per file against the readers' modules.
 *
 *   node scripts/benchmark/notes-gate.ts --work <dir> --tasks <notes set> [--rep 1] [--harness claude] [--carry]
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { HarnessName } from "./harnesses.ts";
import { carriedId, loadNotesSet, notesDir, taskOf } from "./notes.ts";
import { readPrepared } from "./prepare.ts";
import { DEEP_PREPARED_ID, preparedEntries, type Probe } from "./tasks.ts";
import { checkoutArm, entriesBySource, ensureMirror, isolatedEnv, placedComments } from "./workspace.ts";

const { values: args } = parseArgs({
  options: {
    work: { type: "string" },
    tasks: { type: "string" },
    rep: { type: "string", default: "1" },
    carry: { type: "boolean", default: false },
    harness: { type: "string", default: "claude" },
  },
});
if (!args.work || !args.tasks) throw new Error("--work and --tasks are required");
const work = path.resolve(args.work);
const set = loadNotesSet(args.tasks);
const repo = set.taskFile.tasks[0]!.repo;
const spec = set.taskFile.repos[repo]!;
const env = isolatedEnv(path.join(work, "state"), path.join(work, "cli-home"));
const mirror = ensureMirror(work, repo, spec, env, []);
const prepared = readPrepared(path.join(work, "prepared", `${repo}.json`), repo, preparedEntries(set.taskFile.tasks), spec.agentNotes ?? [])[
  DEEP_PREPARED_ID
]!;

let passing = 0;
for (const pair of set.pairs) {
  const sidecars = notesDir(work, args.harness as HarnessName, pair.writer, Number(args.rep));
  if (!existsSync(sidecars)) {
    console.log(`${pair.writer}: no frozen notes for repetition ${args.rep}`);
    continue;
  }
  const runDir = mkdtempSync(path.join(work, "gate-"));
  try {
    // With --carry the readers start from the writer's committed work, so the notes are placed there.
    const from = args.carry ? { ...prepared, taskId: carriedId(args.harness as HarnessName, pair.writer, Number(args.rep)) } : prepared;
    const notes = { agentsMd: "", cairn: { sidecars, hooks: [] } };
    checkoutArm({ mirror, runDir, start: prepared.start, arm: "none", hooks: [], env, prepared: from, notes });
    const { placed, stale } = placedComments(runDir);
    const modules = new Set(pair.readers.flatMap((id) => (taskOf(set, id) as Probe).modules));
    const inModules = Object.entries(placed).filter(([file]) => modules.has(file));
    const entries = entriesBySource(sidecars);
    if (inModules.length) passing++;
    console.log(
      `${pair.writer}: ${JSON.stringify(entries)} written; placed ${JSON.stringify(placed)} (${stale} stale); ` +
        `in the readers' modules: ${inModules.map(([file, n]) => `${file} ${n}`).join(", ") || "none"}`,
    );
  } finally {
    rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}
console.log(`GN: ${passing} of ${set.pairs.length} pairs have a placed note in a reader's module`);
