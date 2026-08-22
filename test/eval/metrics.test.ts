import { describe, it, expect } from "vitest";
import {
  bucketAt,
  classificationReport,
  confusionMatrix,
  driftStats,
  pearson,
  productionBucket,
  thresholdSweep,
  type Pair,
} from "../../eval/metrics.js";
import { sentimentBucket } from "../../src/lib/sentiment.js";
import type { SentimentBucket } from "../../shared/types";

const pair = (actual: SentimentBucket, predicted: SentimentBucket): Pair => ({ actual, predicted });

//   negative: 4 actual - 3 predicted negative, 1 predicted neutral
//   neutral:  4 actual - 2 predicted neutral, 1 negative, 1 positive
//   positive: 4 actual - 2 predicted positive, 2 predicted neutral
const FIXTURE: Pair[] = [
  pair("negative", "negative"),
  pair("negative", "negative"),
  pair("negative", "negative"),
  pair("negative", "neutral"),
  pair("neutral", "neutral"),
  pair("neutral", "neutral"),
  pair("neutral", "negative"),
  pair("neutral", "positive"),
  pair("positive", "positive"),
  pair("positive", "positive"),
  pair("positive", "neutral"),
  pair("positive", "neutral"),
];

describe("bucketAt", () => {
  it("is identical to the production sentimentBucket at the shipped +/-0.1 band", () => {
    // The sweep is only meaningful if its t = 0.1 row is same as production.
    // Stepping finely across both boundaries would catch an off-by-one
    // comparison.
    for (let s = -1; s <= 1.0001; s += 0.005) {
      const score = Number(s.toFixed(4));
      expect(bucketAt(score, 0.1)).toBe(sentimentBucket(score));
    }
  });

  it("treats the band edges as neutral and widens with t", () => {
    expect(bucketAt(0.1, 0.1)).toBe("neutral");
    expect(bucketAt(-0.1, 0.1)).toBe("neutral");
    expect(bucketAt(0.2, 0.1)).toBe("positive");
    expect(bucketAt(0.2, 0.3)).toBe("neutral");
  });

  it("productionBucket never returns null for a numeric score", () => {
    expect(productionBucket(0.5)).toBe("positive");
    expect(productionBucket(0)).toBe("neutral");
  });
});

describe("confusionMatrix", () => {
  it("counts every actual/predicted cell, zero-filled", () => {
    const m = confusionMatrix(FIXTURE);
    expect(m.negative).toEqual({ negative: 3, neutral: 1, positive: 0 });
    expect(m.neutral).toEqual({ negative: 1, neutral: 2, positive: 1 });
    expect(m.positive).toEqual({ negative: 0, neutral: 2, positive: 2 });
  });
});

describe("classificationReport", () => {
  const report = classificationReport(FIXTURE);

  it("counts accuracy as the confusion diagonal", () => {
    expect(report.n).toBe(12);
    expect(report.accuracy).toBeCloseTo(7 / 12, 4);
  });

  it("computes per-class precision, recall and F1", () => {
    expect(report.perClass.negative).toEqual({ precision: 0.75, recall: 0.75, f1: 0.75, support: 4 });
    expect(report.perClass.neutral.precision).toBeCloseTo(0.4, 4);
    expect(report.perClass.neutral.recall).toBeCloseTo(0.5, 4);
    expect(report.perClass.neutral.f1).toBeCloseTo(4 / 9, 3);
    expect(report.perClass.positive.precision).toBeCloseTo(2 / 3, 3);
    expect(report.perClass.positive.recall).toBeCloseTo(0.5, 4);
    expect(report.perClass.positive.f1).toBeCloseTo(4 / 7, 3);
  });

  it("macro-averages F1 over the three classes", () => {
    expect(report.macroF1).toBeCloseTo((0.75 + 4 / 9 + 4 / 7) / 3, 3);
  });

  it("scores a class the model never predicts as zero rather than NaN", () => {
    const never = classificationReport([pair("positive", "neutral"), pair("neutral", "neutral")]);
    expect(never.perClass.positive).toEqual({ precision: 0, recall: 0, f1: 0, support: 1 });
    expect(Number.isNaN(never.macroF1)).toBe(false);
  });

  it("returns zeros for an empty set", () => {
    const empty = classificationReport([]);
    expect(empty.n).toBe(0);
    expect(empty.accuracy).toBe(0);
    expect(empty.macroF1).toBe(0);
  });
});

describe("thresholdSweep", () => {
  it("re-buckets the same scores at each band and marks no rows special", () => {
    const scored = [
      { label: "positive" as const, score: 0.12 },
      { label: "neutral" as const, score: 0.0 },
      { label: "negative" as const, score: -0.12 },
    ];
    const [narrow, wide] = thresholdSweep(scored, [0.1, 0.2]);
    // At +/-0.1 all three land in their true class; at +/-0.2 both poles collapse
    // to neutral, leaving only the neutral item correct.
    expect(narrow).toEqual({ t: 0.1, accuracy: 1, macroF1: 1 });
    expect(wide.accuracy).toBeCloseTo(1 / 3, 4);
  });
});

describe("pearson", () => {
  it("is 1 for a perfectly correlated series and -1 when inverted", () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
    expect(pearson([1, 2, 3], [-2, -4, -6])).toBeCloseTo(-1, 10);
  });

  it("returns null when a series has no variance or is too short", () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(pearson([1], [1])).toBeNull();
  });
});

describe("driftStats", () => {
  it("summarises known score pairs", () => {
    const pairs = [
      { base: 0.5, variant: 0.5 }, // no change
      { base: 0.5, variant: 0.2 }, // -0.3, still positive
      { base: 0.2, variant: -0.4 }, // -0.6, positive -> negative (flip)
      { base: -0.8, variant: 0.1 }, // +0.9, negative -> neutral (flip)
    ];
    const stats = driftStats(pairs);
    expect(stats.n).toBe(4);
    expect(stats.meanAbsDelta).toBeCloseTo(0.45, 4);
    expect(stats.maxAbsDelta).toBeCloseTo(0.9, 4);
    // signed deltas sorted: -0.6, -0.3, 0, 0.9 -> median (-0.3 + 0) / 2
    expect(stats.medianDelta).toBeCloseTo(-0.15, 4);
    expect(stats.flipRate).toBe(0.5);
    expect(stats.pearson).not.toBeNull();
  });

  it("counts a bucket change as a flip only when the production bucket moves", () => {
    // 0.5 -> 0.15 is a large delta but both are positive: not a flip.
    expect(driftStats([{ base: 0.5, variant: 0.15 }]).flipRate).toBe(0);
    // 0.11 -> 0.09 is a tiny delta that crosses the band: a flip.
    expect(driftStats([{ base: 0.11, variant: 0.09 }]).flipRate).toBe(1);
  });

  it("returns zeros for an empty set", () => {
    expect(driftStats([])).toEqual({
      n: 0,
      meanAbsDelta: 0,
      medianDelta: 0,
      maxAbsDelta: 0,
      flipRate: 0,
      pearson: null,
    });
  });
});
