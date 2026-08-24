// Dataset acquisition and normalization for the accuracy study.
//
// Source: NewsMTSC (Hamborg & Donnay, EACL 2021), the `rw` config's test split -
// real English news sentences with manually annotated, TARGET-dependent polarity.
// The HuggingFace dataset repo (fhamborg/news_sentiment_newsmtsc) is a loading
// SCRIPT, not data: the actual JSONL lives in the project's GitHub repo, which is
// what the script downloads. We fetch that same file, pinned to the same commit,
// so no `datasets` runtime and no HF token is needed.
//
// The map scores whole headlines, not targets, so target-level labels are folded
// into sentence-level ones: a sentence is kept only when EVERY annotated target in
// it carries the same polarity, and that polarity becomes the sentence's label.
// Sentences with disagreeing targets ("X attacks Y" - negative for Y, neutral for
// the platform) have no single sentence-level truth and are dropped.
import type { SentimentBucket } from "../shared/types.js";
import { cached } from "./cache.js";

export const NEWSMTSC_COMMIT = "6b838e00f54423c253806327a0ae24dbffa24c9e";
export const NEWSMTSC_URL =
  `https://raw.githubusercontent.com/fhamborg/NewsMTSC/${NEWSMTSC_COMMIT}` +
  `/NewsSentiment/experiments/default/datasets/newsmtsc-rw-hf/test.jsonl`;

// Fixed so the sample is reproducible across machines and re-runs; changing it
// changes which sentences are measured, which invalidates comparisons with
// previously committed results.
export const SAMPLE_SEED = 20260824;
export const DEFAULT_PER_CLASS = 100; // 3 classes -> ~300 items

// One annotated (sentence, target) pair as stored in the source JSONL.
export interface NewsmtscRow {
  mention: string;
  polarity: number;
  sentence: string;
  id: string;
}

// One sentence-level item after the target-agreement fold.
export interface LabelledItem {
  id: string;
  text: string;
  label: SentimentBucket;
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
export function parseRows(text: string): NewsmtscRow[] {
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
    });
  }
  return rows;
}

// The target-agreement filter. Insertion order is preserved so a given input file
// always yields the same item order before sampling.
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
    items.push({ id: group[0].id, text: sentence, label });
  }
  return items;
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
  return picked.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

// Downloads (once, then from cache) and folds the dataset to sentence level.
export async function loadDataset(cacheDir: string): Promise<LabelledItem[]> {
  const text = await cached(cacheDir, "dataset:newsmtsc-rw-test", NEWSMTSC_URL, async () => {
    const res = await fetch(NEWSMTSC_URL);
    if (!res.ok) throw new Error(`dataset download failed: HTTP ${res.status}`);
    return res.text();
  });
  return toSentenceLabels(parseRows(text));
}

// The accuracy study's sample. `perClass` is lowered by --limit.
export async function loadAccuracySample(
  cacheDir: string,
  perClass = DEFAULT_PER_CLASS,
): Promise<LabelledItem[]> {
  const items = await loadDataset(cacheDir);
  return stratifiedSample(items, perClass, SAMPLE_SEED);
}
