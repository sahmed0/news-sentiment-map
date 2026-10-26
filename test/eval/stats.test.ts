import { describe, it, expect } from "vitest";
import { EVAL_SEED } from "../../eval/datasets.js";
import {
  accuracyIntervals,
  bootstrapCI,
  bootstrapDistribution,
  clusterCountsBootstrapDistribution,
  confusionFromCounts,
  countsBootstrapDistribution,
  excludesZero,
  mulberry32,
  pairCode,
  pairedMargin,
  pairedRateDifference,
  pairsFromConfusion,
  percentileInterval,
  poolWeightedRate,
  stratifiedBootstrapDistribution,
  sweepMargins,
  wilson,
  type PairedItem,
} from "../../eval/stats.js";
import {
  BUCKETS,
  balancedAccuracyOfConfusion,
  classificationReport,
  confusionMatrix,
  driftStats,
  macroF1,
  macroF1OfConfusion,
  type Confusion,
  type Pair,
} from "../../eval/metrics.js";

// The previous evaluation's confusion matrix (n = 300), kept to pin the
// bootstrap conventions.
const confusion: Confusion = {
  negative: { negative: 85, neutral: 13, positive: 2 },
  neutral: { negative: 45, neutral: 44, positive: 11 },
  positive: { negative: 19, neutral: 20, positive: 61 },
};

// Expected Wilson values are percentages to 1 decimal place (57.7% = 0.577), so
// the default tolerance is 1e-3.
const expectInterval = ([lo, hi]: [number, number], [elo, ehi]: [number, number], tol = 1e-3): void => {
  expect(Math.abs(lo - elo)).toBeLessThan(tol);
  expect(Math.abs(hi - ehi)).toBeLessThan(tol);
};

const randomPairs = (n: number, seed: number): Pair[] => {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, () => ({
    actual: BUCKETS[Math.floor(rng() * 3)],
    predicted: BUCKETS[Math.floor(rng() * 3)],
  }));
};

const balancedOf = (pairs: readonly Pair[]): number => balancedAccuracyOfConfusion(confusionMatrix(pairs));

describe("wilson", () => {
  it.each([
    ["accuracy", 190, 300, [0.577, 0.686]],
    ["negative recall", 85, 100, [0.767, 0.907]],
    ["neutral recall", 44, 100, [0.347, 0.538]],
    ["positive recall", 61, 100, [0.512, 0.7]],
    ["flip rate fr", 8, 99, [0.042, 0.151]],
    ["flip rate de", 12, 99, [0.071, 0.2]],
    ["flip rate ar", 8, 99, [0.042, 0.151]],
    ["flip rate ja", 15, 99, [0.094, 0.235]],
    ["flip rate pt", 12, 99, [0.071, 0.2]],
  ] as const)("%s: %i / %i", (_name, k, n, expected) => {
    expectInterval(wilson(k, n), [expected[0], expected[1]]);
  });

  it("returns [0, 0] for n = 0 instead of NaN", () => {
    expect(wilson(0, 0)).toEqual([0, 0]);
  });

  it("stays inside [0, 1] at the extremes, where the normal approximation does not", () => {
    const [lo0, hi0] = wilson(0, 10);
    const [lo1, hi1] = wilson(10, 10);
    expect(lo0).toBe(0);
    expect(hi0).toBeGreaterThan(0);
    expect(hi1).toBe(1);
    expect(lo1).toBeLessThan(1);
  });
});

describe("pairsFromConfusion", () => {
  it("expands the frozen matrix into exactly 300 pairs that rebuild it", () => {
    const pairs = pairsFromConfusion(confusion);
    expect(pairs).toHaveLength(300);
    expect(classificationReport(pairs).confusion).toEqual(confusion);
  });

  it("orders outer = actual, inner = predicted, in BUCKETS order", () => {
    const pairs = pairsFromConfusion(confusion);
    expect(pairs[0]).toEqual({ actual: "negative", predicted: "negative" });
    expect(pairs[85]).toEqual({ actual: "negative", predicted: "neutral" });
    expect(pairs[98]).toEqual({ actual: "negative", predicted: "positive" });
    expect(pairs[100]).toEqual({ actual: "neutral", predicted: "negative" });
    expect(pairs[299]).toEqual({ actual: "positive", predicted: "positive" });
  });
});

