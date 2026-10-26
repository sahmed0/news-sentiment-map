// Dataset acquisition and normalization for both studies.
//
// Source: NewsMTSC (Hamborg & Donnay, EACL 2021), all three splits (test, dev,
// train) of the `rw` config - real English news sentences with manually
// annotated, TARGET-dependent polarity. The HuggingFace dataset repo
// (fhamborg/news_sentiment_newsmtsc) is a loading SCRIPT, not data: the actual
// JSONL lives in the project's GitHub repo, which is what the script downloads.
// We fetch those same files, pinned to the same commit, so no `datasets` runtime
// and no HF token is needed.
//
// The map scores whole headlines, not targets, so target-level labels are folded
// into sentence-level ones: a sentence is kept only when EVERY annotated target in
// it carries the same polarity, and that polarity becomes the sentence's label.
// Sentences with disagreeing targets ("X attacks Y" - negative for Y, neutral for
// the platform) have no single sentence-level truth and are dropped. The splits
// are concatenated before that fold, so a sentence found in two splits is judged
// on all of its rows: kept once if they agree, dropped if they contradict.
// Finally, any item too long for the model to accept is dropped (MAX_TEXT_CHARS).
import type { SentimentBucket } from "../shared/types.js";
import { cached } from "./cache.js";

export const NEWSMTSC_COMMIT = "6b838e00f54423c253806327a0ae24dbffa24c9e";

// The order is load-bearing: it decides which row represents a sentence found in
// more than one split, and loading test first keeps the test split's existing
// cache entry exactly as they were.
export const NEWSMTSC_SPLITS = ["test", "dev", "train"] as const;
export type NewsmtscSplit = (typeof NEWSMTSC_SPLITS)[number];

const NEWSMTSC_BASE =
  `https://raw.githubusercontent.com/fhamborg/NewsMTSC/${NEWSMTSC_COMMIT}` +
  `/NewsSentiment/experiments/default/datasets/newsmtsc-rw-hf`;

export const NEWSMTSC_URLS: Record<NewsmtscSplit, string> = {
  test: `${NEWSMTSC_BASE}/test.jsonl`,
  dev: `${NEWSMTSC_BASE}/dev.jsonl`,
  train: `${NEWSMTSC_BASE}/train.jsonl`,
};

// The model reads at most 512 tokens, and HuggingFace rejects a longer input
// outright (HTTP 400) rather than truncating it. One `rw` item is a 6,321-character
// list of names the dataset's sentence splitter left whole (~1,300 tokens); the
// longest real sentence is 1,397 characters. This limit sits well between them.
export const MAX_TEXT_CHARS = 2000;

// Fixed so every result is reproducible across machines and re-runs. It drives
// the drift draw, every bootstrap and --limit sampling, so changing it changes
// which sentences are measured and every interval.
export const EVAL_SEED = 20260824;

// One annotated (sentence, target) pair as stored in the source JSONL.
export interface NewsmtscRow {
  mention: string;
  polarity: number;
  sentence: string;
  id: string;
  split: NewsmtscSplit;
}

// One sentence-level item after the target-agreement fold.
export interface LabelledItem {
  id: string;
  text: string;
  label: SentimentBucket;
  split: NewsmtscSplit;
}

// The folded pool, plus what the output needs to describe how it was built.
export interface Pool {
  items: LabelledItem[];
  rows: Record<NewsmtscSplit, number>;
  crossSplit: { sentences: number; kept: number; dropped: number };
  overlong: number; // items dropped for exceeding MAX_TEXT_CHARS
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// NewsMTSC encodes polarity as -1 / 0 / 1.
export function polarityToLabel(polarity: number): SentimentBucket | null {
  if (polarity === -1) return "negative";
  if (polarity === 0) return "neutral";
  if (polarity === 1) return "positive";
  return null;
}

// Parse the JSONL defensively: a malformed or unexpectedly-shaped line is skipped
// rather than aborting a download we already paid the wall-clock for.
export function parseRows(text: string, split: NewsmtscSplit): NewsmtscRow[] {
  const rows: NewsmtscRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const { mention, polarity, sentence, id } = parsed;
    if (typeof sentence !== "string" || !sentence.trim()) continue;
    if (typeof polarity !== "number" || polarityToLabel(polarity) === null) continue;
    rows.push({
      mention: typeof mention === "string" ? mention : "",
      polarity,
      sentence,
      id: typeof id === "string" ? id : sentence,
      split,
    });
  }
  return rows;
}

// The target-agreement filter. Insertion order is preserved so a given input file
// always yields the same item order before sampling. Given the test -> dev ->
// train concatenation, a sentence found in several splits is represented by the
// first row of its earliest split.
export function toSentenceLabels(rows: NewsmtscRow[]): LabelledItem[] {
  const bySentence = new Map<string, NewsmtscRow[]>();
  for (const row of rows) {
    const group = bySentence.get(row.sentence);
    if (group) group.push(row);
    else bySentence.set(row.sentence, [row]);
  }
  const items: LabelledItem[] = [];
  for (const [sentence, group] of bySentence) {
    const first = group[0].polarity;
    if (!group.every((r) => r.polarity === first)) continue; // no single truth
    const label = polarityToLabel(first);
    if (!label) continue;
    items.push({ id: group[0].id, text: sentence, label, split: group[0].split });
  }
  return items;
}

