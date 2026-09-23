import { readdirSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { DETECTORS, analyzeSource, type ScannedComment } from "../src/index.js";

// Labeled corpus (design.md § Scan detectors): each detector's precision decides whether it ships enabled.
const CORPUS = new URL("./corpus/", import.meta.url);
const EXTENSION: Record<string, string> = { python: "py", typescript: "ts", tsx: "tsx", javascript: "js", csharp: "cs", java: "java" };
// Detectors need a few hits before their precision means anything.
const MIN_HITS = 3;
const KILL_PRECISION = 0.8;

interface Case {
  where: string;
  path: string;
  label: "ai" | "human" | "protected";
  protectedClass: string | undefined;
  source: string;
}

function loadCorpus(): Case[] {
  const cases: Case[] = [];
  for (const name of readdirSync(CORPUS).filter((f) => f.endsWith(".txt"))) {
    const language = name.replace(/\.txt$/, "");
    const lines = readFileSync(new URL(name, CORPUS), "utf8").replaceAll("\r\n", "\n").split("\n");
    let current: Case | undefined;
    lines.forEach((line, i) => {
      const header = /^=== (ai|human|protected)(?: (\S+))?$/.exec(line);
      if (header) {
        current = {
          where: `${name}:${i + 1}`,
          path: `corpus.${EXTENSION[language]}`,
          label: header[1] as Case["label"],
          protectedClass: header[2],
          source: "",
        };
        cases.push(current);
      } else if (current) current.source += line + "\n";
    });
  }
  return cases;
}

interface Tally {
  tp: number;
  fp: number;
}

describe("scan corpus", () => {
  const cases = loadCorpus();
  const results = new Map<Case, ScannedComment[]>();
  const tallies = new Map(DETECTORS.map((d) => [d.name, { tp: 0, fp: 0 } as Tally]));
  const precision = (t: Tally) => (t.tp + t.fp ? t.tp / (t.tp + t.fp) : 0);

  beforeAll(async () => {
    for (const c of cases) results.set(c, await analyzeSource(c.path, c.source, { detectors: DETECTORS }));
    for (const [c, comments] of results) {
      if (c.label === "protected") continue;
      for (const f of comments.flatMap((x) => x.findings)) tallies.get(f.detector)![c.label === "ai" ? "tp" : "fp"]++;
    }
    const ai = cases.filter((c) => c.label === "ai");
    const found = (enabledOnly: boolean) =>
      ai.filter((c) =>
        results.get(c)!.some((x) => x.findings.some((f) => !enabledOnly || DETECTORS.find((d) => d.name === f.detector)!.enabled)),
      ).length;
    const rows = DETECTORS.map((d) => {
      const t = tallies.get(d.name)!;
      return `  ${d.name.padEnd(15)} ${String(t.tp).padStart(3)} TP ${String(t.fp).padStart(3)} FP  precision ${precision(t).toFixed(2)}  ${d.enabled ? "enabled" : "disabled"}`;
    });
    const counts = (["ai", "human", "protected"] as const).map((l) => `${cases.filter((c) => c.label === l).length} ${l}`);
    console.log(
      [`scan corpus: ${counts.join(", ")}`, ...rows, `  recall: ${found(true)}/${ai.length} enabled, ${found(false)}/${ai.length} all`].join("\n"),
    );
  });

  it("has one comment group per case, and only protected cases are protected", () => {
    for (const [c, comments] of results) {
      expect(comments.length, c.where).toBe(1);
      expect(comments[0]!.protected, c.where).toBe(c.label === "protected" ? c.protectedClass : undefined);
    }
  });

  it("never reports a finding on a protected comment", () => {
    for (const [c, comments] of results) if (c.label === "protected") expect(comments[0]!.findings, c.where).toEqual([]);
  });

  it.each(DETECTORS.map((d) => [d.name, d] as const))("%s: enabled exactly when precision clears the kill criterion", (_, d) => {
    const t = tallies.get(d.name)!;
    const clears = t.tp + t.fp >= MIN_HITS && precision(t) >= KILL_PRECISION;
    expect(d.enabled, `${d.name}: ${t.tp} TP, ${t.fp} FP`).toBe(clears);
  });

  it.each(DETECTORS.map((d) => [d.name, d] as const))("%s: score is the measured precision", (_, d) => {
    expect(d.score).toBeCloseTo(precision(tallies.get(d.name)!), 2);
  });
});
