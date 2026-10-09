import { describe, expect, it } from "vitest";
import { pairedDifferences, shuffled, spreadOf } from "../stats.ts";

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