// Plain code-unit comparison, not the locale-aware string compare: that depends
// on the machine's ICU locale, so a "reproducible" sample could in principle
// differ between machines.
const codeUnitCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Label, then id. The labels sort negative < neutral < positive either way.
export function compareItems(a: LabelledItem, b: LabelledItem): number {
  return codeUnitCompare(a.label, b.label) || codeUnitCompare(a.id, b.id);
}

// Small deterministic PRNG (mulberry32) - avoids a dependency and keeps the
// sample identical on every machine for a given seed.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Up to `perClass` items of each label, seeded. A class with fewer items than
// requested contributes all it has (the fixture used by --dry-run has ~4 per
// class), so the harness degrades to a smaller balanced sample rather than
// failing. Output is sorted by label then id for a stable, diffable order.
//
// The input must already be in a deterministic order, because each class is
// filtered in input order before it is shuffled. loadPool guarantees that.
export function stratifiedSample(
  items: readonly LabelledItem[],
  perClass: number,
  seed: number,
): LabelledItem[] {
  const rand = mulberry32(seed);
  const picked: LabelledItem[] = [];
  for (const label of ["negative", "neutral", "positive"] as const) {
    const pool = items.filter((it) => it.label === label);
    picked.push(...shuffled(pool, rand).slice(0, perClass));
  }
  return picked.sort(compareItems);
}

// How many sentences span more than one split, and how many of those survived
// the fold (the rest had contradicting polarity across splits).
export function summariseCrossSplit(
  rows: readonly NewsmtscRow[],
  items: readonly LabelledItem[],
): Pool["crossSplit"] {
  const splitsBySentence = new Map<string, Set<NewsmtscSplit>>();
  for (const row of rows) {
    const splits = splitsBySentence.get(row.sentence);
    if (splits) splits.add(row.split);
    else splitsBySentence.set(row.sentence, new Set([row.split]));
  }
  const keptTexts = new Set(items.map((it) => it.text));
  let sentences = 0;
  let kept = 0;
  for (const [sentence, splits] of splitsBySentence) {
    if (splits.size < 2) continue;
    sentences += 1;
    if (keptTexts.has(sentence)) kept += 1;
  }
  return { sentences, kept, dropped: sentences - kept };
}

// Cluster keys for the resampling sensitivity check. NewsMTSC does not document
// its id format; these field meanings are inferred from its structure:
//   polusa_v1_<article>_-1_<sentence>_<mention>_<from>_<to>
//   allsides_<article>_<story>_<sentence>_<mention>_<from>_<to>
// Each AllSides article maps to one story, and a story groups several articles.
// Any other id (fixture fallbacks, a future format) is its own cluster.
const POLUSA_ID = /^polusa_v1_(\d+)_/;
const ALLSIDES_ID = /^allsides_(\d+)_(\d+)_/;

export function articleKey(id: string): string {
  const polusa = POLUSA_ID.exec(id);
  if (polusa) return `polusa_v1_${polusa[1]}`;
  const allsides = ALLSIDES_ID.exec(id);
  if (allsides) return `allsides_${allsides[1]}_${allsides[2]}`;
  return id;
}

export function storyKey(id: string): string {
  const polusa = POLUSA_ID.exec(id);
  if (polusa) return `polusa_v1_${polusa[1]}`;
  const allsides = ALLSIDES_ID.exec(id);
  if (allsides) return `allsides_story_${allsides[2]}`;
  return id;
}

// Downloads every split (once, then from cache), folds them together to sentence
// level and returns the pool in compareItems order.
export async function loadPool(cacheDir: string, offline = false): Promise<Pool> {
  const rows: NewsmtscRow[] = [];
  const rowCounts = {} as Record<NewsmtscSplit, number>;
  for (const split of NEWSMTSC_SPLITS) {
    const url = NEWSMTSC_URLS[split];
    // For test, this task string and the bare-URL payload are the key the
    // single-split eval used, so the already-cached test file is still a hit.
    const text = await cached(
      cacheDir,
      `dataset:newsmtsc-rw-${split}`,
      url,
      async () => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`dataset download failed (${split}): HTTP ${res.status}`);
        return res.text();
      },
      { offline },
    );
    const parsed = parseRows(text, split);
    rowCounts[split] = parsed.length;
    rows.push(...parsed);
  }
  const folded = toSentenceLabels(rows).sort(compareItems);
  // The cross-split summary describes the fold, so it is taken before the length
  // filter.
  const crossSplit = summariseCrossSplit(rows, folded);
  const { kept, dropped } = dropOverlong(folded);
  return { items: kept, rows: rowCounts, crossSplit, overlong: dropped };
}

// Removes items too long for the model to score (see MAX_TEXT_CHARS), keeping
// the rest in order.
export function dropOverlong(items: readonly LabelledItem[]): { kept: LabelledItem[]; dropped: number } {
  const kept = items.filter((it) => it.text.length <= MAX_TEXT_CHARS);
  return { kept, dropped: items.length - kept.length };
}
