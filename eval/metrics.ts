// Scoring metrics for both studies. Pure functions, no I/O - every number that
// ends up in eval/out/ is computed here and can be re-derived from the raw
// per-item records the runner writes alongside them.
import { sentimentBucket } from "../src/lib/sentiment.js";
import type { SentimentBucket } from "../shared/types.js";

export const BUCKETS = ["negative", "neutral", "positive"] as const;

// Production maps a score to a bucket with a fixed +/-0.1 neutral band
// (src/lib/sentiment.ts). The sweep needs the same rule at other band widths, so
// the width is a parameter here; a test asserts bucketAt(s, 0.1) is identical to
// the production sentimentBucket for every s, which is what makes the t = 0.1 row
// of the sweep the production configuration rather than a lookalike.
export function bucketAt(score: number, t: number): SentimentBucket {
  if (score > t) return "positive";
  if (score < -t) return "negative";
  return "neutral";
}

export const productionBucket = (score: number): SentimentBucket =>
  sentimentBucket(score) ?? "neutral";

export interface Pair {
  actual: SentimentBucket;
  predicted: SentimentBucket;
}

export type Confusion = Record<SentimentBucket, Record<SentimentBucket, number>>;

export interface ClassMetrics {
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

export interface ClassificationReport {
  n: number;
  accuracy: number;
  macroF1: number;
  perClass: Record<SentimentBucket, ClassMetrics>;
  confusion: Confusion; // confusion[actual][predicted]
}

const round = (v: number, dp = 4): number => Number(v.toFixed(dp));

export function confusionMatrix(pairs: readonly Pair[]): Confusion {
  const m = {} as Confusion;
  for (const a of BUCKETS) {
    m[a] = {} as Record<SentimentBucket, number>;
    for (const p of BUCKETS) m[a][p] = 0;
  }
  for (const { actual, predicted } of pairs) m[actual][predicted] += 1;
  return m;
}

// Macro-averaged so the (smaller) positive class counts as much as the others -
// a model that never predicts positive should not look good here.
export function classificationReport(pairs: readonly Pair[]): ClassificationReport {
  const confusion = confusionMatrix(pairs);
  const perClass = {} as Record<SentimentBucket, ClassMetrics>;
  let correct = 0;
  let f1Sum = 0;

  for (const label of BUCKETS) {
    const tp = confusion[label][label];
    const support = BUCKETS.reduce((sum, p) => sum + confusion[label][p], 0);
    const predicted = BUCKETS.reduce((sum, a) => sum + confusion[a][label], 0);
    // A class the model never predicts has undefined precision; report 0 rather
    // than NaN so the JSON stays numeric and macro-F1 penalises the omission.
    const precision = predicted ? tp / predicted : 0;
    const recall = support ? tp / support : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    perClass[label] = {
      precision: round(precision),
      recall: round(recall),
      f1: round(f1),
      support,
    };
    correct += tp;
    f1Sum += f1;
  }

  return {
    n: pairs.length,
    accuracy: pairs.length ? round(correct / pairs.length) : 0,
    macroF1: round(f1Sum / BUCKETS.length),
    perClass,
    confusion,
  };
}

export interface SweepRow {
  t: number;
  accuracy: number;
  macroF1: number;
}

// The neutral band is the only tunable in the production mapping, and the scores
// are already paid for, so sweeping it is free evidence about whether +/-0.1 is
// the right choice.
export function thresholdSweep(
  scored: readonly { label: SentimentBucket; score: number }[],
  thresholds: readonly number[],
): SweepRow[] {
  return thresholds.map((t) => {
    const report = classificationReport(
      scored.map((it) => ({ actual: it.label, predicted: bucketAt(it.score, t) })),
    );
    return { t: round(t, 2), accuracy: report.accuracy, macroF1: report.macroF1 };
  });
}

export interface DriftStats {
  n: number;
  meanAbsDelta: number;
  medianDelta: number;
  maxAbsDelta: number;
  flipRate: number; // share of items whose production bucket changed
  pearson: number | null; // null when either series is constant
}

// What the two tasks write to eval/out/. Kept next to the metrics they embed so
// the write-up phase has one place to read the output contract from.
export interface AccuracyResult {
  generatedAt: string;
  model: string;
  dataset: { name: string; url: string; filter: string; seed: number };
  n: number;
  unscored: number; // sampled items the model returned no score for
  production: ClassificationReport; // at the shipped +/-0.1 neutral band
  thresholdSweep: SweepRow[];
}

export interface DriftResult {
  generatedAt: string;
  model: string;
  n: number;
  languages: Record<string, DriftStats>;
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Pearson r between the two score series. Returns null when a series has zero
// variance, where r is undefined rather than 0.
export function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return null;
  return cov / Math.sqrt(vx * vy);
}

// `base` is the direct English score, `variant` the score after the round trip.
export function driftStats(
  pairs: readonly { base: number; variant: number }[],
): DriftStats {
  const deltas = pairs.map((p) => p.variant - p.base);
  const flips = pairs.filter(
    (p) => productionBucket(p.base) !== productionBucket(p.variant),
  ).length;
  const r = pearson(pairs.map((p) => p.base), pairs.map((p) => p.variant));
  return {
    n: pairs.length,
    meanAbsDelta: pairs.length
      ? round(deltas.reduce((s, d) => s + Math.abs(d), 0) / deltas.length)
      : 0,
    medianDelta: round(median(deltas)),
    maxAbsDelta: pairs.length ? round(Math.max(...deltas.map(Math.abs))) : 0,
    flipRate: pairs.length ? round(flips / pairs.length) : 0,
    pearson: r === null ? null : round(r),
  };
}
