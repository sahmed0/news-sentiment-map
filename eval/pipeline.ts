// Thin wrappers around the PRODUCTION scoring and translation functions, so the
// eval measures the code the map actually runs - the real batching, the
// `top_k: null` response parsing, the retry/backoff behavior - rather than a
// reimplementation that could be quietly kinder to the model than reality.
//
// The only thing implemented here is the English -> other-language direction
// (`translateTo`), which production never needs: the map only ever translates
// INTO English. It calls the same Azure endpoint with the same credentials.
//
// Where this deliberately diverges from production: production treats a failed
// Azure call as a degraded-but-acceptable outcome (empty translation -> null
// score -> that country simply goes unscored today). An eval cannot do that. A
// dropped item here does not show up as a gap, it shows up as a *smaller sample
// that still reports a number* - so every wrapper below throws instead.
import {
  HF_ENGLISH_MODEL,
  FETCH_TIMEOUT_MS,
  parseRetryAfter,
  scoreInChunks,
  translateAll,
} from "../api/_lib/sentiment-fetch.js";
import { cached } from "./cache.js";

// Mirrors the production HF_BATCH_SIZE / AZURE_BATCH_SIZE (both module-private).
// Chunking here rather than letting the production helpers do it internally is
// what makes each request individually cacheable and rate-limitable.
export const HF_BATCH = 50;
export const AZURE_BATCH = 100;
// Courtesy gap between HuggingFace batches, so a long run cannot look like a
// burst to the inference router. Zero under --dry-run.
export const HF_GAP_MS = 2000;
// Minimum spacing between Azure requests. Secondary to the character limiter
// below - it just stops two requests landing in the same instant.
export const AZURE_GAP_MS = 1000;

// Azure's ceiling is measured in CHARACTERS, not requests. The F0 tier allows
// 2M characters/hour (also 2M characters/month total),
// and Microsoft's own guidance is that the hourly quota must
// be consumed evenly - "no faster than roughly 33,300 characters per minute",
// enforced as a sliding window. A 99-headline batch is ~16K characters, so the
// out-and-back legs of a single language (~32K) breach it on their own. That is
// exactly how the second live run failed, ~2 seconds in, despite a per-request
// gap: the gap was in the wrong unit.
//
// Default to 30,000 for headroom.
export const AZURE_DEFAULT_CHARS_PER_MINUTE = 30000;
const RATE_WINDOW_MS = 60000;

// Azure retry budget. The backoff base is deliberately much larger than the HF
// one: a character-rate 429 clears only as the sliding window drains, so a 4s
// retry would simply fail again.
export const AZURE_MAX_RETRIES = 3;
export const AZURE_BACKOFF_BASE_MS = 15000;
export const AZURE_MAX_BACKOFF_MS = 65000;

export interface PipelineOptions {
  cacheDir: string;
  gapMs: number;
  azureGapMs: number;
}

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

// Scores English text through the production path. One cache entry per batch,
// keyed by the model URL and the exact texts, so a resumed run re-scores nothing.
export async function scoreEnglish(
  texts: readonly string[],
  opts: PipelineOptions,
): Promise<(number | null)[]> {
  const scores: (number | null)[] = [];
  const batches = chunk(texts, HF_BATCH);
  for (let i = 0; i < batches.length; i++) {
    if (i > 0) await sleep(opts.gapMs);
    const batch = batches[i];
    const batchScores = await cached<(number | null)[]>(
      opts.cacheDir,
      "hf:score",
      { model: HF_ENGLISH_MODEL, texts: batch },
      () => scoreInChunks(HF_ENGLISH_MODEL, [...batch]),
    );
    scores.push(...batchScores);
  }
  return scores;
}

function charBudget(): number {
  const raw = Number(process.env.AZURE_CHARS_PER_MINUTE);
  return Number.isFinite(raw) && raw > 0 ? raw : AZURE_DEFAULT_CHARS_PER_MINUTE;
}

// Sliding-window character ledger, shared by BOTH Azure legs and the preflight -
// Azure meters the resource, not the code path, so a per-function limiter would
// not see half its own traffic.
let azureSent: { at: number; chars: number }[] = [];

// Exported for tests, which must not inherit another case's window.
export function resetAzureRateLimit(): void {
  azureSent = [];
}

// Blocks until `chars` more can be sent without breaching the window, then
// records them. Called before every Azure request.
async function reserveAzureChars(chars: number): Promise<void> {
  const budget = charBudget();
  for (;;) {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    azureSent = azureSent.filter((entry) => entry.at > cutoff);
    const used = azureSent.reduce((sum, entry) => sum + entry.chars, 0);
    // The second clause lets a single oversized batch through rather than
    // deadlocking on a budget it can never fit inside.
    if (used + chars <= budget || azureSent.length === 0) break;
    const wait = Math.max(azureSent[0].at + RATE_WINDOW_MS - Date.now(), 250);
    console.log(
      `[Azure] pacing: ${used}+${chars} characters would exceed ${budget}/min - waiting ${Math.ceil(wait / 1000)}s`,
    );
    await sleep(wait);
  }
  azureSent.push({ at: Date.now(), chars });
}

const countChars = (texts: readonly string[]): number =>
  texts.reduce((sum, t) => sum + t.length, 0);

// Reads one `.text` off an Azure Translator result document.
function azureText(doc: unknown): string | null {
  if (typeof doc !== "object" || doc === null) return null;
  const translations = (doc as { translations?: unknown }).translations;
  if (!Array.isArray(translations) || translations.length === 0) return null;
  const first: unknown = translations[0];
  if (typeof first !== "object" || first === null) return null;
  const text = (first as { text?: unknown }).text;
  return typeof text === "string" ? text : null;
}

