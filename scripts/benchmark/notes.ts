/**
 * The notes loop (docs/plans/benchmark-deep-context.md § D7). A writer does a task on the
 * stripped code; in the `notes` arm its AGENTS.md asks it to leave `#~` notes as it works, and
 * Cairn, in private mode, keeps them. Its code changes are thrown away. Each reader then does a
 * task on the same functions, fresh, from the same commit: in the `notes` arm with the writer's
 * notes placed by Cairn and the same AGENTS.md, in the `bare` arm with neither.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { HarnessName } from "./harnesses.ts";
import { contextOf } from "./metrics.ts";
import type { RunResult } from "./runner.ts";
import { bootstrapGeomeanRatio, geomean, type Interval } from "./stats.ts";
import { loadTaskFile, type Task, type TaskFile } from "./tasks.ts";
import { cairn, entriesBySource, freezeComments, neutralName, placedComments, type NotesCheckout } from "./workspace.ts";

export type NotesArm = "bare" | "notes";
export const NOTES_ARMS: NotesArm[] = ["bare", "notes"];

export type Role = "writer" | "reader";

/** One writer and the readers that take its notes. */
export interface Pair {
  writer: string;
  readers: string[];
}

export interface NotesSet {
  taskFile: TaskFile;
  pairs: Pair[];
  /** The text the `notes` arm puts at the top of AGENTS.md. */
  prepend: string;
}

/** What names a loop run apart from its task and repetition. */
export interface LoopLabel {
  role: Role;
  arm: NotesArm;
  /** The writer of the run's pair; a writer's own id. */
  writer: string;
}

export interface LoopSpec extends LoopLabel {
  runDir: string;
  checkout: NotesCheckout;
  /** A writer in the `notes` arm: where its notes are frozen once its session ends. */
  freezeTo?: string;
}

export interface LoopRecord extends LoopLabel {
  /** A reader in the `notes` arm: the writer's entries per file, and what Cairn placed of them. */
  given?: { entries: Record<string, number>; placed: Record<string, number>; stale: number };
  /** A writer in the `notes` arm: its entries per file after the last sync. */
  left?: Record<string, number>;
}

interface NotesSetJson {
  pairs?: Pair[];
  prepend?: string;
}

/**
 * A probe set (tasks.ts) with `pairs` and `prepend`, the prepend's file relative to the set's.
 * Every pair's writer and readers must be probes of the set, and a reader belongs to one pair.
 */
export function loadNotesSet(file: string): NotesSet {
  const taskFile = loadTaskFile(file);
  // The task file is the operator's own --tasks choice on a local benchmark script.
  const parsed = JSON.parse(readFileSync(file, "utf8")) as NotesSetJson; // NOSONAR
  if (!parsed.pairs?.length || !parsed.prepend) throw new Error(`${file} is not a notes set: it needs pairs and a prepend`);
  const ids = new Set(taskFile.tasks.map((task) => task.id));
  const seen = new Set<string>();
  for (const pair of parsed.pairs) {
    for (const id of [pair.writer, ...pair.readers]) {
      if (!ids.has(id)) throw new Error(`pair ${pair.writer}: no probe ${id} in ${file}`);
      if (seen.has(id)) throw new Error(`pair ${pair.writer}: ${id} is in more than one pair, or twice in this one`);
      seen.add(id);
    }
  }
  const prepend = readFileSync(path.resolve(path.dirname(file), parsed.prepend), "utf8");
  return { taskFile, pairs: parsed.pairs, prepend };
}

/** The AGENTS.md of an arm: the repository's agent notes, under the prepend in the `notes` arm. */
export function agentsMdFor(arm: NotesArm, agentNotes: string[], prepend: string): string {
  const own = agentNotes.map((line) => `${line}\n`).join("");
  if (arm === "bare") return own;
  return `${prepend.trimEnd()}\n\n${own}`;
}

/** One planned loop run. */
export interface LoopRun extends LoopLabel {
  task: Task;
  rep: number;
}

/**
 * Every loop run, repetition by repetition and pair by pair: the writer in the `notes` arm
 * first, since its readers need its notes, then the writer in the `bare` arm for the first
 * `bareWriterReps` repetitions (what writing notes costs), then each reader in both arms.
 * The readers' arm order alternates by repetition, so neither arm always runs first.
 */
export function planLoop(set: NotesSet, reps: number, bareWriterReps: number, roles: Role[] = ["writer", "reader"]): LoopRun[] {
  const task = (id: string) => set.taskFile.tasks.find((t) => t.id === id)!;
  const runs: LoopRun[] = [];
  for (let rep = 1; rep <= reps; rep++) {
    const readerArms: NotesArm[] = rep % 2 === 1 ? ["bare", "notes"] : ["notes", "bare"];
    for (const pair of set.pairs) {
      const writer = { task: task(pair.writer), role: "writer" as const, writer: pair.writer, rep };
      if (roles.includes("writer")) {
        runs.push({ ...writer, arm: "notes" });
        if (rep <= bareWriterReps) runs.push({ ...writer, arm: "bare" });
      }
      if (!roles.includes("reader")) continue;
      for (const reader of pair.readers) {
        for (const arm of readerArms) runs.push({ task: task(reader), role: "reader", arm, writer: pair.writer, rep });
      }
    }
  }
  return runs;
}

