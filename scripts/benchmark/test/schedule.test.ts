import { describe, expect, it } from "vitest";
import { nextOccurrence, planRuns, shard, unforked, warmupOf, type Planned } from "../schedule.ts";
import type { Task, WarmupChain } from "../tasks.ts";

const task = (id: string, start = "s"): Task => ({ id, repo: "r", kind: "question", start, prompt: "p", answerKey: [] });
const chain = (id: string, start = "s"): WarmupChain => ({ id, repo: "r", start, prompts: ["warm up"] });
const [w1, w2] = [chain("w1"), chain("w2")];

describe("planRuns", () => {
  it("plans every repetition of every task in every arm, in an order fixed by the seed", () => {
    const planned = planRuns([task("a"), task("b")], ["none", "comments"], 3, 1);

    expect(planned).toHaveLength(12);
    const keys = planned.map((p) => `${p.task.id}/${p.arm}/${p.rep}`);
    expect(new Set(keys).size).toBe(12);
    expect(planRuns([task("a"), task("b")], ["none", "comments"], 3, 1)).toEqual(planned);
    expect(planRuns([task("a"), task("b")], ["none", "comments"], 3, 2)).not.toEqual(planned);
  });

  it("plans fresh runs only, with no chain, unless told otherwise", () => {
    const planned = planRuns([task("a")], ["none"], 2, 1);

    expect(planned.map((p) => p.chain)).toEqual([undefined, undefined]);
  });

  it("plans a deep run per chain beside the fresh ones when given both depths", () => {
    const planned = planRuns([task("a"), task("b")], ["none", "comments"], 2, 1, { fresh: true, chains: [w1, w2] });

    expect(planned).toHaveLength(2 * 2 * 3 * 2);
    expect(planned.filter((p) => p.chain === undefined)).toHaveLength(8);
    expect(planned.filter((p) => p.chain === w1)).toHaveLength(8);
    expect(planned.filter((p) => p.chain === w2)).toHaveLength(8);
  });

  it("plans deep runs alone without fresh ones", () => {
    const planned = planRuns([task("a")], ["none"], 1, 1, { fresh: false, chains: [w1] });

    expect(planned).toEqual([{ task: task("a"), arm: "none", rep: 1, chain: w1 }]);
  });

  it("forks a chain only for a task that starts where the chain does", () => {
    const elsewhere = { ...chain("w3", "t"), repo: "r" };
    const otherRepo = { ...chain("w4"), repo: "q" };

    const planned = planRuns([task("a"), task("b", "t")], ["none"], 1, 1, { fresh: false, chains: [w1, elsewhere, otherRepo] });

    expect(planned.map((p) => `${p.task.id}/${p.chain?.id}`).sort()).toEqual(["a/w1", "b/w3"]);
  });
});

describe("unforked", () => {
  it("names the tasks no chain starts where they do, so a batch can say it planned them no deep run", () => {
    const tasks = [task("a"), task("b", "t"), { ...task("c"), repo: "q" }];

    expect(unforked(tasks, [w1]).map((t) => t.id)).toEqual(["b", "c"]);
    expect(unforked(tasks, [])).toEqual(tasks);
  });
});

describe("nextOccurrence", () => {
  it("is later today when the time has not come yet", () => {
    const now = new Date(2026, 9, 9, 22, 15);

    expect(nextOccurrence("23:30", now)).toEqual(new Date(2026, 9, 9, 23, 30));
  });

  it("is tomorrow when the time has passed today, so a night batch can stop in the morning", () => {
    const now = new Date(2026, 9, 9, 22, 15);

    expect(nextOccurrence("06:30", now)).toEqual(new Date(2026, 9, 10, 6, 30));
  });

  it("rejects anything but HH:MM", () => {
    expect(() => nextOccurrence("6.30", new Date())).toThrow(/--stop-at/);
    expect(() => nextOccurrence("25:00", new Date())).toThrow(/--stop-at/);
  });
});

describe("shard", () => {
  it("splits a queue into disjoint slices that together cover it, keeping its order", () => {
    const queue = [0, 1, 2, 3, 4, 5, 6];

    expect(shard(queue, "1/3")).toEqual([0, 3, 6]);
    expect(shard(queue, "2/3")).toEqual([1, 4]);
    expect(shard(queue, "3/3")).toEqual([2, 5]);
  });

  it("keeps every run of one warm-up in one slice, since they share its checkout", () => {
    const run = (id: string, forks?: WarmupChain, arm: Planned["arm"] = "none"): Planned => ({ task: task(id), arm, rep: 1, chain: forks });
    const queue = [run("a", w1), run("b"), run("c", w1, "comments"), run("d", w1), run("e"), run("f", w1, "comments")];

    const slices = [shard(queue, "1/3", warmupOf), shard(queue, "2/3", warmupOf), shard(queue, "3/3", warmupOf)];

    expect(slices.map((slice) => slice.map((p) => p.task.id))).toEqual([["a", "d", "e"], ["b"], ["c", "f"]]);
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
