/** The benchmark report: Markdown tables from every run's `result.json`. */
import { depthOf, type RunResult } from "./runner.ts";
import { bootstrapMedianChange, pairedDifferences, spreadOf } from "./stats.ts";
import type { Usage } from "./responses.ts";

interface Measure {
  label: string;
  value: (r: RunResult) => number;
  format: (n: number) => string;
}

const sumTokens = (t: Usage) => t.input + t.cacheRead + t.cacheWrite + t.output;
const whole = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const dollars = (n: number) => n.toFixed(3);
const seconds = (n: number) => (n / 1000).toFixed(0);
const percent = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;

const INPUT: Measure = {
  label: "Input tokens, all",
  value: (r) => r.metrics.tokens.input + r.metrics.tokens.cacheRead + r.metrics.tokens.cacheWrite,
  format: whole,
};
const COST: Measure = { label: "Cost ($)", value: (r) => r.harnessTotals?.costUsd ?? Number.NaN, format: dollars };
const WALL: Measure = { label: "Wall time (s)", value: (r) => r.wallMs, format: seconds };

const MEASURES: Measure[] = [
  INPUT,
  // How deep a run started: at depth `deep` the first call carries the whole warm-up.
  { label: "First-call context", value: (r) => r.metrics.firstCallInput ?? Number.NaN, format: whole },
  { label: "Uncached input", value: (r) => r.metrics.tokens.input, format: whole },
  { label: "Cache read", value: (r) => r.metrics.tokens.cacheRead, format: whole },
  { label: "Cache write", value: (r) => r.metrics.tokens.cacheWrite, format: whole },
  { label: "Output", value: (r) => r.metrics.tokens.output, format: whole },
  { label: "Turns", value: (r) => r.metrics.turns, format: whole },
  { label: "Tool calls", value: (r) => Object.values(r.metrics.toolCalls).reduce((a, b) => a + b, 0), format: whole },
  { label: "Files read", value: (r) => r.metrics.filesRead.length, format: whole },
  WALL,
  COST,
  { label: "Comment bytes read", value: (r) => r.commentBytesRead, format: whole },
];

/** The paired comparison: the arm without comments against the arm with them. */
const BASELINE = "none";
const TREATMENT = "comments";

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    groups.set(name, [...(groups.get(name) ?? []), item]);
  }
  return groups;
}

function successCount(runs: RunResult[]): string {
  return `${runs.filter((r) => r.grade.passed).length}/${runs.length}`;
}

function spreadCell(runs: RunResult[], measure: Measure): string {
  const spread = spreadOf(runs.map((r) => measure.value(r)).filter((n) => !Number.isNaN(n)));
  if (!spread) return "n/a";
  return `${measure.format(spread.median)} (${measure.format(spread.q1)} to ${measure.format(spread.q3)})`;
}

function armTable(runs: RunResult[], measures: Measure[]): string[] {
  const lines = [
    `| Arm | Success | ${measures.map((m) => m.label).join(" | ")} |`,
    `| --- | --- | ${measures.map(() => "---").join(" | ")} |`,
  ];
  for (const [arm, armRuns] of groupBy(runs, (r) => r.arm)) {
    lines.push(`| ${arm} | ${successCount(armRuns)} | ${measures.map((m) => spreadCell(armRuns, m)).join(" | ")} |`);
  }
  return lines;
}

/** Per task, each arm's values of `measure`. */
function valuesByTask(runs: RunResult[], measure: Measure): Map<string, Record<string, number[]>> {
  const byTask = new Map<string, Record<string, number[]>>();
  for (const [task, taskRuns] of groupBy(runs, (r) => r.task)) {
    const arms: Record<string, number[]> = {};
    for (const [arm, armRuns] of groupBy(taskRuns, (r) => r.arm)) arms[arm] = armRuns.map((r) => measure.value(r));
    byTask.set(task, arms);
  }
  return byTask;
}

const PAIRED: Measure[] = [INPUT, COST, WALL];

/** Fixed so the bootstrap intervals in a recorded report can be reproduced. */
const BOOTSTRAP = { iterations: 10_000, seed: 20261011 };