describe("bootstrapCI", () => {
  const pairs = pairsFromConfusion(confusion);

  it("reproduces the previous evaluation's macro-F1 point estimate unrounded", () => {
    expect(Math.abs(macroF1(pairs) - 0.627)).toBeLessThan(1e-4);
  });

  it("gives 0.5713 - 0.6790 with the eval seed, b = 10000", () => {
    const [lo, hi] = bootstrapCI(pairs, macroF1, { b: 10000, seed: EVAL_SEED });
    expect(Math.abs(lo - 0.5713)).toBeLessThan(1e-4);
    expect(Math.abs(hi - 0.679)).toBeLessThan(1e-4);
  });

  it("is deterministic for a seed and moves with it", () => {
    const stat = (s: number[]): number => s.reduce((a, v) => a + v, 0) / s.length;
    const data = Array.from({ length: 50 }, (_, i) => i);
    const a = bootstrapCI(data, stat, { b: 500, seed: 1 });
    expect(bootstrapCI(data, stat, { b: 500, seed: 1 })).toEqual(a);
    expect(bootstrapCI(data, stat, { b: 500, seed: 2 })).not.toEqual(a);
  });

  it("returns [0, 0] for no items", () => {
    expect(bootstrapCI([], () => 1, { seed: 1 })).toEqual([0, 0]);
  });
});

describe("percentileInterval", () => {
  const sorted = Array.from({ length: 10000 }, (_, i) => i);

  it("picks indices 250 / 9750 at 95%, 25 / 9975 at 99.5% and 50 / 9950 at 99%", () => {
    expect(percentileInterval(sorted, 0.05)).toEqual([250, 9750]);
    expect(percentileInterval(sorted, 0.005)).toEqual([25, 9975]);
    expect(percentileInterval(sorted, 0.01)).toEqual([50, 9950]);
  });

  it("gives [0, 0] for an empty distribution", () => {
    expect(percentileInterval([], 0.05)).toEqual([0, 0]);
  });
});

describe("excludesZero", () => {
  it("is true only when both bounds sit on the same side of zero", () => {
    expect(excludesZero([0.01, 0.2])).toBe(true);
    expect(excludesZero([-0.2, -0.01])).toBe(true);
    expect(excludesZero([-0.01, 0.2])).toBe(false);
    expect(excludesZero([0, 0.2])).toBe(false);
  });
});

describe("the count-based fast path", () => {
  const codesOf = (pairs: readonly Pair[]): number[] => pairs.map((p) => pairCode(p.actual, p.predicted));
  const fromCounts = (metric: (c: Confusion) => number) => (counts: Int32Array): number =>
    metric(confusionFromCounts(counts));

  const cases: [string, Pair[], number, number][] = [
    ["frozen previous-evaluation pairs", pairsFromConfusion(confusion), EVAL_SEED, 500],
    ["random n = 50", randomPairs(50, 11), 1, 500],
    ["random n = 301", randomPairs(301, 12), 2, 500],
    ["random n = 1000", randomPairs(1000, 13), 3, 500],
  ];

  it.each(cases)("reproduces the generic bootstrap exactly: %s", (_name, pairs, seed, b) => {
    const codes = codesOf(pairs);
    expect(countsBootstrapDistribution(codes, 9, fromCounts(macroF1OfConfusion), { b, seed })).toEqual(
      bootstrapDistribution(pairs, macroF1, { b, seed }),
    );
    expect(countsBootstrapDistribution(codes, 9, fromCounts(balancedAccuracyOfConfusion), { b, seed })).toEqual(
      bootstrapDistribution(pairs, balancedOf, { b, seed }),
    );
  });

  it("equals the plain fast path when every cluster is a singleton", () => {
    const codes = codesOf(randomPairs(301, 21));
    const statistic = fromCounts(macroF1OfConfusion);
    expect(clusterCountsBootstrapDistribution(codes.map((c) => [c]), 9, statistic, { b: 500, seed: 4 })).toEqual(
      countsBootstrapDistribution(codes, 9, statistic, { b: 500, seed: 4 }),
    );
  });

  it("stratified with one stratum equals the generic bootstrap", () => {
    const data = Array.from({ length: 120 }, (_, i) => (i * 37) % 11);
    const mean = (s: readonly number[]): number => s.reduce((a, v) => a + v, 0) / s.length;
    expect(stratifiedBootstrapDistribution([data], (samples) => mean(samples[0]), { b: 500, seed: 5 })).toEqual(
      bootstrapDistribution(data, mean, { b: 500, seed: 5 }),
    );
  });

  it("returns an empty distribution for no codes", () => {
    expect(countsBootstrapDistribution([], 9, () => 1, { b: 10, seed: 1 })).toEqual([]);
    expect(clusterCountsBootstrapDistribution([], 9, () => 1, { b: 10, seed: 1 })).toEqual([]);
  });
});

