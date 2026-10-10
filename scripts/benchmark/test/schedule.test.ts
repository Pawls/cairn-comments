import { describe, expect, it } from "vitest";
import { planRuns, shard } from "../schedule.ts";
import type { Task } from "../tasks.ts";

const task = (id: string): Task => ({ id, repo: "r", kind: "question", start: "s", prompt: "p", answerKey: [] });

describe("planRuns", () => {
  it("plans every repetition of every task in every arm, in an order fixed by the seed", () => {
    const planned = planRuns([task("a"), task("b")], ["none", "comments"], 3, 1);

    expect(planned).toHaveLength(12);
    const keys = planned.map((p) => `${p.task.id}/${p.arm}/${p.rep}`);
    expect(new Set(keys).size).toBe(12);
    expect(planRuns([task("a"), task("b")], ["none", "comments"], 3, 1)).toEqual(planned);
    expect(planRuns([task("a"), task("b")], ["none", "comments"], 3, 2)).not.toEqual(planned);
  });
});

describe("shard", () => {
  it("splits a queue into disjoint slices that together cover it, keeping its order", () => {
    const queue = [0, 1, 2, 3, 4, 5, 6];

    expect(shard(queue, "1/3")).toEqual([0, 3, 6]);
    expect(shard(queue, "2/3")).toEqual([1, 4]);
    expect(shard(queue, "3/3")).toEqual([2, 5]);
  });

  it("takes the whole queue without a shard", () => {
    expect(shard([1, 2], undefined)).toEqual([1, 2]);
  });

  it("rejects a shard outside 1..n", () => {
    expect(() => shard([1], "0/2")).toThrow(/--shard/);
    expect(() => shard([1], "3/2")).toThrow(/--shard/);
    expect(() => shard([1], "x")).toThrow(/--shard/);
  });
});
