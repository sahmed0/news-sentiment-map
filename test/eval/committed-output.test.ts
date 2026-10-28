// The committed results in eval/out/ are internally consistent and reproducible:
// every interval is recomputed here from the committed files alone, with no
// cache or network.
//
// It only runs when eval/out/ holds format-2 output (the full-pool study), and
// skips every case otherwise.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { articleKey, storyKey } from "../../eval/datasets.js";
import { languageDrift, pairwiseFlipDiffs } from "../../eval/drift.js";
import {
  confusionMatrix,
  productionBucket,
  type AccuracyItemRecord,
  type AccuracyResult,
  type DriftItemRecord,
  type DriftResult,
} from "../../eval/metrics.js";
import { accuracyIntervals, clusterIntervals, sweepMargins } from "../../eval/stats.js";

const readOut = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../eval/out/${name}`, import.meta.url)), "utf8"));

// The one file that exists in both formats; skipIf needs it at collection time.
// The others exist only in format 2, so they are read in beforeAll.
const accuracy = readOut("accuracy.json") as AccuracyResult;

describe.skipIf(accuracy.formatVersion !== 2)("committed eval/out", { timeout: 120_000 }, () => {
  let drift: DriftResult;
  let accuracyItems: AccuracyItemRecord[];
  let driftItems: DriftItemRecord[];

  beforeAll(() => {
    drift = readOut("drift.json") as DriftResult;
    accuracyItems = readOut("accuracy-items.json") as AccuracyItemRecord[];
    driftItems = readOut("drift-items.json") as DriftItemRecord[];
  });

  const scoredItems = (): (AccuracyItemRecord & { score: number })[] =>
    accuracyItems.filter((it): it is AccuracyItemRecord & { score: number } => it.score !== null);

  it("the item file rebuilds the confusion matrix", () => {
    expect(accuracyItems).toHaveLength(accuracy.n + accuracy.unscored);
    const pairs = scoredItems().map((it) => ({ actual: it.label, predicted: productionBucket(it.score) }));
    expect(confusionMatrix(pairs)).toEqual(accuracy.production.confusion);
  });

  it("the headline intervals follow from the confusion matrix alone", () => {
    expect(accuracyIntervals(accuracy.production, { seed: accuracy.bootstrap.seed })).toEqual(accuracy.intervals);
  });

  it("the clustering check follows from the item file", () => {
    const items = (key: (id: string) => string) =>
      scoredItems().map((it) => ({ cluster: key(it.id), actual: it.label, predicted: productionBucket(it.score) }));
    const seed = accuracy.bootstrap.seed;
    expect({
      article: clusterIntervals(items(articleKey), { seed }),
      story: clusterIntervals(items(storyKey), { seed }),
    }).toEqual(accuracy.clusterCheck);
  });

  it("the splits add up, and a full run covers the whole pool", () => {
    const splitN = Object.values(accuracy.perSplit).reduce((sum, s) => sum + s.report.n, 0);
    expect(splitN).toBe(accuracy.n);
    if (accuracy.sample.kind === "full") expect(accuracy.dataset.size).toBe(accuracy.n + accuracy.unscored);
  });

  it("every drift statistic follows from the drift item file", () => {
    const seed = drift.bootstrap.seed;
    const languages = Object.keys(drift.languages);
    for (const lang of languages) {
      // The rounded shares from the JSON are what the run itself passed.
      expect(languageDrift(driftItems, lang, { seed, poolShares: drift.sample.poolShares })).toEqual(
        drift.languages[lang],
      );
    }
    expect(pairwiseFlipDiffs(driftItems, languages, { seed }).pairs).toEqual(drift.pairwise);
  });

  it("the sweep margins follow from the accuracy item file", () => {
    const thresholds = accuracy.thresholdSweep.map((r) => r.t);
    const shipped = accuracy.thresholdSweep.find((r) => r.vsShipped === null)?.t;
    expect(shipped).toBeDefined();
    const scored = scoredItems().map((it) => ({ label: it.label, score: it.score }));
    expect(sweepMargins(scored, thresholds, shipped ?? NaN, { seed: accuracy.bootstrap.seed })).toEqual(
      accuracy.thresholdSweep.map((r) => r.vsShipped),
    );
  });
});
