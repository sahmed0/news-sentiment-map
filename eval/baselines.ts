// Simple baselines that give the model's accuracy something to be compared with.
// Majority class (1/3 balanced accuracy by construction) is too weak to say much
// on its own, so a word list is used as well.
//
// AFINN-165 (eval/data-static/afinn-165.json, licence and citation in
// eval/data-static/README.md). VADER suits news text better, but its rules
// would have to be ported by hand; AFINN is plain data, so less can go wrong.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SentimentBucket } from "../shared/types.js";
import { BUCKETS, bucketAt, classificationReport, type ClassificationReport } from "./metrics.js";

export const AFINN_PATH = fileURLToPath(new URL("./data-static/afinn-165.json", import.meta.url));

// AFINN scores are integers in [-5, 5].
const AFINN_MAX = 5;
// The production neutral band (src/lib/sentiment.ts), so the baseline and the
// model are bucketed by the same rule.
const PRODUCTION_BAND = 0.1;

// Checks the file rather than trusting it, so a damaged copy fails here instead
// of quietly scoring every sentence 0.
export function parseLexicon(raw: unknown): Map<string, number> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("AFINN lexicon: expected a JSON object of term -> score");
  }
  const lexicon = new Map<string, number>();
  for (const [term, score] of Object.entries(raw)) {
    if (typeof score !== "number" || !Number.isInteger(score) || Math.abs(score) > AFINN_MAX) {
      throw new Error(`AFINN lexicon: bad score for "${term}"`);
    }
    // Skip the 30 multi-word entries rather than matching phrases. Five of them are
    // negations ("not good", "can't stand", ...), so this baseline has no negation
    // handling at all. That is typical of a plain word list, and one reason VADER
    // would be a stronger comparison.
    if (term.includes(" ")) continue;
    lexicon.set(term, score);
  }
  return lexicon;
}

let afinn: Map<string, number> | null = null;

// Read on first use, so importing this module for its types costs nothing.
export function loadAfinn(): Map<string, number> {
  afinn ??= parseLexicon(JSON.parse(readFileSync(AFINN_PATH, "utf8")));
  return afinn;
}

// Splits on anything that isn't a letter in any alphabet, so `naïve` stays one
// word. Known gap: the 28 entries with a hyphen or digit ("well-being", "gr8")
// can never match.
export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
}

// Average score of the words found in the list, scaled to [-1, 1]. Averaging over
// found words only means one strong word isn't watered down by "the", "of" and so
// on, which would push longer sentences towards neutral. No matches scores 0.
export function afinnScore(text: string, lexicon: Map<string, number> = loadAfinn()): number {
  let sum = 0;
  let matched = 0;
  for (const token of tokenize(text)) {
    const score = lexicon.get(token);
    if (score === undefined) continue;
    sum += score;
    matched += 1;
  }
  return matched ? sum / matched / AFINN_MAX : 0;
}

export const afinnBucket = (text: string, lexicon?: Map<string, number>): SentimentBucket =>
  bucketAt(afinnScore(text, lexicon), PRODUCTION_BAND);

// Always uses the production band: tuning it for the baseline would skew the
// comparison.
export function afinnReport(
  items: readonly { text: string; label: SentimentBucket }[],
  lexicon?: Map<string, number>,
): ClassificationReport {
  return classificationReport(
    items.map((it) => ({ actual: it.label, predicted: afinnBucket(it.text, lexicon) })),
  );
}

// The most common label (ties go to the first in BUCKETS).
export function majorityLabel(items: readonly { label: SentimentBucket }[]): SentimentBucket {
  const counts = BUCKETS.map((label) => items.filter((it) => it.label === label).length);
  return BUCKETS[counts.indexOf(Math.max(...counts))];
}

// Predicts the majority label for every item. Its balanced accuracy is always 1/3
// by construction; its accuracy is that class's share of the sample.
export function majorityClassReport(
  items: readonly { label: SentimentBucket }[],
): ClassificationReport {
  const majority = majorityLabel(items);
  return classificationReport(items.map((it) => ({ actual: it.label, predicted: majority })));
}
