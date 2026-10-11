/** The order runs happen in, and how the queue splits across processes. */
import { shuffled } from "./stats.ts";
import type { Task } from "./tasks.ts";
import type { Arm } from "./workspace.ts";

export interface Planned {
  task: Task;
  arm: Arm;
  rep: number;
}

/** Every (task, arm, repetition), shuffled by `seed` so neither arm runs in a block of its own. */
export function planRuns(tasks: Task[], arms: Arm[], reps: number, seed: number): Planned[] {
  const all: Planned[] = [];
  for (const task of tasks) {
    for (const arm of arms) {
      for (let rep = 1; rep <= reps; rep++) all.push({ task, arm, rep });
    }
  }
  return shuffled(all, seed);
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
 * Slice `i` of `n` (`"i/n"`, 1-based): every n-th item from the i-th. Processes given the
 * same queue and different slices share no run.
 */
export function shard<T>(queue: T[], spec: string | undefined): T[] {
  if (spec === undefined) return queue;
  const match = /^(\d+)\/(\d+)$/.exec(spec);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (!match || index < 1 || index > count) throw new Error(`--shard takes i/n with 1 <= i <= n, not ${spec}`);
  return queue.filter((_, position) => position % count === index - 1);
}
