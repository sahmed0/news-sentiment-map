// 95% confidence intervals for the reported metrics, so each figure shows how
// precise it is.
//
// No I/O, so every interval can be recomputed from the committed eval/out/ files
// without the API cache.
//
// Every bootstrap's input order is deterministic, because the bootstrap picks
// items by position: pooled and drift items are in compareItems order, confusion
// pairs in pairsFromConfusion order, and clusters sorted by key.
import type { SentimentBucket } from "../shared/types.js";
import {
  BUCKETS,
  accuracyOfConfusion,
  balancedAccuracyOfConfusion,
  bucketAt,
  macroF1OfConfusion,
  roundInterval,
  type AccuracyIntervals,
  type ClassificationReport,
  type ClusterIntervals,
  type Confusion,
  type Margin,
  type Pair,
} from "./metrics.js";

// Reuses the dataset sampler's random number generator so the two can't end up
// on slightly different versions. It writes `>>> 0` where the standard mulberry32
// writes `| 0`, but the output is identical (stats.test.ts checks this).
import { mulberry32 } from "./datasets.js";
export { mulberry32 };

export type Interval = [number, number];

// Wilson score interval for a proportion. Used instead of the simpler normal
// approximation because it stays within [0, 1] and stays accurate for small
// samples and for rates near 0 or 1, like the flip rates.
export function wilson(successes: number, n: number, z = 1.96): Interval {
  // [0, 0] rather than NaN, so the JSON stays numeric.
  if (n <= 0) return [0, 0];
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

export const BOOTSTRAP_B = 10000;

export interface BootstrapOptions {
  b?: number;
  seed: number;
  alpha?: number;
}

// The percentile bootstrap's resampled statistics, sorted. Changing any of these
// details changes every committed bootstrap interval:
//   - one random generator, seeded once and shared by every resample
//   - one draw per item: items[Math.floor(rng() * n)]
//   - the statistic is not rounded; only the caller rounds the final interval
export function bootstrapDistribution<T>(
  items: readonly T[],
  statistic: (sample: T[]) => number,
  { b = BOOTSTRAP_B, seed }: { b?: number; seed: number },
): number[] {
  const n = items.length;
  if (n === 0) return [];
  const rng = mulberry32(seed);
  const stats = new Array<number>(b);
  const sample = new Array<T>(n);
  for (let r = 0; r < b; r++) {
    for (let i = 0; i < n; i++) sample[i] = items[Math.floor(rng() * n)];
    stats[r] = statistic(sample);
  }
  return stats.sort((x, y) => x - y);
}

// The central 1 - alpha interval of a sorted distribution. Index clamped so the
// upper bound can't run past the end of the array.
export function percentileInterval(sorted: readonly number[], alpha: number): Interval {
  const b = sorted.length;
  if (b === 0) return [0, 0];
  const at = (q: number): number => sorted[Math.min(b - 1, Math.floor(q * b))];
  return [at(alpha / 2), at(1 - alpha / 2)];
}

export function bootstrapCI<T>(
  items: readonly T[],
  statistic: (sample: T[]) => number,
  { b = 10000, seed, alpha = 0.05 }: BootstrapOptions,
): Interval {
  return percentileInterval(bootstrapDistribution(items, statistic, { b, seed }), alpha);
}

export const excludesZero = ([lo, hi]: Interval): boolean => lo > 0 || hi < 0;

// --- The count-based fast path.
//
// Most statistics here depend only on HOW MANY resampled items fall in each
// category, so each item is encoded as a small integer and only the counts are
// tallied, rather than building an array of objects per resample (which is what
// made the generic bootstrap take seconds at n = 8,368). It uses the same single
// generator and the same draw per position, in the same order, so it reproduces
// bootstrapDistribution exactly; stats.test.ts checks that.
//
// `statistic` must not keep a reference to `counts`: the array is reused.
export function countsBootstrapDistribution(
  codes: readonly number[],
  k: number,
  statistic: (counts: Int32Array) => number,
  { b = BOOTSTRAP_B, seed }: { b?: number; seed: number },
): number[] {
  const n = codes.length;
  if (n === 0) return [];
  const stats = new Array<number>(b);
  const rng = mulberry32(seed);
  const counts = new Int32Array(k);
  for (let r = 0; r < b; r++) {
    counts.fill(0);
    for (let i = 0; i < n; i++) counts[codes[Math.floor(rng() * n)]] += 1;
    stats[r] = statistic(counts);
  }
  return stats.sort((x, y) => x - y);
}

// Resamples whole clusters instead of items: each resample draws as many clusters
// as there are, with replacement, and adds up their counts. With every cluster a
// singleton it is identical to countsBootstrapDistribution. The caller passes
// clusters sorted by key (plain code-unit order).
export function clusterCountsBootstrapDistribution(
  clusters: readonly (readonly number[])[],
  k: number,
  statistic: (counts: Int32Array) => number,
  { b = BOOTSTRAP_B, seed }: { b?: number; seed: number },
): number[] {
  const c = clusters.length;
  if (c === 0) return [];
  const vectors = clusters.map((codes) => {
    const v = new Int32Array(k);
    for (const code of codes) v[code] += 1;
    return v;
  });
  const stats = new Array<number>(b);
  const rng = mulberry32(seed);
  const counts = new Int32Array(k);
  for (let r = 0; r < b; r++) {
    counts.fill(0);
    for (let i = 0; i < c; i++) {
      const v = vectors[Math.floor(rng() * c)];
      for (let j = 0; j < k; j++) counts[j] += v[j];
    }
    stats[r] = statistic(counts);
  }
  return stats.sort((x, y) => x - y);
}

// Resamples within each stratum separately (one generator, strata in order), so
// each class keeps its size. An empty stratum stays empty. Only drift uses it,
// where n is small.
export function stratifiedBootstrapDistribution<T>(
  strata: readonly (readonly T[])[],
  statistic: (samples: T[][]) => number,
  { b = BOOTSTRAP_B, seed }: { b?: number; seed: number },
): number[] {
  if (strata.every((s) => s.length === 0)) return [];
  const rng = mulberry32(seed);
  const stats = new Array<number>(b);
  const samples = strata.map((s) => new Array<T>(s.length));
  for (let r = 0; r < b; r++) {
    strata.forEach((stratum, s) => {
      const n = stratum.length;
      for (let i = 0; i < n; i++) samples[s][i] = stratum[Math.floor(rng() * n)];
    });
    stats[r] = statistic(samples);
  }
  return stats.sort((x, y) => x - y);
}

// Codes for the fast path. Every count-based statistic turns its counts back into
// a Confusion and calls the metrics.ts function, so the arithmetic is the same
// code path as classificationReport.
const bucketIndex = (label: SentimentBucket): number => BUCKETS.indexOf(label);

export const pairCode = (actual: SentimentBucket, predicted: SentimentBucket): number =>
  3 * bucketIndex(actual) + bucketIndex(predicted);

export const pairedCode = (actual: SentimentBucket, model: SentimentBucket, baseline: SentimentBucket): number =>
  9 * bucketIndex(actual) + 3 * bucketIndex(model) + bucketIndex(baseline);

const emptyConfusion = (): Confusion => {
  const m = {} as Confusion;
  for (const a of BUCKETS) {
    m[a] = {} as Record<SentimentBucket, number>;
    for (const p of BUCKETS) m[a][p] = 0;
  }
  return m;
};

// From the 9 pairCode counts.
export function confusionFromCounts(counts: ArrayLike<number>): Confusion {
  const m = emptyConfusion();
  BUCKETS.forEach((a, i) => {
    BUCKETS.forEach((p, j) => {
      m[a][p] = counts[3 * i + j];
    });
  });
  return m;
}

// From the 27 pairedCode counts, summing out the other classifier each time.
export function confusionsFromPairedCounts(counts: ArrayLike<number>): { model: Confusion; baseline: Confusion } {
  const model = emptyConfusion();
  const baseline = emptyConfusion();
  BUCKETS.forEach((a, i) => {
    BUCKETS.forEach((m, j) => {
      BUCKETS.forEach((bl, l) => {
        const c = counts[9 * i + 3 * j + l];
        model[a][m] += c;
        baseline[a][bl] += c;
      });
    });
  });
  return { model, baseline };
}

// Rebuilds the (actual, predicted) pairs from a confusion matrix, so the macro-F1
// interval can be recomputed from the committed output. Keep the order (actual,
// then predicted, both in BUCKETS order): the bootstrap picks items by position,
// so its result depends on it.
export function pairsFromConfusion(confusion: Confusion): Pair[] {
  const pairs: Pair[] = [];
  for (const actual of BUCKETS) {
    for (const predicted of BUCKETS) {
      for (let k = 0; k < confusion[actual][predicted]; k++) pairs.push({ actual, predicted });
    }
  }
  return pairs;
}

const round4 = (v: number): number => Number(v.toFixed(4));

const correctCount = (confusion: Confusion): number =>
  BUCKETS.reduce((sum, label) => sum + confusion[label][label], 0);

// Wilson for accuracy and recall, which are simple proportions; a bootstrap for
// balanced accuracy and macro-F1, which are not. The bootstraps run over the
// confusion matrix's own pairs, so both stay reproducible from the committed
// matrix alone; each has its own run with the same seed.
export function accuracyIntervals(
  report: ClassificationReport,
  { b = BOOTSTRAP_B, seed }: { b?: number; seed: number },
): AccuracyIntervals {
  const { confusion, n } = report;
  const perClassRecall = {} as Record<SentimentBucket, Interval>;
  for (const label of BUCKETS) {
    const support = BUCKETS.reduce((sum, p) => sum + confusion[label][p], 0);
    perClassRecall[label] = roundInterval(wilson(confusion[label][label], support));
  }
  const codes = pairsFromConfusion(confusion).map((p) => pairCode(p.actual, p.predicted));
  const ci = (metric: (c: Confusion) => number): Interval =>
    roundInterval(
      percentileInterval(
        countsBootstrapDistribution(codes, 9, (counts) => metric(confusionFromCounts(counts)), { b, seed }),
        0.05,
      ),
    );
  return {
    accuracy: roundInterval(wilson(correctCount(confusion), n)),
    balancedAccuracy: ci(balancedAccuracyOfConfusion),
    macroF1: ci(macroF1OfConfusion),
    perClassRecall,
  };
}

export interface PairedItem {
  actual: SentimentBucket;
  model: SentimentBucket;
  baseline: SentimentBucket;
}

// Model minus baseline on the same items. Each metric gets its own bootstrap run
// with the same seed, so any interval can be reproduced on its own. When
// `adjustedAlpha` is set (several comparisons at once), the Bonferroni interval
// comes from the same sorted distribution as the 95% one.
export function pairedMargin(
  items: readonly PairedItem[],
  { b = BOOTSTRAP_B, seed, adjustedAlpha }: { b?: number; seed: number; adjustedAlpha?: number },
): Margin {
  const codes = items.map((it) => pairedCode(it.actual, it.model, it.baseline));
  const diffOf = (metric: (c: Confusion) => number) => (counts: ArrayLike<number>): number => {
    const { model, baseline } = confusionsFromPairedCounts(counts);
    return metric(model) - metric(baseline);
  };
  const pointCounts = new Int32Array(27);
  for (const code of codes) pointCounts[code] += 1;

  const run = (metric: (c: Confusion) => number): { point: number; sorted: number[] } => ({
    point: round4(diffOf(metric)(pointCounts)),
    sorted: countsBootstrapDistribution(codes, 27, diffOf(metric), { b, seed }),
  });
  const accuracy = run(accuracyOfConfusion);
  const balanced = run(balancedAccuracyOfConfusion);
  const f1 = run(macroF1OfConfusion);
  const ci95 = (sorted: number[]): Interval => roundInterval(percentileInterval(sorted, 0.05));

  let adjusted: Margin["adjusted"] = null;
  if (adjustedAlpha !== undefined) {
    const adj = (sorted: number[]): Interval => roundInterval(percentileInterval(sorted, adjustedAlpha));
    const accuracyCI = adj(accuracy.sorted);
    const balancedAccuracyCI = adj(balanced.sorted);
    const macroF1CI = adj(f1.sorted);
    adjusted = {
      alpha: adjustedAlpha,
      accuracyCI,
      balancedAccuracyCI,
      macroF1CI,
      established: {
        accuracy: excludesZero(accuracyCI),
        balancedAccuracy: excludesZero(balancedAccuracyCI),
        macroF1: excludesZero(macroF1CI),
      },
    };
  }

  return {
    accuracy: accuracy.point,
    accuracyCI: ci95(accuracy.sorted),
    balancedAccuracy: balanced.point,
    balancedAccuracyCI: ci95(balanced.sorted),
    macroF1: f1.point,
    macroF1CI: ci95(f1.sorted),
    adjusted,
  };
}

// Each sweep band against the shipped one, on the same scores. Bonferroni over
// the non-shipped rows, so a band only "beats" the shipped one if its adjusted
// interval excludes zero.
export function sweepMargins(
  scored: readonly { label: SentimentBucket; score: number }[],
  thresholds: readonly number[],
  shipped: number,
  { b = BOOTSTRAP_B, seed }: { b?: number; seed: number },
): (Margin | null)[] {
  const adjustedAlpha = 0.05 / (thresholds.length - 1);
  return thresholds.map((t) =>
    t === shipped
      ? null
      : pairedMargin(
          scored.map((it) => ({
            actual: it.label,
            model: bucketAt(it.score, t),
            baseline: bucketAt(it.score, shipped),
          })),
          { b, seed, adjustedAlpha },
        ),
  );
}

// The headline intervals again, resampling clusters (articles or stories) rather
// than sentences. Sentences from one article are correlated, so this shows how
// much the item-level intervals rely on independence.
export function clusterIntervals(
  items: readonly { cluster: string; actual: SentimentBucket; predicted: SentimentBucket }[],
  { b = BOOTSTRAP_B, seed }: { b?: number; seed: number },
): ClusterIntervals {
  const byKey = new Map<string, number[]>();
  for (const it of items) {
    const code = pairCode(it.actual, it.predicted);
    const group = byKey.get(it.cluster);
    if (group) group.push(code);
    else byKey.set(it.cluster, [code]);
  }
  const keys = [...byKey.keys()].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const clusters = keys.map((key) => byKey.get(key) ?? []);
  const ci = (metric: (c: Confusion) => number): Interval =>
    roundInterval(
      percentileInterval(
        clusterCountsBootstrapDistribution(clusters, 9, (counts) => metric(confusionFromCounts(counts)), {
          b,
          seed,
        }),
        0.05,
      ),
    );
  return {
    clusters: clusters.length,
    accuracy: ci(accuracyOfConfusion),
    balancedAccuracy: ci(balancedAccuracyOfConfusion),
    macroF1: ci(macroF1OfConfusion),
  };
}

// Rate of `xs` minus rate of `ys`, paired item by item (e.g. two languages' flip
// flags on the same sentences). Not named a/b: `b` is the resample count.
export function pairedRateDifference(
  xs: readonly boolean[],
  ys: readonly boolean[],
  { b = BOOTSTRAP_B, seed, adjustedAlpha }: { b?: number; seed: number; adjustedAlpha: number },
): { n: number; diff: number; ci: Interval; adjustedCI: Interval; established: boolean } {
  if (xs.length !== ys.length) {
    throw new Error(`pairedRateDifference: ${xs.length} vs ${ys.length} flags; the two must be paired`);
  }
  const n = xs.length;
  const codes = xs.map((x, i) => (x ? 2 : 0) + (ys[i] ? 1 : 0));
  // counts[2] is "x only", counts[1] "y only"; items where both or neither are
  // set cancel out.
  const statistic = (counts: ArrayLike<number>): number => (counts[2] - counts[1]) / n;
  const pointCounts = [0, 0, 0, 0];
  for (const code of codes) pointCounts[code] += 1;
  const sorted = countsBootstrapDistribution(codes, 4, statistic, { b, seed });
  const adjustedCI = roundInterval(percentileInterval(sorted, adjustedAlpha));
  return {
    n,
    diff: n ? round4(statistic(pointCounts)) : 0,
    ci: roundInterval(percentileInterval(sorted, 0.05)),
    adjustedCI,
    established: excludesZero(adjustedCI),
  };
}

export function meanAbsDeltaCI(
  deltas: readonly number[],
  { b = BOOTSTRAP_B, seed }: { b?: number; seed: number },
): Interval {
  const meanAbs = (sample: readonly number[]): number =>
    sample.reduce((sum, d) => sum + Math.abs(d), 0) / sample.length;
  return roundInterval(bootstrapCI(deltas, meanAbs, { b, seed }));
}

// A rate re-weighted from a balanced sample to the pool's class mix: the sum of
// share x per-class rate. Shares are renormalised over the classes that have
// items, which only matters in toy and smoke runs (the --drift-batches 1 slice is
// all negative), where a class can be empty.
export function poolWeightedRate(
  flagsByClass: Record<SentimentBucket, readonly boolean[]>,
  shares: Record<SentimentBucket, number>,
  { b = BOOTSTRAP_B, seed }: { b?: number; seed: number },
): { rate: number; ci: Interval } {
  const strata = BUCKETS.map((label) => flagsByClass[label]);
  const present = BUCKETS.filter((label) => flagsByClass[label].length > 0);
  const total = present.reduce((sum, label) => sum + shares[label], 0);
  const weights = BUCKETS.map((label) =>
    flagsByClass[label].length > 0 && total > 0 ? shares[label] / total : 0,
  );
  const rateOf = (flags: readonly boolean[]): number =>
    flags.length ? flags.filter(Boolean).length / flags.length : 0;
  const statistic = (samples: readonly (readonly boolean[])[]): number =>
    samples.reduce((sum, sample, i) => sum + weights[i] * rateOf(sample), 0);
  if (!present.length) return { rate: 0, ci: [0, 0] };
  const sorted = stratifiedBootstrapDistribution(strata, statistic, { b, seed });
  return { rate: round4(statistic(strata)), ci: roundInterval(percentileInterval(sorted, 0.05)) };
}
