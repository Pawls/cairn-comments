/** The benchmark report: Markdown tables from every run's `result.json`. */
import type { RunResult } from "./runner.ts";
import { pairedDifferences, spreadOf, type PairedDifference } from "./stats.ts";
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

function armTable(runs: RunResult[]): string[] {
  const lines = [
    `| Arm | Success | ${MEASURES.map((m) => m.label).join(" | ")} |`,
    `| --- | --- | ${MEASURES.map(() => "---").join(" | ")} |`,
  ];
  for (const [arm, armRuns] of groupBy(runs, (r) => r.arm)) {
    lines.push(`| ${arm} | ${successCount(armRuns)} | ${MEASURES.map((m) => spreadCell(armRuns, m)).join(" | ")} |`);
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

function pairedTable(runs: RunResult[]): string[] {
  const pairs = PAIRED.map((m) => new Map(pairedDifferences(valuesByTask(runs, m), BASELINE, TREATMENT).map((p) => [p.task, p])));
  const header = PAIRED.flatMap((m) => [`${m.label}, ${BASELINE}`, TREATMENT, "change"]);
  const lines = [
    `| Task | Success, ${BASELINE} | ${TREATMENT} | ${header.join(" | ")} |`,
    `| --- | --- | --- | ${header.map(() => "---").join(" | ")} |`,
  ];
  for (const [task, taskRuns] of groupBy(runs, (r) => r.task)) {
    const cells = PAIRED.flatMap((measure, i) => {
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

function overallChange(label: string, pairs: PairedDifference[]): string {
  const median = spreadOf(pairs.map((p) => p.relative))?.median;
  if (median === undefined) return `${label}: n/a`;
  const lower = pairs.filter((p) => p.difference < 0).length;
  return `${label} ${percent(median)} (lower on ${lower} of ${pairs.length} tasks)`;
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

function harnessSection(runs: RunResult[]): string[] {
  const models = [...new Set(runs.map((r) => r.model))].join(", ");
  const changes = PAIRED.map((m) =>
    overallChange(m.label.toLowerCase(), pairedDifferences(valuesByTask(runs, m), BASELINE, TREATMENT)),
  );
  return [
    `## ${runs[0]!.harness} (${models})`,
    "",
    "Median (interquartile range) per run.",
    "",
    ...armTable(runs),
    "",
    `Per task, each arm's median and the ${TREATMENT} arm's change against ${BASELINE}:`,
    "",
    ...pairedTable(runs),
    "",
    `Median per-task change: ${changes.join("; ")}.`,
    "",
    `Check: ${proxyGap(runs)}.`,
    "",
  ];
}

export function renderReport(results: RunResult[]): string {
  const sections = [...groupBy(results, (r) => r.harness).values()].flatMap((runs) => harnessSection(runs));
  return sections.join("\n");
}
