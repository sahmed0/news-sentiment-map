import { describe, it, expect } from "vitest";
import { languageDrift, pairwiseFlipDiffs } from "../../eval/drift.js";
import type { DriftItemRecord } from "../../eval/metrics.js";
import type { SentimentBucket } from "../../shared/types";

const record = (
  id: string,
  label: SentimentBucket,
  base: number | null,
  variants: Record<string, number | null>,
): DriftItemRecord => ({ id, split: "test", label, base, variants });

// Production buckets at +/-0.1, so a flip is any move across that band.
const RECORDS: DriftItemRecord[] = [
  record("n1", "negative", -0.5, { fr: -0.5, de: 0.0 }), // fr same, de flips
  record("n2", "negative", -0.5, { fr: 0.0, de: 0.0 }), // both flip
  record("u1", "neutral", 0.0, { fr: 0.5, de: 0.0 }), // fr flips
  record("u2", "neutral", 0.0, { fr: 0.05, de: 0.05 }), // neither
  record("p1", "positive", 0.5, { fr: 0.4, de: 0.4 }), // neither
  record("p2", "positive", 0.5, { fr: null, de: 0.4 }), // fr unscored: dropped for fr
];

const SHARES = { negative: 0.5, neutral: 0.3, positive: 0.2 };

describe("languageDrift", () => {
  const fr = languageDrift(RECORDS, "fr", { b: 200, seed: 1, poolShares: SHARES });

  it("counts flips over the items both scores exist for", () => {
    expect(fr.n).toBe(5);
    expect(fr.flips).toBe(2);
    expect(fr.flipRate).toBe(0.4);
  });

  it("breaks the flips down by true class", () => {
    expect(fr.perClass.negative).toMatchObject({ n: 2, flips: 1, flipRate: 0.5 });
    expect(fr.perClass.neutral).toMatchObject({ n: 2, flips: 1, flipRate: 0.5 });
    expect(fr.perClass.positive).toMatchObject({ n: 1, flips: 0, flipRate: 0 });
  });

  it("re-weights the per-class rates to the pool's class mix", () => {
    // 0.5 x 0.5 + 0.3 x 0.5 + 0.2 x 0
    expect(fr.poolWeightedFlipRate).toBe(0.4);
    expect(fr.poolWeightedFlipRateCI[0]).toBeLessThanOrEqual(0.4);
    expect(fr.poolWeightedFlipRateCI[1]).toBeGreaterThanOrEqual(0.4);
  });

  it("puts an interval around the mean |delta|", () => {
    const [lo, hi] = fr.meanAbsDeltaCI;
    expect(lo).toBeLessThanOrEqual(fr.meanAbsDelta);
    expect(hi).toBeGreaterThanOrEqual(fr.meanAbsDelta);
  });
});

describe("pairwiseFlipDiffs", () => {
  it("compares every pair once, in language order, with a Bonferroni alpha", () => {
    const langs = ["fr", "de", "ar", "ja", "pt"];
    const records = RECORDS.map((r) => ({ ...r, variants: Object.fromEntries(langs.map((l) => [l, r.variants.fr ?? 0])) }));
    const { pairs, adjustedAlpha } = pairwiseFlipDiffs(records, langs, { b: 100, seed: 1 });
    expect(pairs.map((p) => `${p.a}-${p.b}`)).toEqual([
      "fr-de", "fr-ar", "fr-ja", "fr-pt", "de-ar", "de-ja", "de-pt", "ar-ja", "ar-pt", "ja-pt",
    ]);
    expect(adjustedAlpha).toBe(0.005);
  });

  it("pairs each comparison on the items both languages scored", () => {
    const { pairs } = pairwiseFlipDiffs(RECORDS, ["fr", "de"], { b: 200, seed: 1 });
    expect(pairs).toHaveLength(1);
    const [p] = pairs;
    // p2 has no fr score, so 5 items; fr flips n2 and u1, de flips n1 and n2.
    expect(p).toMatchObject({ a: "fr", b: "de", n: 5, diff: 0 });
    expect(p.adjustedCI[0]).toBeLessThanOrEqual(p.ci[0]);
    expect(p.adjustedCI[1]).toBeGreaterThanOrEqual(p.ci[1]);
  });

  it("returns no pairs and no alpha for a single language", () => {
    expect(pairwiseFlipDiffs(RECORDS, ["fr"], { seed: 1 })).toEqual({ pairs: [], adjustedAlpha: null });
  });
});
