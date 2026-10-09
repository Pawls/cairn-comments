/** Summary statistics for the benchmark report. */

export interface Spread {
  n: number;
  median: number;
  q1: number;
  q3: number;
}

/** The `q` quantile of ascending `sorted`, interpolating linearly between ranks. */
function quantile(sorted: number[], q: number): number {
  const rank = (sorted.length - 1) * q;
  const below = Math.floor(rank);
  const lower = sorted[below]!;
  const upper = sorted[Math.min(below + 1, sorted.length - 1)]!;
  return lower + (upper - lower) * (rank - below);
}

export function spreadOf(values: number[]): Spread | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, median: quantile(sorted, 0.5), q1: quantile(sorted, 0.25), q3: quantile(sorted, 0.75) };
}

export interface PairedDifference {
  task: string;
  baseline: number;
  treatment: number;
  /** `treatment - baseline`, of the two arms' medians. */
  difference: number;
  /** `difference / baseline`. */
  relative: number;
}

/**
 * Per task, the treatment arm's median against the baseline arm's. Pairing by task keeps
 * the spread between easy and hard tasks out of the comparison. Tasks missing either arm
 * are left out.
 */
export function pairedDifferences(
  byTask: Map<string, Record<string, number[]>>,
  baselineArm: string,
  treatmentArm: string,
): PairedDifference[] {
  const pairs: PairedDifference[] = [];
  for (const [task, arms] of byTask) {
    const baseline = spreadOf(arms[baselineArm] ?? [])?.median;
    const treatment = spreadOf(arms[treatmentArm] ?? [])?.median;
    if (baseline === undefined || treatment === undefined) continue;
    const difference = treatment - baseline;
    pairs.push({ task, baseline, treatment, difference, relative: difference / baseline });
  }
  return pairs;
}

/** A seeded pseudo-random generator (mulberry32) returning values in [0, 1). */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A copy of `items` in an order fixed by `seed` (Fisher-Yates). */
export function shuffled<T>(items: T[], seed: number): T[] {
  const random = seededRandom(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
