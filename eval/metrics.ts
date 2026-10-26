// Scoring metrics for both studies. Pure functions, no I/O - every number that
// ends up in eval/out/ is computed here and can be re-derived from the raw
// per-item records the runner writes alongside them.
import { sentimentBucket } from "../src/lib/sentiment.js";
import type { SentimentBucket } from "../shared/types.js";
import type { NewsmtscSplit } from "./datasets.js";
import { wilson, type Interval } from "./stats.js";

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
  // Unweighted mean of the three per-class recalls, so it does not depend on the
  // class mix the way raw accuracy does.
  balancedAccuracy: number;
  macroF1: number;
  perClass: Record<SentimentBucket, ClassMetrics>;
  confusion: Confusion; // confusion[actual][predicted]
}

const round = (v: number, dp = 4): number => Number(v.toFixed(dp));
export const roundInterval = ([lo, hi]: [number, number]): [number, number] => [round(lo), round(hi)];

export function confusionMatrix(pairs: readonly Pair[]): Confusion {
  const m = {} as Confusion;
  for (const a of BUCKETS) {
    m[a] = {} as Record<SentimentBucket, number>;
    for (const p of BUCKETS) m[a][p] = 0;
  }
  for (const { actual, predicted } of pairs) m[actual][predicted] += 1;
  return m;
}

interface RawClassMetrics extends ClassMetrics {
  tp: number;
}

// Unrounded per-class metrics. classificationReport rounds them for display, but
// macroF1 must not: the bootstrap calls it 10,000 times, and rounding each result
// can shift the interval.
function rawClassMetrics(confusion: Confusion, label: SentimentBucket): RawClassMetrics {
  const tp = confusion[label][label];
  const support = BUCKETS.reduce((sum, p) => sum + confusion[label][p], 0);
  const predicted = BUCKETS.reduce((sum, a) => sum + confusion[a][label], 0);
  // A class the model never predicts has undefined precision; report 0 rather
  // than NaN so the JSON stays numeric and macro-F1 penalises the omission.
  const precision = predicted ? tp / predicted : 0;
  const recall = support ? tp / support : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, support, tp };
}

// The unrounded statistics, each from a confusion matrix. The bootstrap calls
// these thousands of times, through the same code path as classificationReport.
export function accuracyOfConfusion(confusion: Confusion): number {
  let correct = 0;
  let total = 0;
  for (const a of BUCKETS) {
    for (const p of BUCKETS) total += confusion[a][p];
    correct += confusion[a][a];
  }
  return total ? correct / total : 0;
}

// A class with no support contributes recall 0, the same rule as rawClassMetrics.
export function balancedAccuracyOfConfusion(confusion: Confusion): number {
  return BUCKETS.reduce((sum, label) => sum + rawClassMetrics(confusion, label).recall, 0) / BUCKETS.length;
}

// Macro-averaged so the (smaller) positive class counts as much as the others -
// a model that never predicts positive should not look good here.
export function macroF1OfConfusion(confusion: Confusion): number {
  return BUCKETS.reduce((sum, label) => sum + rawClassMetrics(confusion, label).f1, 0) / BUCKETS.length;
}

export function macroF1(pairs: readonly Pair[]): number {
  return macroF1OfConfusion(confusionMatrix(pairs));
}

export function classificationReport(pairs: readonly Pair[]): ClassificationReport {
  const confusion = confusionMatrix(pairs);
  const perClass = {} as Record<SentimentBucket, ClassMetrics>;
  let correct = 0;
  let recallSum = 0;
  let f1Sum = 0;

  for (const label of BUCKETS) {
    const { precision, recall, f1, support, tp } = rawClassMetrics(confusion, label);
    perClass[label] = {
      precision: round(precision),
      recall: round(recall),
      f1: round(f1),
      support,
    };
    correct += tp;
    recallSum += recall;
    f1Sum += f1;
  }

  return {
    n: pairs.length,
    accuracy: pairs.length ? round(correct / pairs.length) : 0,
    balancedAccuracy: round(recallSum / BUCKETS.length),
    macroF1: round(f1Sum / BUCKETS.length),
    perClass,
    confusion,
  };
}

// Bumped when the shape of eval/out/ changes incompatibly. Version 2 is the
// full-pool study; the previous evaluation's files had no version field.
export const RESULT_FORMAT_VERSION = 2;

export interface AccuracyIntervals {
  accuracy: Interval; // Wilson
  balancedAccuracy: Interval; // percentile bootstrap
  macroF1: Interval; // percentile bootstrap
  perClassRecall: Record<SentimentBucket, Interval>; // Wilson
}

// One paired comparison: A minus B on the same items. Each bootstrap resample is
// shared by both, so the interval measures the gap itself rather than adding up
// each one's separate uncertainty. `adjusted` is null unless a Bonferroni level
// applies (several comparisons made at once); a difference is "established"
// only if that adjusted interval excludes zero.
export interface Margin {
  accuracy: number;
  accuracyCI: Interval;
  balancedAccuracy: number;
  balancedAccuracyCI: Interval;
  macroF1: number;
  macroF1CI: Interval;
  adjusted: null | {
    alpha: number;
    accuracyCI: Interval;
    balancedAccuracyCI: Interval;
    macroF1CI: Interval;
    established: { accuracy: boolean; balancedAccuracy: boolean; macroF1: boolean };
  };
}

