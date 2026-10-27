import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  AFINN_PATH,
  afinnBucket,
  afinnReport,
  afinnScore,
  loadAfinn,
  majorityClassReport,
  majorityLabel,
  parseLexicon,
  tokenize,
} from "../../eval/baselines.js";
import { balancedAccuracyOfConfusion } from "../../eval/metrics.js";
import type { SentimentBucket } from "../../shared/types";

const raw = JSON.parse(readFileSync(AFINN_PATH, "utf8")) as Record<string, number>;

describe("the vendored AFINN-165 file", () => {
  // Known properties of the original AFINN-165 file. A mismatch means our copy
  // differs from it.
  it("is the complete published list", () => {
    const scores = Object.values(raw);
    expect(Object.keys(raw)).toHaveLength(3382);
    expect(Object.keys(raw).filter((t) => t.includes(" "))).toHaveLength(30);
    expect(scores.filter((s) => s < 0)).toHaveLength(2204);
    expect(scores.filter((s) => s > 0)).toHaveLength(1176);
    expect(scores.filter((s) => s === -2)).toHaveLength(1411);
    expect(Math.min(...scores)).toBe(-5);
    expect(Math.max(...scores)).toBe(5);
    expect(raw["naïve"]).toBe(-2);
  });

  it("loads the 3,352 single-word entries and drops every multi-word one", () => {
    const lexicon = loadAfinn();
    expect(lexicon.size).toBe(3352);
    expect(lexicon.has("not good")).toBe(false);
    expect(lexicon.get("good")).toBe(3);
  });
});

describe("parseLexicon", () => {
  it("rejects anything that is not a term -> integer score map", () => {
    expect(() => parseLexicon([])).toThrow(/JSON object/);
    expect(() => parseLexicon(null)).toThrow(/JSON object/);
    expect(() => parseLexicon({ good: "3" })).toThrow(/bad score for "good"/);
    expect(() => parseLexicon({ good: 2.5 })).toThrow(/bad score/);
    expect(() => parseLexicon({ good: 9 })).toThrow(/bad score/);
  });
});

describe("tokenize", () => {
  it("keeps accented letters whole", () => {
    // An ASCII split would give "na" + "ve" and miss the entry.
    expect(tokenize("A Naïve plan")).toEqual(["a", "naïve", "plan"]);
    expect(afinnScore("naïve")).toBeCloseTo(-2 / 5, 10);
  });

  it("splits on digits, punctuation and hyphens", () => {
    expect(tokenize("Ill-fated 2026 talks: 'good'!")).toEqual(["ill", "fated", "talks", "good"]);
  });
});

describe("afinnScore", () => {
  const lexicon = new Map([
    ["good", 3],
    ["bad", -3],
    ["disaster", -5],
  ]);

  it("averages over MATCHED tokens only, scaled by 5", () => {
    // One strong word in a long sentence is not diluted by its function words.
    expect(afinnScore("disaster", lexicon)).toBe(-1);
    expect(afinnScore("a disaster for the region, officials said on Tuesday", lexicon)).toBe(-1);
    expect(afinnScore("good and bad", lexicon)).toBe(0);
    expect(afinnScore("GOOD", lexicon)).toBeCloseTo(0.6, 10);
  });

  it("scores a sentence with no matched token as 0, which buckets neutral", () => {
    expect(afinnScore("parliament meets on tuesday", lexicon)).toBe(0);
    expect(afinnBucket("parliament meets on tuesday", lexicon)).toBe("neutral");
  });

  it("has no negation handling: the multi-word negations were dropped", () => {
    // "not good" was an AFINN entry at -2; without it, "good" wins.
    expect(afinnBucket("not good")).toBe("positive");
  });

  it("buckets at the production band", () => {
    // Mean 0.5 / 5 = 0.1: exactly on the band edge, which production calls neutral.
    const edge = new Map([["meh", 0.5]]);
    expect(afinnBucket("meh", edge)).toBe("neutral");
    expect(afinnBucket("good", lexicon)).toBe("positive");
    expect(afinnBucket("bad", lexicon)).toBe("negative");
  });
});

describe("afinnReport", () => {
  it("classifies each item's text against its label", () => {
    const report = afinnReport([
      { text: "a good day", label: "positive" },
      { text: "a terrible day", label: "negative" },
      { text: "the committee met", label: "neutral" },
      { text: "the committee met", label: "positive" },
    ]);
    expect(report.n).toBe(4);
    expect(report.accuracy).toBe(0.75);
    expect(report.confusion.positive.neutral).toBe(1);
  });
});

describe("majorityClassReport", () => {
  const balanced = (["negative", "neutral", "positive"] as SentimentBucket[]).flatMap((label) =>
    Array.from({ length: 100 }, () => ({ label })),
  );

  it("scores 0.3333 accuracy and 0.1667 macro-F1 on the balanced 100/100/100 sample", () => {
    const report = majorityClassReport(balanced);
    expect(Math.abs(report.accuracy - 0.3333)).toBeLessThan(1e-3);
    expect(Math.abs(report.macroF1 - 0.1667)).toBeLessThan(1e-3);
    // The predicted class: precision 1/3, recall 1, F1 0.5. The others are 0.
    expect(report.perClass.negative).toEqual({ precision: 0.3333, recall: 1, f1: 0.5, support: 100 });
    expect(report.perClass.neutral.f1).toBe(0);
  });

  it("predicts the most common label when the sample is not balanced", () => {
    const report = majorityClassReport([...balanced, { label: "positive" }]);
    expect(report.confusion.negative.positive).toBe(100);
    expect(report.perClass.positive.recall).toBe(1);
  });

  it("on an unbalanced 5 / 3 / 2 sample: accuracy is the majority share, balanced accuracy 1/3", () => {
    const items = (
      [
        ["negative", 5],
        ["neutral", 3],
        ["positive", 2],
      ] as const
    ).flatMap(([label, k]) => Array.from({ length: k }, () => ({ label })));
    expect(majorityLabel(items)).toBe("negative");
    const report = majorityClassReport(items);
    // The report rounds to 4 dp, so compare the rounded values.
    expect(report.accuracy).toBe(0.5);
    expect(report.balancedAccuracy).toBe(0.3333);
    // Negative: precision 0.5, recall 1, F1 2/3; the others 0.
    expect(report.macroF1).toBe(0.2222);
    expect(balancedAccuracyOfConfusion(report.confusion)).toBe(1 / 3);
  });

  it("breaks a tie towards the first label in BUCKETS", () => {
    expect(majorityLabel([{ label: "positive" }, { label: "neutral" }])).toBe("neutral");
  });
});