/** A loop run's directory; its name hides the arm (`neutralName`), which result.json records. */
export function loopRunDir(work: string, harness: HarnessName, run: LoopRun): string {
  return path.join(work, "loop", harness, run.task.id, neutralName("loop", run.arm, run.rep));
}

/** Where repetition `rep` of `writer` in the `notes` arm freezes its notes. */
export function notesDir(work: string, harness: HarnessName, writer: string, rep: number): string {
  return path.join(work, "notes", harness, `${writer}-${rep}`);
}

/** The label a run's result records. */
export function loopLabel(label: LoopLabel): LoopLabel {
  return { role: label.role, arm: label.arm, writer: label.writer };
}

/** For a reader given notes: the writer's entries per file, and what Cairn placed of them in `runDir`. */
export function notesGiven(spec: LoopSpec, runDir: string): LoopRecord["given"] {
  const sidecars = spec.checkout.cairn?.sidecars;
  if (!sidecars) return undefined;
  return { entries: entriesBySource(sidecars), ...placedComments(runDir) };
}

/** For a writer in the `notes` arm: records its notes with `sync`, freezes them, and counts them per file. */
export function freezeNotes(spec: LoopSpec, agentDir: string, runDir: string, env: Record<string, string>): Record<string, number> | undefined {
  if (!spec.freezeTo) return undefined;
  cairn(agentDir, env, "sync");
  freezeComments(runDir, spec.freezeTo);
  return entriesBySource(spec.freezeTo);
}

/** Whether a reader's notes exist yet: its writer's repetition has frozen them. */
export function notesReady(work: string, harness: HarnessName, run: LoopRun): boolean {
  return existsSync(notesDir(work, harness, run.writer, run.rep));
}

/** The tokens a fresh run spent on its own work: the context it added past its first call, plus its output. */
export function addedTokens(result: RunResult): number {
  return result.metrics.finalContext - result.metrics.firstCallContext + result.metrics.tokens.output;
}

interface LoopMeasure {
  label: string;
  value: (r: RunResult) => number;
}

const TOKENS: LoopMeasure = { label: "Tokens (added + output)", value: addedTokens };
const WALL: LoopMeasure = { label: "Wall (s)", value: (r) => r.wallMs / 1000 };

const MEASURES: LoopMeasure[] = [
  TOKENS,
  { label: "Input tokens, all", value: (r) => contextOf(r.metrics.tokens) },
  { label: "Output", value: (r) => r.metrics.tokens.output },
  WALL,
  { label: "Tool calls", value: (r) => Object.values(r.metrics.toolCalls).reduce((a, b) => a + b, 0) },
];

/** Fixed so the intervals in a recorded report can be reproduced. */
const BOOTSTRAP = { iterations: 10_000, seed: 20261024 };

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const whole = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const ratio = (n: number) => n.toFixed(2);

function byArm(runs: RunResult[]): Record<NotesArm, RunResult[]> {
  return { bare: runs.filter((r) => r.loop?.arm === "bare"), notes: runs.filter((r) => r.loop?.arm === "notes") };
}

function passed(runs: RunResult[]): string {
  return `${runs.filter((r) => r.grade.passed).length}/${runs.length}`;
}

function sumOf(record: Record<string, number> | undefined): number {
  return Object.values(record ?? {}).reduce((a, b) => a + b, 0);
}

/** Per task, each arm's values of `measure`, for tasks with runs in both arms. */
function valuesByTask(runs: RunResult[], measure: LoopMeasure): Map<string, Record<NotesArm, number[]>> {
  const tasks = new Map<string, Record<NotesArm, number[]>>();
  for (const task of new Set(runs.map((r) => r.task))) {
    const arms = byArm(runs.filter((r) => r.task === task));
    if (arms.bare.length && arms.notes.length) {
      tasks.set(task, { bare: arms.bare.map((r) => measure.value(r)), notes: arms.notes.map((r) => measure.value(r)) });
    }
  }
  return tasks;
}

/** The geometric mean over tasks of notes / bare, with its bootstrap interval. */
function overallRatio(runs: RunResult[], measure: LoopMeasure): { value: number; interval: Interval; tasks: number } | undefined {
  const byTask = valuesByTask(runs, measure);
  if (!byTask.size) return undefined;
  const value = geomean([...byTask.values()].map((arms) => mean(arms.notes) / mean(arms.bare)));
  return { value, interval: bootstrapGeomeanRatio(byTask, "bare", "notes", BOOTSTRAP), tasks: byTask.size };
}

/**
 * The decision rule fixed in D7: on the readers' tokens, the claim holds when the geometric mean
 * of notes / bare is below 0.80 and its interval ends below 1.0, and fails when the interval
 * starts above 0.80.
 */
export function verdict(value: number, interval: Interval): "holds" | "fails" | "inconclusive" {
  if (value < 0.8 && interval.high < 1) return "holds";
  if (interval.low > 0.8) return "fails";
  return "inconclusive";
}