// The same 95% intervals, resampling whole clusters (article or story) instead of
// sentences. A sensitivity check on the independence assumption, not a substitute.
export interface ClusterIntervals {
  clusters: number;
  accuracy: Interval;
  balancedAccuracy: Interval;
  macroF1: Interval;
}

export interface SweepRow {
  t: number;
  accuracy: number;
  balancedAccuracy: number;
  macroF1: number;
  vsShipped: Margin | null; // this band minus the shipped one; null on the shipped row
}

// The neutral band is the only tunable in the production mapping, and the scores
// are already paid for, so sweeping it is free evidence about whether +/-0.1 is
// the right choice. The paired margins are added by the runner (stats.sweepMargins).
export function thresholdSweep(
  scored: readonly { label: SentimentBucket; score: number }[],
  thresholds: readonly number[],
): Omit<SweepRow, "vsShipped">[] {
  return thresholds.map((t) => {
    const report = classificationReport(
      scored.map((it) => ({ actual: it.label, predicted: bucketAt(it.score, t) })),
    );
    return {
      t: round(t, 2),
      accuracy: report.accuracy,
      balancedAccuracy: report.balancedAccuracy,
      macroF1: report.macroF1,
    };
  });
}

export interface DriftStats {
  n: number;
  meanAbsDelta: number;
  medianDelta: number;
  maxAbsDelta: number;
  flips: number; // items whose production bucket changed
  flipRate: number; // flips / n
  flipRateCI: Interval; // 95% Wilson interval
  pearson: number | null; // null when either series is constant
}

export interface PoolSummary {
  name: string;
  commit: string;
  filter: string;
  splits: Record<NewsmtscSplit, { url: string; rows: number; items: number }>;
  crossSplitDuplicates: { sentences: number; kept: number; dropped: number };
  overlong: { maxChars: number; dropped: number }; // too long for the model to accept
  size: number;
  classCounts: Record<SentimentBucket, number>;
}

// What a live run actually sent (cache misses only). Null under --dry-run and
// --offline, which spend nothing.
export interface SpendSummary {
  hfRequests: number;
  hfRows: number;
  azureRequests: number;
  azureChars: number;
}

// What the two tasks write to eval/out/. Kept next to the metrics they embed so
// the write-up phase has one place to read the output contract from.
export interface AccuracyResult {
  formatVersion: 2;
  generatedAt: string;
  model: string;
  // The Hub revision at run time. Provenance, not proof: the inference router
  // does not promise to serve that exact revision. Null under --dry-run/--offline.
  modelRevision: string | null;
  dataset: PoolSummary;
  sample: { kind: "full" } | { kind: "limit"; perClass: number; seed: number };
  n: number;
  unscored: number; // sampled items the model returned no score for
  production: ClassificationReport; // at the shipped +/-0.1 neutral band
  intervals: AccuracyIntervals;
  clusterCheck: { article: ClusterIntervals; story: ClusterIntervals };
  perSplit: Record<NewsmtscSplit, { report: ClassificationReport; intervals: AccuracyIntervals }>;
  baselines: {
    // No interval. Balanced accuracy is always 1/3 by construction; accuracy is
    // the majority class's share of the sample.
    majorityClass: { label: SentimentBucket; accuracy: number; balancedAccuracy: number; macroF1: number };
    afinn: ClassificationReport;
    afinnIntervals: AccuracyIntervals;
    modelOverAfinn: Margin; // a single comparison, so `adjusted` is null
  };
  bootstrap: { b: number; seed: number; method: "percentile"; sweepAdjustedAlpha: number };
  thresholdSweep: SweepRow[];
  spend: SpendSummary | null;
}

export interface LanguageDrift extends DriftStats {
  meanAbsDeltaCI: Interval;
  perClass: Record<SentimentBucket, { n: number; flips: number; flipRate: number; flipRateCI: Interval }>;
  // The flip rate re-weighted to the pool's class mix, since the drift sample is
  // drawn balanced.
  poolWeightedFlipRate: number;
  poolWeightedFlipRateCI: Interval;
}

// diff = flip rate of `a` minus that of `b`, over the items both languages scored.
export interface PairwiseFlipDiff {
  a: string;
  b: string;
  n: number;
  diff: number;
  ci: Interval;
  adjustedCI: Interval;
  established: boolean;
}

export interface DriftResult {
  formatVersion: 2;
  generatedAt: string;
  model: string;
  modelRevision: string | null;
  sample: {
    seed: number;
    perClass: number;
    n: number;
    classCounts: Record<SentimentBucket, number>;
    poolShares: Record<SentimentBucket, number>;
    firstBatches: number | null; // set by a --drift-batches smoke run, whose numbers are not results
  };
  n: number;
  languages: Record<string, LanguageDrift>;
  pairwise: PairwiseFlipDiff[];
  bootstrap: { b: number; seed: number; method: "percentile"; pairwiseAdjustedAlpha: number | null };
  spend: SpendSummary | null;
}

// The per-item files. Ids and labels only, no sentence text: join with the
// public dataset by id.
export interface AccuracyItemRecord {
  id: string;
  split: NewsmtscSplit;
  label: SentimentBucket;
  score: number | null;
}

export interface DriftItemRecord {
  id: string;
  split: NewsmtscSplit;
  label: SentimentBucket;
  base: number | null;
  variants: Record<string, number | null>;
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
    flips,
    flipRate: pairs.length ? round(flips / pairs.length) : 0,
    flipRateCI: roundInterval(wilson(flips, pairs.length)),
    pearson: r === null ? null : round(r),
  };
}
