// Assembles the drift study's statistics from its per-item records. Pure, so the
// committed drift-items.json alone reproduces every drift number.
//
// The study asks whether routing a sentence through the production translation
// pivot (English -> language -> English) changes its score. Beyond the overall
// flip rate per language:
//   - per class, because the sample is drawn balanced and a language may drift
//     more on, say, neutral sentences than negative ones;
//   - pool-weighted, re-weighting those per-class rates to the dataset's class
//     mix, since a balanced sample is not what the map sees;
//   - pairwise, a paired bootstrap of each language pair's difference on the
//     same sentences. With ten pairs, one language will look worst by chance
//     alone, so a difference counts as established only when its
//     Bonferroni-adjusted interval excludes zero.
import type { SentimentBucket } from "../shared/types.js";
import {
  BUCKETS,
  driftStats,
  productionBucket,
  roundInterval,
  type DriftItemRecord,
  type LanguageDrift,
  type PairwiseFlipDiff,
} from "./metrics.js";
import { meanAbsDeltaCI, pairedRateDifference, poolWeightedRate, wilson } from "./stats.js";

const round4 = (v: number): number => Number(v.toFixed(4));

const isFlip = (base: number, variant: number): boolean =>
  productionBucket(base) !== productionBucket(variant);

interface ScoredPair {
  label: SentimentBucket;
  base: number;
  variant: number;
}

// The records where both the direct score and this language's score exist.
function pairsFor(records: readonly DriftItemRecord[], lang: string): ScoredPair[] {
  const pairs: ScoredPair[] = [];
  for (const r of records) {
    const variant = r.variants[lang];
    if (typeof r.base === "number" && typeof variant === "number") {
      pairs.push({ label: r.label, base: r.base, variant });
    }
  }
  return pairs;
}

export function languageDrift(
  records: readonly DriftItemRecord[],
  lang: string,
  { b, seed, poolShares }: { b?: number; seed: number; poolShares: Record<SentimentBucket, number> },
): LanguageDrift {
  const pairs = pairsFor(records, lang);
  const stats = driftStats(pairs);

  const flagsByClass = {} as Record<SentimentBucket, boolean[]>;
  const perClass = {} as LanguageDrift["perClass"];
  for (const label of BUCKETS) {
    const flags = pairs.filter((p) => p.label === label).map((p) => isFlip(p.base, p.variant));
    flagsByClass[label] = flags;
    const flips = flags.filter(Boolean).length;
    perClass[label] = {
      n: flags.length,
      flips,
      flipRate: flags.length ? round4(flips / flags.length) : 0,
      flipRateCI: roundInterval(wilson(flips, flags.length)),
    };
  }
  const weighted = poolWeightedRate(flagsByClass, poolShares, { b, seed });

  return {
    ...stats,
    meanAbsDeltaCI: meanAbsDeltaCI(pairs.map((p) => p.variant - p.base), { b, seed }),
    perClass,
    poolWeightedFlipRate: weighted.rate,
    poolWeightedFlipRateCI: weighted.ci,
  };
}

// Every unordered pair (languages[i], languages[j]) with i < j, in that order,
// over the records both languages scored.
export function pairwiseFlipDiffs(
  records: readonly DriftItemRecord[],
  languages: readonly string[],
  { b, seed }: { b?: number; seed: number },
): { pairs: PairwiseFlipDiff[]; adjustedAlpha: number | null } {
  const m = (languages.length * (languages.length - 1)) / 2;
  if (!m) return { pairs: [], adjustedAlpha: null };
  const adjustedAlpha = 0.05 / m;
  const pairs: PairwiseFlipDiff[] = [];
  for (let i = 0; i < languages.length; i++) {
    for (let j = i + 1; j < languages.length; j++) {
      const a = languages[i];
      const other = languages[j];
      const xs: boolean[] = [];
      const ys: boolean[] = [];
      for (const r of records) {
        const va = r.variants[a];
        const vb = r.variants[other];
        if (typeof r.base !== "number" || typeof va !== "number" || typeof vb !== "number") continue;
        xs.push(isFlip(r.base, va));
        ys.push(isFlip(r.base, vb));
      }
      pairs.push({ a, b: other, ...pairedRateDifference(xs, ys, { b, seed, adjustedAlpha }) });
    }
  }
  return { pairs, adjustedAlpha };
}