function writerTable(writers: RunResult[]): string[] {
  const lines = [
    "| Writer | Passed, bare | notes | Tokens, bare | notes | Wall (s), bare | notes | Notes left (mean) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const task of new Set(writers.map((r) => r.task))) {
    const arms = byArm(writers.filter((r) => r.task === task));
    const cell = (runs: RunResult[], value: (r: RunResult) => number) => (runs.length ? whole(mean(runs.map(value))) : "n/a");
    const left = arms.notes.length ? mean(arms.notes.map((r) => sumOf(r.loop?.left))).toFixed(1) : "n/a";
    lines.push(
      `| ${task} | ${passed(arms.bare)} | ${passed(arms.notes)} | ${cell(arms.bare, addedTokens)} | ${cell(arms.notes, addedTokens)} | ` +
        `${cell(arms.bare, (r) => r.wallMs / 1000)} | ${cell(arms.notes, (r) => r.wallMs / 1000)} | ${left} |`,
    );
  }
  return lines;
}

function readerTable(readers: RunResult[]): string[] {
  const header = [TOKENS, WALL];
  const lines = [
    `| Reader | Writer | Passed, bare | notes | ${header.map((m) => `${m.label}, bare | notes | ratio`).join(" | ")} | Notes placed / given | stale |`,
    `| --- | --- | --- | --- | ${header.map(() => "--- | --- | ---").join(" | ")} | --- | --- |`,
  ];
  for (const task of new Set(readers.map((r) => r.task))) {
    const runs = readers.filter((r) => r.task === task);
    const arms = byArm(runs);
    const cells = header.flatMap((measure) => {
      if (!arms.bare.length || !arms.notes.length) return ["n/a", "n/a", "n/a"];
      const bare = mean(arms.bare.map((r) => measure.value(r)));
      const notes = mean(arms.notes.map((r) => measure.value(r)));
      return [whole(bare), whole(notes), ratio(notes / bare)];
    });
    const given = arms.notes.map((r) => r.loop?.given);
    const placed = given.map((g) => `${sumOf(g?.placed)}/${sumOf(g?.entries)}`).join(", ") || "n/a";
    const stale = given.map((g) => g?.stale ?? 0).join(", ") || "n/a";
    lines.push(`| ${task} | ${runs[0]!.loop!.writer} | ${passed(arms.bare)} | ${passed(arms.notes)} | ${cells.join(" | ")} | ${placed} | ${stale} |`);
  }
  return lines;
}

/** The whole loop per pair and repetition: writer plus readers, notes arm against bare. */
function loopCost(writers: RunResult[], readers: RunResult[]): string[] {
  const lines = ["| Pair | Writer + readers tokens, bare | notes | ratio |", "| --- | --- | --- | --- |"];
  for (const writer of new Set(writers.map((r) => r.task))) {
    const total = (arm: NotesArm) => {
      const own = writers.filter((r) => r.task === writer && r.loop?.arm === arm);
      const theirs = readers.filter((r) => r.loop?.writer === writer && r.loop?.arm === arm);
      if (!own.length) return Number.NaN;
      const tasks = new Set(theirs.map((r) => r.task));
      return mean(own.map(addedTokens)) + [...tasks].reduce((sum, t) => sum + mean(theirs.filter((r) => r.task === t).map(addedTokens)), 0);
    };
    const bare = total("bare");
    const notes = total("notes");
    const cell = (n: number) => (Number.isNaN(n) ? "n/a" : whole(n));
    lines.push(`| ${writer} | ${cell(bare)} | ${cell(notes)} | ${Number.isNaN(bare) || Number.isNaN(notes) ? "n/a" : ratio(notes / bare)} |`);
  }
  return lines;
}

export function renderLoopReport(results: RunResult[]): string {
  const loop = results.filter((r) => r.loop);
  const writers = loop.filter((r) => r.loop!.role === "writer");
  const readers = loop.filter((r) => r.loop!.role === "reader");
  const models = [...new Set(loop.map((r) => r.model))].join(", ");
  const overall = MEASURES.map((measure) => {
    const found = overallRatio(readers, measure);
    if (!found) return `- ${measure.label}: n/a`;
    const { value, interval, tasks } = found;
    return `- ${measure.label}: ${ratio(value)} (95% interval ${ratio(interval.low)} to ${ratio(interval.high)}, ${tasks} readers)`;
  });
  const tokens = overallRatio(readers, TOKENS);
  const decision = tokens ? `Decision rule on the readers' tokens: the claim **${verdict(tokens.value, tokens.interval)}**.` : "";
  const arms = byArm(readers);
  return [
    `# Notes loop (${models})`,
    "",
    `Readers passed: bare ${passed(arms.bare)}, notes ${passed(arms.notes)}.`,
    "",
    "Geometric mean over readers of notes / bare (mean per arm per reader):",
    "",
    ...overall,
    "",
    decision,
    "",
    "## Readers",
    "",
    ...readerTable(readers),
    "",
    "## Writers",
    "",
    ...writerTable(writers),
    "",
    "## The whole loop",
    "",
    ...loopCost(writers, readers),
    "",
  ].join("\n");
}