/** Whether any run has a cost; a local model's runs all report 0, which says nothing. */
function reportsCost(runs: RunResult[]): boolean {
  return runs.some((r) => (r.harnessTotals?.costUsd ?? 0) > 0);
}

function pairedTable(runs: RunResult[], paired: Measure[]): string[] {
  const pairs = paired.map((m) => new Map(pairedDifferences(valuesByTask(runs, m), BASELINE, TREATMENT).map((p) => [p.task, p])));
  const header = paired.flatMap((m) => [`${m.label}, ${BASELINE}`, TREATMENT, "change"]);
  const lines = [
    `| Task | Success, ${BASELINE} | ${TREATMENT} | ${header.join(" | ")} |`,
    `| --- | --- | --- | ${header.map(() => "---").join(" | ")} |`,
  ];
  for (const [task, taskRuns] of groupBy(runs, (r) => r.task)) {
    const cells = paired.flatMap((measure, i) => {
      const pair = pairs[i]!.get(task);
      if (!pair) return ["n/a", "n/a", "n/a"];
      return [measure.format(pair.baseline), measure.format(pair.treatment), percent(pair.relative)];
    });
    const arms = groupBy(taskRuns, (r) => r.arm);
    lines.push(
      `| ${task} | ${successCount(arms.get(BASELINE) ?? [])} | ${successCount(arms.get(TREATMENT) ?? [])} | ${cells.join(" | ")} |`,
    );
  }
  return lines;
}

function overallChange(runs: RunResult[], measure: Measure): string {
  const label = measure.label.toLowerCase();
  const byTask = valuesByTask(runs, measure);
  const pairs = pairedDifferences(byTask, BASELINE, TREATMENT);
  const median = spreadOf(pairs.map((p) => p.relative))?.median;
  if (median === undefined) return `${label}: n/a`;
  const interval = bootstrapMedianChange(byTask, BASELINE, TREATMENT, BOOTSTRAP);
  const lower = pairs.filter((p) => p.difference < 0).length;
  return (
    `${label} ${percent(median)} ` +
    `(95% interval ${percent(interval.low)} to ${percent(interval.high)}; lower on ${lower} of ${pairs.length} tasks)`
  );
}

/** The largest relative gap between the proxy's token total and the harness's own, over all runs. */
function proxyGap(runs: RunResult[]): string {
  const gaps = runs.flatMap((r) => {
    if (!r.harnessTotals) return [];
    const reported = sumTokens(r.harnessTotals.tokens);
    return reported ? [Math.abs(sumTokens(r.metrics.tokens) - reported) / reported] : [];
  });
  if (!gaps.length) return "no harness reported its own token totals";
  return `largest difference between proxy and harness token totals: ${(Math.max(...gaps) * 100).toFixed(1)}% over ${gaps.length} runs`;
}

/** The tables for one harness at one depth. */
function section(runs: RunResult[]): string[] {
  const models = [...new Set(runs.map((r) => r.model))].join(", ");
  const withCost = reportsCost(runs);
  const measures = withCost ? MEASURES : MEASURES.filter((m) => m !== COST);
  const paired = withCost ? PAIRED : PAIRED.filter((m) => m !== COST);
  const changes = paired.map((m) => overallChange(runs, m));
  return [
    `## ${runs[0]!.harness}, ${depthOf(runs[0]!)} (${models})`,
    "",
    "Median (interquartile range) per run.",
    "",
    ...armTable(runs, measures),
    "",
    `Per task, each arm's median and the ${TREATMENT} arm's change against ${BASELINE}:`,
    "",
    ...pairedTable(runs, paired),
    "",
    `Median per-task change: ${changes.join("; ")}.`,
    "",
    `Check: ${proxyGap(runs)}.`,
    "",
  ];
}

export function renderReport(results: RunResult[]): string {
  const sections = [...groupBy(results, (r) => `${r.harness} ${depthOf(r)}`).values()].flatMap((runs) => section(runs));
  return sections.join("\n");
}
