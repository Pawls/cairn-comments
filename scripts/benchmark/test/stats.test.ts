import { describe, expect, it } from "vitest";
import { bootstrapMedianChange, pairedDifferences, shuffled, spreadOf } from "../stats.ts";

describe("spreadOf", () => {
  it("gives the median and the interpolated quartiles", () => {
    expect(spreadOf([4, 1, 3, 2, 5])).toEqual({ n: 5, median: 3, q1: 2, q3: 4 });
    expect(spreadOf([1, 2, 3, 4])).toEqual({ n: 4, median: 2.5, q1: 1.75, q3: 3.25 });
  });

  it("returns undefined for no values", () => {
    expect(spreadOf([])).toBeUndefined();
  });
});

describe("pairedDifferences", () => {
  it("compares the arms' medians task by task", () => {
    const byTask = new Map([
      ["a", { none: [100, 120, 110], comments: [90, 80, 85] }],
      ["b", { none: [10, 10], comments: [15, 15] }],
    ]);

    expect(pairedDifferences(byTask, "none", "comments")).toEqual([
      { task: "a", baseline: 110, treatment: 85, difference: -25, relative: -25 / 110 },
      { task: "b", baseline: 10, treatment: 15, difference: 5, relative: 0.5 },
    ]);
  });

  it("skips a task that lacks runs in either arm", () => {
    const byTask = new Map([["a", { none: [1], comments: [] }]]);

    expect(pairedDifferences(byTask, "none", "comments")).toEqual([]);
  });
});

describe("bootstrapMedianChange", () => {
  const byTask = new Map([
    ["a", { none: [100, 120, 110, 90, 130], comments: [90, 80, 85, 120, 70] }],
    ["b", { none: [10, 12, 9, 11, 10], comments: [15, 14, 16, 9, 13] }],
    ["c", { none: [50, 55, 60, 45, 52], comments: [48, 70, 51, 49, 66] }],
  ]);

  it("brackets the median per-task change and repeats under the same seed", () => {
    const point = spreadOf(pairedDifferences(byTask, "none", "comments").map((p) => p.relative))!.median;
    const interval = bootstrapMedianChange(byTask, "none", "comments", { iterations: 2000, seed: 1 });

    expect(interval.low).toBeLessThan(point);
    expect(interval.high).toBeGreaterThan(point);
    expect(bootstrapMedianChange(byTask, "none", "comments", { iterations: 2000, seed: 1 })).toEqual(interval);
  });

  it("collapses to the point estimate when every run of an arm is the same", () => {
    const constant = new Map([
      ["a", { none: [100, 100, 100], comments: [80, 80, 80] }],
      ["b", { none: [10, 10], comments: [15, 15] }],
    ]);

    expect(bootstrapMedianChange(constant, "none", "comments", { iterations: 200, seed: 1 })).toEqual({
      low: 0.15,
      high: 0.15,
    });
  });
});

describe("shuffled", () => {
  it("is a permutation fixed by the seed", () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const once = shuffled(items, 7);

    expect(shuffled(items, 7)).toEqual(once);
    expect(shuffled(items, 8)).not.toEqual(once);
    expect([...once].sort((a, b) => a - b)).toEqual(items);
    expect(items[0]).toBe(0);
  });
});