describe("mulberry32", () => {
  it("matches the reference mulberry32 body", () => {
    // The standard mulberry32. The sampler's copy uses `>>> 0` where this uses
    // `| 0`; the expected bootstrap values depend on both giving the same output.
    function reference(a: number): () => number {
      return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    for (const seed of [0, 1, EVAL_SEED, -7, 0xffffffff]) {
      const ours = mulberry32(seed);
      const ref = reference(seed);
      for (let i = 0; i < 5000; i++) expect(ours()).toBe(ref());
    }
  });
});

describe("accuracyIntervals", () => {
  it("assembles every accuracy interval from the frozen report", () => {
    const iv = accuracyIntervals(classificationReport(pairsFromConfusion(confusion)), { seed: EVAL_SEED });
    expectInterval(iv.accuracy, [0.577, 0.686]);
    expectInterval(iv.perClassRecall.negative, [0.767, 0.907]);
    expectInterval(iv.perClassRecall.neutral, [0.347, 0.538]);
    expectInterval(iv.perClassRecall.positive, [0.512, 0.7]);
    expectInterval(iv.macroF1, [0.5713, 0.679], 1e-4);
    // Balanced accuracy equals accuracy on a balanced sample, so its bootstrap
    // interval sits close to the Wilson one.
    expect(iv.balancedAccuracy[0]).toBeLessThan(0.6333);
    expect(iv.balancedAccuracy[1]).toBeGreaterThan(0.6333);
  });
});

describe("driftStats flipRateCI", () => {
  it("is the Wilson interval of the exact flip count", () => {
    // 8 of 99 items cross a bucket boundary.
    const pairs = Array.from({ length: 99 }, (_, i) => ({ base: 0.5, variant: i < 8 ? -0.5 : 0.5 }));
    const stats = driftStats(pairs);
    expect(stats.flips).toBe(8);
    expect(stats.flipRate).toBeCloseTo(8 / 99, 4);
    expectInterval(stats.flipRateCI, [0.042, 0.151]);
  });
});

describe("pairedMargin", () => {
  it("is zero with a zero interval when the two classifiers agree everywhere", () => {
    const items: PairedItem[] = pairsFromConfusion(confusion).map((p) => ({
      actual: p.actual,
      model: p.predicted,
      baseline: p.predicted,
    }));
    expect(pairedMargin(items, { b: 200, seed: 1 })).toEqual({
      accuracy: 0,
      accuracyCI: [0, 0],
      balancedAccuracy: 0,
      balancedAccuracyCI: [0, 0],
      macroF1: 0,
      macroF1CI: [0, 0],
      adjusted: null,
    });
  });

  it("reports model minus baseline, and the interval contains the point", () => {
    // Model right on every item, baseline predicting "neutral" throughout.
    const items: PairedItem[] = pairsFromConfusion(confusion).map((p) => ({
      actual: p.actual,
      model: p.actual,
      baseline: "neutral",
    }));
    const m = pairedMargin(items, { b: 500, seed: 3 });
    expect(m.accuracy).toBeCloseTo(1 - 1 / 3, 4);
    expect(m.balancedAccuracy).toBeCloseTo(1 - 1 / 3, 4);
    expect(m.macroF1).toBeCloseTo(1 - 1 / 6, 4);
    for (const [point, [lo, hi]] of [
      [m.accuracy, m.accuracyCI],
      [m.balancedAccuracy, m.balancedAccuracyCI],
      [m.macroF1, m.macroF1CI],
    ] as const) {
      expect(lo).toBeLessThanOrEqual(point);
      expect(hi).toBeGreaterThanOrEqual(point);
    }
  });

  it("adds a wider adjusted interval from the same resamples, and `established` follows it", () => {
    const pairs = randomPairs(400, 31);
    const items: PairedItem[] = pairs.map((p, i) => ({
      actual: p.actual,
      model: i % 3 ? p.actual : p.predicted,
      baseline: p.predicted,
    }));
    const m = pairedMargin(items, { b: 1000, seed: 6, adjustedAlpha: 0.01 });
    expect(m.adjusted).not.toBeNull();
    const adj = m.adjusted!;
    expect(adj.alpha).toBe(0.01);
    for (const [ci, wide] of [
      [m.accuracyCI, adj.accuracyCI],
      [m.balancedAccuracyCI, adj.balancedAccuracyCI],
      [m.macroF1CI, adj.macroF1CI],
    ] as const) {
      expect(wide[0]).toBeLessThanOrEqual(ci[0]);
      expect(wide[1]).toBeGreaterThanOrEqual(ci[1]);
    }
    expect(adj.established).toEqual({
      accuracy: excludesZero(adj.accuracyCI),
      balancedAccuracy: excludesZero(adj.balancedAccuracyCI),
      macroF1: excludesZero(adj.macroF1CI),
    });
    // A model right on two thirds more items is clearly better here.
    expect(adj.established.accuracy).toBe(true);
  });
});

describe("pairedRateDifference", () => {
  it("is exactly zero for identical flags", () => {
    const flags = Array.from({ length: 50 }, (_, i) => i % 4 === 0);
    const d = pairedRateDifference(flags, flags, { b: 300, seed: 1, adjustedAlpha: 0.005 });
    expect(d).toEqual({ n: 50, diff: 0, ci: [0, 0], adjustedCI: [0, 0], established: false });
  });

  it("is 1 when xs are all set and ys none", () => {
    const d = pairedRateDifference([true, true, true], [false, false, false], {
      b: 100,
      seed: 1,
      adjustedAlpha: 0.005,
    });
    expect(d.diff).toBe(1);
    expect(d.ci).toEqual([1, 1]);
    expect(d.established).toBe(true);
  });

  it("refuses flag arrays of different lengths", () => {
    expect(() => pairedRateDifference([true], [true, false], { seed: 1, adjustedAlpha: 0.005 })).toThrow(/paired/);
  });
});

describe("poolWeightedRate", () => {
  const flags = (n: number, set: number): boolean[] => Array.from({ length: n }, (_, i) => i < set);

  it("weights each class's rate by its pool share", () => {
    const r = poolWeightedRate(
      { negative: flags(10, 1), neutral: flags(10, 2), positive: flags(10, 4) },
      { negative: 0.5, neutral: 0.3, positive: 0.2 },
      { b: 200, seed: 1 },
    );
    // 0.5 x 0.1 + 0.3 x 0.2 + 0.2 x 0.4
    expect(r.rate).toBe(0.19);
    expect(r.ci[0]).toBeLessThanOrEqual(0.19);
    expect(r.ci[1]).toBeGreaterThanOrEqual(0.19);
  });

  it("renormalises the shares over the classes that have items", () => {
    const r = poolWeightedRate(
      { negative: flags(10, 1), neutral: [], positive: flags(10, 4) },
      { negative: 0.5, neutral: 0.3, positive: 0.2 },
      { b: 200, seed: 1 },
    );
    // (0.5 x 0.1 + 0.2 x 0.4) / 0.7
    expect(r.rate).toBeCloseTo(0.13 / 0.7, 4);
  });

  it("is 0 with no items at all", () => {
    expect(poolWeightedRate({ negative: [], neutral: [], positive: [] }, { negative: 0.4, neutral: 0.4, positive: 0.2 }, { seed: 1 })).toEqual({
      rate: 0,
      ci: [0, 0],
    });
  });
});

describe("sweepMargins", () => {
  it("is null on the shipped band and a Bonferroni-adjusted margin elsewhere", () => {
    const rng = mulberry32(9);
    const scored = Array.from({ length: 90 }, (_, i) => ({
      label: BUCKETS[i % 3],
      score: rng() * 2 - 1,
    }));
    const thresholds = [0.05, 0.1, 0.2];
    const margins = sweepMargins(scored, thresholds, 0.1, { b: 200, seed: 2 });
    expect(margins).toHaveLength(3);
    expect(margins[1]).toBeNull();
    for (const m of [margins[0], margins[2]]) {
      expect(m).not.toBeNull();
      expect(m?.adjusted?.alpha).toBe(0.05 / (thresholds.length - 1));
    }
  });
});