// EVAL-ONLY Azure call, used for the English -> language leg and the preflight.
// Production's translateHeadlines has no retry loop at all
// and degrades to null instead; this cannot, so it
// retries 429/503 with backoff and then throws.
async function azureTranslate(batch: readonly string[], to: string): Promise<string[]> {
  const headers: Record<string, string> = {
    "Ocp-Apim-Subscription-Key": process.env.AZURE_TRANSLATOR_KEY ?? "",
    "Content-Type": "application/json",
  };
  // Regional (non-Global) Translator resources reject the key without this.
  if (process.env.AZURE_TRANSLATOR_REGION) {
    headers["Ocp-Apim-Subscription-Region"] = process.env.AZURE_TRANSLATOR_REGION;
  }

  for (let attempt = 0; ; attempt++) {
    await reserveAzureChars(countChars(batch));
    const res = await fetch(
      `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${to}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(batch.map((t) => ({ Text: t }))),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    const body = await res.text().catch(() => "");

    if (!res.ok) {
      // 429 is a rate limit, 503 a transient backend blip - both are worth
      // waiting out. Anything else (401 bad key, 403 quota) will not improve
      // with time, so fail immediately rather than sleeping three times first.
      const transient = res.status === 429 || res.status === 503;
      if (transient && attempt < AZURE_MAX_RETRIES) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        const wait = Math.min(
          AZURE_MAX_BACKOFF_MS,
          retryAfter ?? AZURE_BACKOFF_BASE_MS * 2 ** attempt,
        );
        console.warn(
          `[Azure] to-${to}: HTTP ${res.status} - retrying in ${wait}ms (attempt ${attempt + 1}/${AZURE_MAX_RETRIES})`,
        );
        await sleep(wait);
        continue;
      }
      throw new Error(`Azure translate to ${to}: HTTP ${res.status} ${body.slice(0, 200)}`);
    }

    const parsed: unknown = JSON.parse(body);
    if (!Array.isArray(parsed) || parsed.length !== batch.length) {
      throw new Error(`Azure translate to ${to}: unexpected response shape`);
    }
    return parsed.map((doc, i) => {
      const text = azureText(doc);
      if (text === null) throw new Error(`Azure translate to ${to}: missing text for item ${i}`);
      return text;
    });
  }
}

// One 1-document translation, uncached, before the drift study spends anything.
// A rate-limited or mis-keyed Azure resource then fails in about a second rather
// than after the accuracy task and a whole language of round trips.
export async function preflightAzure(): Promise<void> {
  await azureTranslate(["The quick brown fox."], "fr");
}

// One attempt at the production inbound path, with the degrade detected.
//
// translateAll swallows Azure failures by substituting "" (correct for the map:
// the headline just goes unscored). For the eval that substitution is bad -
// empty strings score null, null scores get dropped from the comparison, and the
// language then reports drift statistics computed over zero pairs, which implies 
// "this language causes no drift". An empty result for a non-empty input is
// therefore treated as the failure signal it is.
//
// It also means production's own error handling gives us no status code to
// branch on, so every degrade is retried rather than only the transient ones. In
// practice the only thing that produces it is a 429, a 5xx or a timeout.
async function translateAllChecked(batch: readonly string[]): Promise<string[]> {
  for (let attempt = 0; ; attempt++) {
    await reserveAzureChars(countChars(batch));
    const result = await translateAll([...batch]);
    const failed = result.filter((text, j) => !text && batch[j]).length;
    if (!failed) return result;

    const detail =
      `Azure translate to en: ${failed}/${batch.length} documents came back empty ` +
      `(translateAll substitutes "" on failure - see the Azure error logged above)`;
    if (attempt >= AZURE_MAX_RETRIES) throw new Error(detail);
    const wait = Math.min(AZURE_MAX_BACKOFF_MS, AZURE_BACKOFF_BASE_MS * 2 ** attempt);
    console.warn(
      `[Azure] to-en: ${failed}/${batch.length} empty - retrying in ${wait}ms (attempt ${attempt + 1}/${AZURE_MAX_RETRIES})`,
    );
    await sleep(wait);
  }
}

// The production inbound direction: anything -> English, still via the real
// translateAll.
export async function translateToEnglish(
  texts: readonly string[],
  opts: PipelineOptions,
): Promise<string[]> {
  const out: string[] = [];
  const batches = chunk(texts, AZURE_BATCH);
  for (let i = 0; i < batches.length; i++) {
    if (i > 0) await sleep(opts.azureGapMs);
    const batch = batches[i];
    const translated = await cached<string[]>(opts.cacheDir, "azure:to-en", batch, () =>
      translateAllChecked(batch),
    );
    out.push(...translated);
  }
  return out;
}

// EVAL-ONLY: English -> `lang`, the outbound leg of the round-trip study.
// Production never translates in this direction, so there is no function to
// reuse; this calls the same endpoint with the same credentials.
export async function translateTo(
  texts: readonly string[],
  lang: string,
  opts: PipelineOptions,
): Promise<string[]> {
  const out: string[] = [];
  const batches = chunk(texts, AZURE_BATCH);
  for (let i = 0; i < batches.length; i++) {
    if (i > 0) await sleep(opts.azureGapMs);
    const batch = batches[i];
    const translated = await cached<string[]>(
      opts.cacheDir,
      `azure:to-${lang}`,
      batch,
      () => azureTranslate(batch, lang),
    );
    out.push(...translated);
  }
  return out;
}
