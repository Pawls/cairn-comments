/** The order runs happen in, and how the queue splits across processes. */
import { shuffled } from "./stats.ts";
import type { Task, WarmupChain } from "./tasks.ts";
import { warmupKey } from "./warmup.ts";
import type { Arm } from "./workspace.ts";

export interface Planned {
  task: Task;
  arm: Arm;
  rep: number;
  /** The warm-up chain a deep run forks from; a fresh run has none. */
  chain?: WarmupChain;
}

/** Which runs start from an empty session, and which warm-up chains the deep runs fork. */
export interface Depths {
  fresh: boolean;
  chains: WarmupChain[];
}

const FRESH_ONLY: Depths = { fresh: true, chains: [] };

/**
 * Every (task, arm, start, repetition), where a start is fresh or a chain that starts where
 * the task does, shuffled by `seed` so neither arm runs in a block of its own.
 */
export function planRuns(tasks: Task[], arms: Arm[], reps: number, seed: number, depths = FRESH_ONLY): Planned[] {
  const all: Planned[] = [];
  for (const task of tasks) {
    // A start is the chain a deep run forks, or undefined for a fresh run.
    const forked = depths.chains.filter((chain) => startsWith(chain, task));
    const starts = depths.fresh ? [undefined, ...forked] : forked;
    for (const arm of arms) {
      for (const chain of starts) all.push(...repetitions(task, arm, chain, reps));
    }
  }
  return shuffled(all, seed);
}

/** A deep run forks the chain in the same checkout, so the task must start where the chain does. */
function startsWith(chain: WarmupChain, task: Task): boolean {
  return chain.repo === task.repo && chain.start === task.start;
}

/** The tasks that fork none of `chains`, and so get no deep run. */
export function unforked(tasks: Task[], chains: WarmupChain[]): Task[] {
  return tasks.filter((task) => !chains.some((chain) => startsWith(chain, task)));
}

function repetitions(task: Task, arm: Arm, chain: WarmupChain | undefined, reps: number): Planned[] {
  const planned: Planned[] = [];
  for (let rep = 1; rep <= reps; rep++) planned.push({ task, arm, rep, chain });
  return planned;
}

/** The warm-up a deep run forks: one per chain and arm. Its runs share one checkout. */
export function warmupOf(planned: Planned): string | undefined {
  return planned.chain === undefined ? undefined : warmupKey(planned.chain.id, planned.arm);
}

/** The next time the clock reads `hhmm` (local time) after `now`: today, or else tomorrow. */
export function nextOccurrence(hhmm: string, now: Date): Date {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  const hours = Number(match?.[1]);
  const minutes = Number(match?.[2]);
  if (!match || hours > 23 || minutes > 59) throw new Error(`--stop-at takes HH:MM, not ${hhmm}`);
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at;
}

/**
 * Each item's place in the round-robin: an item of no group gets one of its own, and every
 * item of a group shares the place of the group's first.
 */
function slots<T>(queue: T[], groupOf: (item: T) => string | undefined): Array<{ item: T; slot: number }> {
  const slotOf = new Map<string, number>();
  const result: Array<{ item: T; slot: number }> = [];
  for (const [position, item] of queue.entries()) {
    const group = groupOf(item);
    const key = group === undefined ? `item ${position}` : `group ${group}`;
    let slot = slotOf.get(key);
    if (slot === undefined) {
      slot = slotOf.size;
      slotOf.set(key, slot);
    }
    result.push({ item, slot });
  }
  return result;
}

/**
 * Slice `i` of `n` (`"i/n"`, 1-based): every n-th item from the i-th, counting each group
 * named by `groupOf` as one item, so a group stays in one slice. Processes given the same
 * queue and different slices share no run.
 */
export function shard<T>(queue: T[], spec: string | undefined, groupOf: (item: T) => string | undefined = () => undefined): T[] {
  if (spec === undefined) return queue;
  const match = /^(\d+)\/(\d+)$/.exec(spec);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (!match || index < 1 || index > count) throw new Error(`--shard takes i/n with 1 <= i <= n, not ${spec}`);
  return slots(queue, groupOf)
    .filter(({ slot }) => slot % count === index - 1)
    .map(({ item }) => item);
}
