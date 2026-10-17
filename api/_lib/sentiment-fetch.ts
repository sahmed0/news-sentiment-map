// Fetch + translate + score logic for the hourly refresh tick. api/cron/refresh.ts
// is the only caller: the read endpoints never touch a provider, which is what
// keeps user traffic from spending credits.

import { now, since, log, warn, debug, DEBUG } from "./logger.js";
import type { Article, CountryDef, CountryResult, RawArticle } from "../../shared/types.js";

// utcOffset = standard-time offset (hours) of the country's primary population
// centre, used to fire each country's daily refresh near 6 am local. Half-hour
// zones are rounded to the nearest hour; DST drift of +-1 h is tolerated since
// NewsData.io's free tier already lags ~12 h, so exact timing doesn't matter.
//
// lang = ISO 639-1 code(s) for the country's news languages: one code for
// high-priority countries, a comma-joined list for low-priority ones (filtered by
// newsDataLanguages). GNews returns no per-article language, so GNews headlines
// are tagged with this code mapped to NewsData's vocabulary (ISO_TO_NEWSDATA_LANG)
// to drive translate/score routing. Azure auto-detects on translate, so a
// mistagged headline still degrades gracefully.

export const HIGH_PRIORITY_COUNTRIES: readonly CountryDef[] = [
  { code: "us", name: "United States", utcOffset: -5, lang: "en" },
  { code: "in", name: "India", utcOffset: 6, lang: "en" },
  { code: "es", name: "Spain", utcOffset: 1, lang: "es" },
  { code: "gb", name: "United Kingdom", utcOffset: 0, lang: "en" },
  { code: "it", name: "Italy", utcOffset: 1, lang: "it" },
  { code: "de", name: "Germany", utcOffset: 1, lang: "de" },
  { code: "ca", name: "Canada", utcOffset: -5, lang: "en" },
  { code: "fr", name: "France", utcOffset: 1, lang: "fr" },
  { code: "mx", name: "Mexico", utcOffset: -6, lang: "es" },
  { code: "au", name: "Australia", utcOffset: 10, lang: "en" },
  { code: "br", name: "Brazil", utcOffset: -3, lang: "pt" },
  { code: "tr", name: "Turkey", utcOffset: 3, lang: "tr" },
  { code: "ru", name: "Russia", utcOffset: 3, lang: "ru" },
  { code: "ar", name: "Argentina", utcOffset: -3, lang: "es" },
  { code: "pk", name: "Pakistan", utcOffset: 5, lang: "en" },
  { code: "gr", name: "Greece", utcOffset: 2, lang: "el" },
  { code: "pt", name: "Portugal", utcOffset: 0, lang: "pt" },
  { code: "pl", name: "Poland", utcOffset: 1, lang: "pl" },
  { code: "ng", name: "Nigeria", utcOffset: 1, lang: "en" },
  { code: "nl", name: "Netherlands", utcOffset: 1, lang: "nl" },
  { code: "jp", name: "Japan", utcOffset: 9, lang: "ja" },
  { code: "kr", name: "South Korea", utcOffset: 9, lang: "ko" },
  { code: "ve", name: "Venezuela", utcOffset: -4, lang: "es" },
  { code: "cl", name: "Chile", utcOffset: -4, lang: "es" },
  { code: "cn", name: "China", utcOffset: 8, lang: "zh" },
  { code: "ph", name: "Philippines", utcOffset: 8, lang: "en" },
  { code: "id", name: "Indonesia", utcOffset: 7, lang: "id" },
  { code: "se", name: "Sweden", utcOffset: 1, lang: "sv" },
  { code: "be", name: "Belgium", utcOffset: 1, lang: "nl" },
  { code: "fi", name: "Finland", utcOffset: 2, lang: "fi" },
  { code: "ch", name: "Switzerland", utcOffset: 1, lang: "de" },
  { code: "ie", name: "Ireland", utcOffset: 0, lang: "en" },
  { code: "co", name: "Colombia", utcOffset: -5, lang: "es" },
  { code: "eg", name: "Egypt", utcOffset: 2, lang: "ar" },
  { code: "sa", name: "Saudi Arabia", utcOffset: 3, lang: "ar" },
  { code: "ro", name: "Romania", utcOffset: 2, lang: "ro" },
  { code: "cz", name: "Czech Republic", utcOffset: 1, lang: "cs" },
  { code: "za", name: "South Africa", utcOffset: 2, lang: "en" },
  { code: "il", name: "Israel", utcOffset: 2, lang: "he" },
  { code: "pe", name: "Peru", utcOffset: -5, lang: "es" },
  { code: "hu", name: "Hungary", utcOffset: 1, lang: "hu" },
  { code: "ua", name: "Ukraine", utcOffset: 2, lang: "uk" },
  { code: "at", name: "Austria", utcOffset: 1, lang: "de" },
  { code: "th", name: "Thailand", utcOffset: 7, lang: "th" },
  { code: "my", name: "Malaysia", utcOffset: 8, lang: "en" },
  { code: "no", name: "Norway", utcOffset: 1, lang: "no" },
  { code: "ae", name: "United Arab Emirates", utcOffset: 4, lang: "ar" },
  { code: "bd", name: "Bangladesh", utcOffset: 6, lang: "bn" },
  { code: "bw", name: "Botswana", utcOffset: 2, lang: "en" },
  { code: "bg", name: "Bulgaria", utcOffset: 2, lang: "bg" },
  { code: "cu", name: "Cuba", utcOffset: -5, lang: "es" },
  { code: "ee", name: "Estonia", utcOffset: 2, lang: "et" },
  { code: "et", name: "Ethiopia", utcOffset: 3, lang: "en" },
  { code: "gh", name: "Ghana", utcOffset: 0, lang: "en" },
  { code: "ke", name: "Kenya", utcOffset: 3, lang: "en" },
  { code: "lv", name: "Latvia", utcOffset: 2, lang: "lv" },
  { code: "lb", name: "Lebanon", utcOffset: 2, lang: "ar" },
  { code: "lt", name: "Lithuania", utcOffset: 2, lang: "lt" },
  { code: "na", name: "Namibia", utcOffset: 2, lang: "en" },
  { code: "nz", name: "New Zealand", utcOffset: 12, lang: "en" },
  { code: "sn", name: "Senegal", utcOffset: 0, lang: "fr" },
  { code: "sk", name: "Slovakia", utcOffset: 1, lang: "sk" },
  { code: "si", name: "Slovenia", utcOffset: 1, lang: "sl" },
  { code: "tw", name: "Taiwan", utcOffset: 8, lang: "zh" },
  { code: "tz", name: "Tanzania", utcOffset: 3, lang: "en" },
  { code: "ug", name: "Uganda", utcOffset: 3, lang: "en" },
  { code: "vn", name: "Vietnam", utcOffset: 7, lang: "vi" },
  { code: "zw", name: "Zimbabwe", utcOffset: 2, lang: "en" },
];

export const LOW_PRIORITY_COUNTRIES: readonly CountryDef[] = [
  { code: "ma", name: "Morocco", utcOffset: 1, lang: "ar,en,fr" },
  { code: "ir", name: "Iran", utcOffset: 3, lang: "fa,en" },
  { code: "hr", name: "Croatia", utcOffset: 1, lang: "hr,en" },
  { code: "ps", name: "Palestine", utcOffset: 2, lang: "ar,en" },
  { code: "dk", name: "Denmark", utcOffset: 1, lang: "da,en" },
  { code: "qa", name: "Qatar", utcOffset: 3, lang: "ar,en" },
  { code: "by", name: "Belarus", utcOffset: 3, lang: "be,ru,en" },
  { code: "dz", name: "Algeria", utcOffset: 1, lang: "ar,en,fr" },
  { code: "sy", name: "Syria", utcOffset: 3, lang: "ar,en" },
  { code: "ye", name: "Yemen", utcOffset: 3, lang: "ar,en" },
  { code: "jo", name: "Jordan", utcOffset: 3, lang: "ar,en" },
  { code: "iq", name: "Iraq", utcOffset: 3, lang: "ar,en,ku" },
  { code: "ly", name: "Libya", utcOffset: 2, lang: "ar,en" },
  { code: "af", name: "Afghanistan", utcOffset: 4, lang: "en,ps" },
  { code: "mm", name: "Myanmar", utcOffset: 6, lang: "my,en" },
  { code: "uy", name: "Uruguay", utcOffset: -3, lang: "es,en" },
  { code: "bo", name: "Bolivia", utcOffset: -4, lang: "es,en" },
  { code: "om", name: "Oman", utcOffset: 4, lang: "ar,en" },
  { code: "so", name: "Somalia", utcOffset: 3, lang: "en,ar" },
  { code: "sd", name: "Sudan", utcOffset: 2, lang: "ar,en" },
  { code: "py", name: "Paraguay", utcOffset: -4, lang: "es,en" },
  { code: "kz", name: "Kazakhstan", utcOffset: 5, lang: "kk,en" }, // kk = Kazakh; "kz" was the country code
  { code: "zm", name: "Zambia", utcOffset: 2, lang: "en" },
  { code: "cd", name: "DR Congo", utcOffset: 1, lang: "fr,en,sw" },
  { code: "ao", name: "Angola", utcOffset: 1, lang: "pt,en" },
  { code: "mz", name: "Mozambique", utcOffset: 2, lang: "pt,en,sw" },
  { code: "uz", name: "Uzbekistan", utcOffset: 5, lang: "uz,en" },
  { code: "cm", name: "Cameroon", utcOffset: 1, lang: "fr,en" },
  { code: "mn", name: "Mongolia", utcOffset: 8, lang: "mn,en" },
  { code: "kp", name: "North Korea", utcOffset: 9, lang: "ko" }, // no en: it shared Bhutan's English wire stories
  { code: "ml", name: "Mali", utcOffset: 0, lang: "bm,fr,en" }, // bm (Bambara) is dropped: Azure cannot translate it (see NEWSDATA_SUPPORTED_LANGS)
  { code: "td", name: "Chad", utcOffset: 1, lang: "fr,ar,en" },
  { code: "mr", name: "Mauritania", utcOffset: 0, lang: "ar,en" },
  { code: "ne", name: "Niger", utcOffset: 1, lang: "fr,ha,en" },
  { code: "cf", name: "Central African Republic", utcOffset: 1, lang: "fr,en" },
  { code: "ga", name: "Gabon", utcOffset: 1, lang: "fr,en" },
  { code: "cg", name: "Congo", utcOffset: 1, lang: "fr,en" },
  { code: "gn", name: "Guinea", utcOffset: 0, lang: "fr,en" },
  { code: "ci", name: "Ivory Coast", utcOffset: 0, lang: "fr,en" },
  { code: "bf", name: "Burkina Faso", utcOffset: 0, lang: "fr,en" },
  { code: "mg", name: "Madagascar", utcOffset: 3, lang: "fr" }, // no en: its English results duplicated other countries'
  { code: "tm", name: "Turkmenistan", utcOffset: 5, lang: "tk,en" },
  { code: "kg", name: "Kyrgyzstan", utcOffset: 5, lang: "ru,en" },
  { code: "tj", name: "Tajikistan", utcOffset: 5, lang: "tg,en" }, // tg (Tajik) is dropped: Azure cannot translate it, so this sends "en" alone
  { code: "az", name: "Azerbaijan", utcOffset: 4, lang: "az,en" },
  { code: "am", name: "Armenia", utcOffset: 4, lang: "hy,en" },
  { code: "ge", name: "Georgia", utcOffset: 4, lang: "ka,en" },
  { code: "pg", name: "Papua New Guinea", utcOffset: 10, lang: "en" },
  { code: "kh", name: "Cambodia", utcOffset: 7, lang: "km,en" }, // km = Khmer; "kh" was the country code
  { code: "la", name: "Laos", utcOffset: 7, lang: "en" },
  { code: "al", name: "Albania", utcOffset: 1, lang: "en,sq" },
  { code: "rs", name: "Serbia", utcOffset: 1, lang: "sr,en" },
  { code: "ba", name: "Bosnia and Herzegovina", utcOffset: 1, lang: "bs,en" },
  { code: "mk", name: "North Macedonia", utcOffset: 1, lang: "en,mk,sq" },
  { code: "me", name: "Montenegro", utcOffset: 1, lang: "en,sr,bs,sq,hr" },
  { code: "md", name: "Moldova", utcOffset: 2, lang: "ro,en" },
  { code: "mw", name: "Malawi", utcOffset: 2, lang: "en" },
  { code: "ec", name: "Ecuador", utcOffset: -5, lang: "es,en" },
  { code: "sr", name: "Suriname", utcOffset: -3, lang: "en,nl,es,fr" },
  { code: "gy", name: "Guyana", utcOffset: -4, lang: "en" },
  { code: "lk", name: "Sri Lanka", utcOffset: 6, lang: "en" },
  { code: "np", name: "Nepal", utcOffset: 6, lang: "ne,en" },
  { code: "gt", name: "Guatemala", utcOffset: -6, lang: "es,en" },
  { code: "hn", name: "Honduras", utcOffset: -6, lang: "es,en" },
  { code: "ni", name: "Nicaragua", utcOffset: -6, lang: "es,en" },
  { code: "cr", name: "Costa Rica", utcOffset: -6, lang: "es,en" },
  { code: "pa", name: "Panama", utcOffset: -5, lang: "es,en" },
  { code: "is", name: "Iceland", utcOffset: 0, lang: "is,en" },
  { code: "tn", name: "Tunisia", utcOffset: 1, lang: "ar,en" },
  { code: "bt", name: "Bhutan", utcOffset: 6, lang: "en" },
  { code: "kw", name: "Kuwait", utcOffset: 3, lang: "ar,en" },
  { code: "bh", name: "Bahrain", utcOffset: 3, lang: "ar,en" },
  { code: "er", name: "Eritrea", utcOffset: 3, lang: "en,fr,ar" },
  { code: "dj", name: "Djibouti", utcOffset: 3, lang: "ar,fr,en" },
  { code: "rw", name: "Rwanda", utcOffset: 2, lang: "en" },
  { code: "bi", name: "Burundi", utcOffset: 2, lang: "fr,en" },
  { code: "tg", name: "Togo", utcOffset: 0, lang: "fr,en" },
  { code: "bj", name: "Benin", utcOffset: 0, lang: "fr,en" },
  { code: "lr", name: "Liberia", utcOffset: 0, lang: "en" },
  { code: "sl", name: "Sierra Leone", utcOffset: 0, lang: "en" },
  { code: "gm", name: "Gambia", utcOffset: 0, lang: "en" },
  { code: "ls", name: "Lesotho", utcOffset: 2, lang: "en" },
  { code: "gq", name: "Equatorial Guinea", utcOffset: 1, lang: "es,fr,pt" }, // no en: its English results duplicated other countries'
  { code: "bz", name: "Belize", utcOffset: -6, lang: "en" },
  { code: "sv", name: "El Salvador", utcOffset: -6, lang: "es,en" },
  { code: "do", name: "Dominican Republic", utcOffset: -4, lang: "es,en,fr" },
  { code: "ht", name: "Haiti", utcOffset: -5, lang: "fr,en" },
];

// All supported countries, high tier first. Derived so existing consumers
// (rebuildAggregate, the scheduler, health, history) keep working against one
// flat list.
export const COUNTRIES: readonly CountryDef[] = [...HIGH_PRIORITY_COUNTRIES, ...LOW_PRIORITY_COUNTRIES];

// O(1) tier test for the scheduler. Membership = "fetched every day"; every
// country only in LOW_PRIORITY_COUNTRIES is refreshed at most every
// LOW_PRIORITY_DAYS days (see refresh-core.ts), split into even per-day cohorts.
export const HIGH_PRIORITY_CODES = new Set<string>(HIGH_PRIORITY_COUNTRIES.map((c) => c.code));

export const NEWSDATA_DELAY_MS = 2000; // gap between consecutive requests - keeps us under NewsData.io's 1 req/sec limit (1000ms safety margin)
export const NEWSDATA_MAX_RETRIES = 2; // retries on HTTP 429 / transient network errors before giving up on a country
export const NEWSDATA_BACKOFF_BASE_MS = 6000; // first backoff when no Retry-After header is present
export const GNEWS_DELAY_MS = 2000; // gap between consecutive GNews requests - GNews free tier is request-count limited (no strict req/sec), so a small courtesy gap suffices
export const GNEWS_MAX_RETRIES = 2; // retries on HTTP 429 / transient network errors before giving up on a country
export const GNEWS_BACKOFF_BASE_MS = 6000; // first backoff when no Retry-After header is present
export const GNEWS_SIZE = 5; // headlines per high-priority country - matches NewsData's size=5 so cross-provider averages are comparable (free tier caps at 10)

// ISO 639-1 code → NewsData.io language name (lowercase English).
// Used in fetchHeadlinesGNews to (a) decide whether to send a `lang=` filter to
// GNews (GNews supports exactly this subset of ISO codes) and (b) tag each GNews
// article with the English name the translate/score router expects - mirroring
// the format NewsData.io uses for its per-article `language` field.
const ISO_TO_NEWSDATA_LANG: Record<string, string> = {
  "en": "english", "es": "spanish", "it": "italian", "de": "german", "fr": "french",
  "pt": "portuguese", "ru": "russian", "el": "greek", "nl": "dutch", "ja": "japanese",
  "zh": "chinese", "sv": "swedish", "ar": "arabic", "ro": "romanian", "he": "hebrew",
  "uk": "ukrainian", "no": "norwegian", "hi": "hindi",
};

// ISO 639-1 codes that NewsData accepts as a `language` filter AND Azure can
// translate. newsDataLanguages drops any other code rather than send it: a
// rejected code is a terminal 422 that would freeze the country on old data.
// bm (Bambara) and tg (Tajik) are left out on purpose - NewsData accepts them
// but Azure cannot translate them.
const NEWSDATA_SUPPORTED_LANGS = new Set<string>([
  "en", "es", "it", "de", "fr", "pt", "ru", "el", "nl", "ja", "zh", "sv", "ar",
  "ro", "he", "uk", "no", "hi", "tr", "ko", "th", "id", "ms", "pl", "cs", "hu",
  "bg", "vi", "bn", "fa", "hr", "da", "et", "lv", "lt", "sk", "sl", "sq", "sr",
  "bs", "mk", "my", "hy", "az", "ne", "ur", "fi", "mn", "ka", "km", "lo", "uz",
  "be", "ku", "ps", "sw", "ha", "tk", "is", "kk",
]);
const NEWSDATA_MAX_LANGS = 5; // NewsData's per-query limit

// A country's `lang` list -> the supported codes to filter on, in the country's
// own order, capped at NEWSDATA_MAX_LANGS. An empty result means no `language`
// parameter is sent.
//
// English is where multi-country wires collide, so a few multi-language
// countries (kp, mg, gq) leave `en` out of their list in the table.
export function newsDataLanguages(lang: string | undefined): string[] {
  if (!lang) return [];
  return lang
    .split(",")
    .map((code) => code.trim())
    .filter((code) => NEWSDATA_SUPPORTED_LANGS.has(code))
    .slice(0, NEWSDATA_MAX_LANGS);
}
export const FETCH_TIMEOUT_MS = 60000; // abort any single external request that hangs, so one stuck connection can't stall the whole tick
export const HF_MAX_RETRIES = 2; // retries on HF 503 (model loading) / 429 / transient network errors before nulling a batch
export const HF_BACKOFF_BASE_MS = 6000; // first backoff when no Retry-After / estimated_time is present
export const HF_MAX_BACKOFF_MS = 30000; // cap a single HF wait (a cold-start estimated_time can be large) so a tick can't stall

// The fetch -> translate -> score pipeline must finish inside this, leaving
// ~60 s of api/cron/refresh.ts's 300 s maxDuration for persistence, the
// aggregate rebuild and the tick record (all Redis round trips). Every request
// timeout and retry wait is capped at the time remaining; nothing new starts
// once it has run out. A request cut short by the cap is a plain timeout -
// which is already refunded (see the status table in refresh-core.ts), because
// a request that never completed may or may not have been charged - so the
// budget introduces no new ledger case.
export const TICK_BUDGET_MS = 240_000;

// Time left before `deadlineAt`, or Infinity when there is no budget (the eval
// harness calls translateAll / scoreInChunks without one).
const remainingUntil = (deadlineAt: number | undefined): number =>
  deadlineAt === undefined ? Infinity : deadlineAt - Date.now();

// One request's timeout: FETCH_TIMEOUT_MS, or less when the tick's budget ends
// sooner. Never negative - a 0 ms timer still aborts.
const requestTimeoutMs = (deadlineAt: number | undefined): number =>
  Math.max(0, Math.min(FETCH_TIMEOUT_MS, remainingUntil(deadlineAt)));

// Like AbortSignal.timeout, but built on setTimeout so tests can drive it
// with fake timers (Node's AbortSignal.timeout uses an internal timer they
// can't reach). Aborts with the same DOMException name, so
// isRetryableNetworkError and the "timeout" status are unchanged.
// The timer is deliberately not cleared when fetch resolves: the same signal
// also bounds the body read (res.text() / res.json()). unref() stops a pending
// timer from holding the process open.
function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
    ms,
  );
  timer.unref?.();
  return controller.signal;
}

// Transient connection-layer failures thrown by undici (Node's fetch) - the
// request never reached an HTTP response, so a quick retry often succeeds.
const RETRYABLE_NETWORK_CODES = new Set<string>([
  "UND_ERR_CONNECT_TIMEOUT", // connect timed out (newsdata.io:443)
  "UND_ERR_SOCKET",          // socket closed unexpectedly
  "ECONNRESET",              // peer reset the connection
  "ECONNREFUSED",            // peer refused the connection
  "ETIMEDOUT",               // generic socket timeout
  "EAI_AGAIN",               // transient DNS lookup failure
]);

// Small structural helpers for reading untyped values off fetch/JSON boundaries
// without `any` casts.
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;
const asStr = (v: unknown): string | null => (typeof v === "string" ? v : null);
// Pull a named field off a thrown value (Error, DOMException, or a plain object).
const errField = (e: unknown, field: string): unknown => (isRecord(e) ? e[field] : undefined);

// fetch() rejects with a TypeError whose `cause` carries the real code. A
// timeoutSignal() firing rejects with a DOMException named "TimeoutError" -
// treat that like a transient failure so a slow request retries then gives up.
export function isRetryableNetworkError(err: unknown): boolean {
  if (errField(err, "name") === "TimeoutError") return true;
  const cause = errField(err, "cause");
  const code = (isRecord(cause) ? cause.code : undefined) ?? errField(err, "code");
  return typeof code === "string" && RETRYABLE_NETWORK_CODES.has(code);
}
const AZURE_BATCH_SIZE = 100;           // Azure Translator max documents per request
const HF_BATCH_SIZE = 50;               // headlines per HuggingFace request - keeps payloads small

// Exported so the eval harness measures the same model the map is built from,
// rather than a second copy of this URL that could silently drift.
export const HF_ENGLISH_MODEL =
  "https://router.huggingface.co/hf-inference/models/cardiffnlp/twitter-roberta-base-sentiment-latest";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Last path segment of a HF model URL, for terse log lines (e.g. "twitter-roberta-base-sentiment-latest").
const modelShortName = (url: string): string => url.split("/").pop() ?? url;

// Normalize a provider timestamp to an ISO string, or null if missing/unparseable.
// new Date(bad).toISOString() THROWS (RangeError), so a single malformed publishedAt
// must be parsed defensively or it would abort the whole country's fetch.
const toIsoOrNull = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

// Parse a Retry-After header (RFC 7231): either delta-seconds or an HTTP date.
// Returns the wait in ms, or null when the header is missing/unparseable.
export function parseRetryAfter(headerValue: string | null | undefined): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(headerValue);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

// A provider fetcher's outcome. `status` is a coarse label the caller folds into
// the run summary; the two providers share this contract so fetchCountries can
// route by tier without caring which one produced the headlines.
interface FetchOutcome {
  articles: RawArticle[];
  status: string;
  latencyMs: number;
  attempts: number;
}

interface RetryResult {
  res: Response | null;
  status: string | null;
  attempts: number;
}

// Shared retry loop for HTTP headline fetches. Handles two transient failure modes:
//   - HTTP 429: honor Retry-After when present, else exponential backoff.
//   - connection errors (fetch throws): exponential backoff.
// Returns { res, attempts } on a non-429 HTTP response, or
//         { res: null, status, attempts } when retries are exhausted.
// With a `deadlineAt`, each request's timeout is capped at the time remaining,
// and a retry whose backoff would use up the rest of the budget is not made (it
// would be sent at the deadline with a 0 ms timeout): the last real failure is
// returned instead. That request WAS sent, so it keeps its real
// status (timeout / network_error / rate_limited), never deadline_skipped.
async function fetchWithRetry(
  url: string,
  { tag, code, maxRetries, minGapMs, backoffBaseMs, deadlineAt }:
    { tag: string; code: string; maxRetries: number; minGapMs: number; backoffBaseMs: number; deadlineAt?: number },
): Promise<RetryResult> {
  let res: Response;
  let attempts: number;
  for (let attempt = 0; ; attempt++) {
    attempts = attempt + 1;
    try {
      res = await fetch(url, { signal: timeoutSignal(requestTimeoutMs(deadlineAt)) });
    } catch (err) {
      if (!isRetryableNetworkError(err)) throw err;
      const cause = errField(err, "cause");
      const errCode = (isRecord(cause) ? cause.code : undefined) ?? errField(err, "code") ?? errField(err, "name");
      const status = errField(err, "name") === "TimeoutError" ? "timeout" : "network_error";
      if (attempt >= maxRetries) {
        console.error(`[${tag}] ${code}: ${String(errCode)} - gave up after ${attempt} retries`);
        return { res: null, status, attempts };
      }
      const wait = Math.max(minGapMs, backoffBaseMs * 2 ** attempt);
      if (remainingUntil(deadlineAt) <= wait) {
        console.error(`[${tag}] ${code}: ${String(errCode)} - tick budget spent, not retrying`);
        return { res: null, status, attempts };
      }
      console.warn(`[${tag}] ${code}: ${String(errCode)} - retrying in ${wait}ms (attempt ${attempt + 1}/${maxRetries})`);
      await delay(wait);
      continue;
    }
    if (res.status !== 429) break;
    if (attempt >= maxRetries) {
      console.error(`[${tag}] ${code}: HTTP 429 - gave up after ${attempt} retries`);
      return { res: null, status: "rate_limited", attempts };
    }
    const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
    const wait = Math.max(minGapMs, retryAfter ?? backoffBaseMs * 2 ** attempt);
    if (remainingUntil(deadlineAt) <= wait) {
      console.error(`[${tag}] ${code}: HTTP 429 - tick budget spent, not retrying`);
      return { res: null, status: "rate_limited", attempts };
    }
    console.warn(`[${tag}] ${code}: HTTP 429 - retrying in ${wait}ms (attempt ${attempt + 1}/${maxRetries})`);
    await delay(wait);
  }
  return { res, status: null, attempts };
}

// The NewsData `latest` query for one country, without the API key.
//
// No `sort=source`: NewsData's `country` filter matches the publisher's
// registered countries, and big outlets are registered for whole regions, so
// source sorting served the same articles to many neighbouring countries.
// Results come back newest first instead.
export function newsDataQuery(country: Pick<FetchTarget, "code" | "lang">): string {
  const langs = newsDataLanguages(country.lang);
  const langParam = langs.length ? `&language=${langs.join(",")}` : "";
  return `country=${country.code.toLowerCase()}${langParam}&removeduplicate=1&size=5`;
}

// Returns { articles, status, latencyMs, attempts } - `status` is a coarse outcome
// label (ok | empty | unsupported | rate_limited | http_<code> | timeout |
// network_error | invalid_json | api_error) the caller folds into the run summary.
async function fetchHeadlines(country: FetchTarget, deadlineAt?: number): Promise<FetchOutcome> {
  const { code: countryCode } = country;
  const url = `https://newsdata.io/api/1/latest?${newsDataQuery(country)}&apikey=${process.env.NEWSDATA_API_KEY}`;
  const start = now();
  const { res, status: earlyStatus, attempts } = await fetchWithRetry(url, {
    tag: "NewsData", code: countryCode,
    maxRetries: NEWSDATA_MAX_RETRIES, minGapMs: NEWSDATA_DELAY_MS, backoffBaseMs: NEWSDATA_BACKOFF_BASE_MS,
    deadlineAt,
  });
  const out = (articles: RawArticle[], status: string): FetchOutcome => ({ articles, status, latencyMs: since(start), attempts });

  if (!res) return out([], earlyStatus ?? "network_error");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Unsupported country (HTTP 422 / UnsupportedFilter): log a clean, intentional
    // skip message and move on - never let one bad country abort the whole run.
    if (res.status === 422 && body.includes("UnsupportedFilter")) {
      console.warn(`[NewsData] ${countryCode}: not supported by NewsData.io - skipping`);
      return out([], "unsupported");
    }
    console.error(`[NewsData] ${countryCode}: HTTP ${res.status} - ${body.slice(0, 400)}`);
    return out([], `http_${res.status}`);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    console.error(`[NewsData] ${countryCode}: invalid JSON response`);
    return out([], "invalid_json");
  }
  if (!isRecord(data) || data.status !== "success") {
    console.error(`[NewsData] ${countryCode}: ${JSON.stringify(data)}`);
    return out([], "api_error");
  }
  // NewsData.io can return the same article multiple times in one response -
  // dedupe by link (falling back to normalized title) so a country isn't filled
  // with repeats and its average isn't skewed by a duplicated headline.
  const seen = new Set<string>();
  const articles: RawArticle[] = [];
  const results = Array.isArray(data.results) ? data.results : [];
  for (const a of results) {
    if (!isRecord(a)) continue;
    const link = asStr(a.link);
    const title = asStr(a.title);
    const key = (link || title || "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const pubDate = asStr(a.pubDate);
    articles.push({
      title,
      url: link,
      publishedAt: toIsoOrNull(pubDate ? pubDate.replace(" ", "T") + "Z" : null),
      language: asStr(a.language) || null,
    });
  }
  return out(articles, articles.length ? "ok" : "empty");
}

// GNews top-headlines: popularity/relevance-ranked top stories per country - the
// app's focus - complementing NewsData's recency-only feed. Used for high-priority
// countries (all 68 are within GNews's country coverage). Returns the SAME contract
// as fetchHeadlines - { articles, status, latencyMs, attempts } - so fetchCountries
// can route by tier without caring which provider produced the headlines.
//
// `country` is a HIGH_PRIORITY_COUNTRIES entry (needs `code` + `lang`). GNews gives
// no per-article language, so every headline is tagged with `country.lang`.
async function fetchHeadlinesGNews(country: FetchTarget, deadlineAt?: number): Promise<FetchOutcome> {
  const { code, lang } = country;
  const params = new URLSearchParams({
    category: "general",
    country: code.toLowerCase(),
    max: String(GNEWS_SIZE),
    apikey: process.env.GNEWS_API_KEY ?? "",
  });
  // lang is the ISO 639-1 code from HIGH_PRIORITY_COUNTRIES. ISO_TO_NEWSDATA_LANG
  // doubles as the GNews supported-lang allowlist: if the ISO code is present,
  // GNews accepts it directly as the `lang=` parameter value.
  if (lang && ISO_TO_NEWSDATA_LANG[lang]) params.set("lang", lang);
  const url = `https://gnews.io/api/v4/top-headlines?${params}`;
  const start = now();
  const { res, status: earlyStatus, attempts } = await fetchWithRetry(url, {
    tag: "GNews", code,
    maxRetries: GNEWS_MAX_RETRIES, minGapMs: GNEWS_DELAY_MS, backoffBaseMs: GNEWS_BACKOFF_BASE_MS,
    deadlineAt,
  });
  const out = (articles: RawArticle[], status: string): FetchOutcome => ({ articles, status, latencyMs: since(start), attempts });

  if (!res) return out([], earlyStatus ?? "network_error");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[GNews] ${code}: HTTP ${res.status} - ${body.slice(0, 400)}`);
    return out([], `http_${res.status}`);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    console.error(`[GNews] ${code}: invalid JSON response`);
    return out([], "invalid_json");
  }
  if (!isRecord(data) || !Array.isArray(data.articles)) {
    console.error(`[GNews] ${code}: ${JSON.stringify(data).slice(0, 400)}`);
    return out([], "api_error");
  }
  // Dedupe by url (falling back to normalized title) so a country isn't filled
  // with repeats - mirrors the NewsData path.
  const seen = new Set<string>();
  const articles: RawArticle[] = [];
  for (const a of data.articles) {
    if (!isRecord(a)) continue;
    const aUrl = asStr(a.url);
    const title = asStr(a.title);
    const key = (aUrl || title || "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    articles.push({
      title,
      url: aUrl,
      publishedAt: toIsoOrNull(asStr(a.publishedAt)),
      // Convert ISO code to the English name the "english" routing guard expects.
      // Falls back to the ISO code for unmapped languages (they route to the
      // translate path, which is correct).
      language: (lang && ISO_TO_NEWSDATA_LANG[lang]) ?? lang ?? null,
    });
  }
  return out(articles, articles.length ? "ok" : "empty");
}

// Read the `.text` off one Azure Translator result document, or "" when absent.
const azureText = (r: unknown): string => {
  if (!isRecord(r)) return "";
  const t = r.translations;
  if (!Array.isArray(t) || !isRecord(t[0])) return "";
  return typeof t[0].text === "string" ? t[0].text : "";
};

async function translateHeadlines(titles: string[], deadlineAt?: number): Promise<string[] | null> {
  if (!titles.length) return titles;
  const headers: Record<string, string> = {
    "Ocp-Apim-Subscription-Key": process.env.AZURE_TRANSLATOR_KEY ?? "",
    "Content-Type": "application/json",
  };
  // Regional (non-Global) Translator resources require the region header,
  // otherwise the global endpoint rejects the key with HTTP 401 (code 401001).
  if (process.env.AZURE_TRANSLATOR_REGION) {
    headers["Ocp-Apim-Subscription-Region"] = process.env.AZURE_TRANSLATOR_REGION;
  }
  const start = now();
  let res: Response;
  try {
    res = await fetch(
      "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=en",
      {
        method: "POST",
        headers,
        body: JSON.stringify(titles.map((t) => ({ Text: t }))),
        signal: timeoutSignal(requestTimeoutMs(deadlineAt)),
      }
    );
  } catch (e) {
    // Timeout or connection error: degrade like an HTTP failure so callers
    // substitute empty translations rather than the whole tick hanging.
    const status = errField(e, "name") === "TimeoutError" ? "timeout" : "network_error";
    log("Azure", "translate", { status, docs: titles.length, ms: since(start) });
    return null;
  }
  const rawBody = await res.text().catch(() => "");
  if (!res.ok) {
    log("Azure", "translate", { status: `http_${res.status}`, docs: titles.length, ms: since(start) });
    console.error(`[Azure] translate HTTP ${res.status}: ${rawBody.slice(0, 200)}`);
    return null;
  }
  try {
    const results: unknown = JSON.parse(rawBody);
    if (!Array.isArray(results)) throw new Error("not an array");
    log("Azure", "translate", { status: "ok", docs: titles.length, ms: since(start) });
    return results.map(azureText);
  } catch {
    log("Azure", "translate", { status: "invalid_json", docs: titles.length, ms: since(start) });
    console.error(`[Azure] translate invalid response: ${rawBody.slice(0, 200)}`);
    return null;
  }
}

// A stage's output plus how many of its items the tick budget dropped, which
// fetchCountries needs for its budget_exhausted log line.
interface Budgeted<T> {
  out: T[];
  skipped: number;
}

async function translateWithin(titles: string[], deadlineAt?: number): Promise<Budgeted<string>> {
  const out: string[] = [];
  let skipped = 0;
  for (let i = 0; i < titles.length; i += AZURE_BATCH_SIZE) {
    const chunk = titles.slice(i, i + AZURE_BATCH_SIZE);
    // Budget spent: degrade exactly as an Azure failure does, without sending.
    if (remainingUntil(deadlineAt) <= 0) {
      out.push(...chunk.map(() => ""));
      skipped += chunk.length;
      continue;
    }
    const translated = await translateHeadlines(chunk, deadlineAt);
    // On Azure failure, substitute empty strings so HF scores null rather than untranslated text
    out.push(...(translated !== null ? translated : chunk.map(() => "")));
  }
  return { out, skipped };
}

// Exported for the eval harness, which must measure this exact path (batching,
// the empty-string substitution on Azure failure) and not a reimplementation.
// `deadlineAt` is the tick budget; the eval passes none, so it runs unbounded.
export async function translateAll(titles: string[], deadlineAt?: number): Promise<string[]> {
  return (await translateWithin(titles, deadlineAt)).out;
}

async function batchSentimentModel(modelUrl: string, inputs: string[], deadlineAt?: number): Promise<Budgeted<number | null>> {
  // Skip empty inputs but track original indices so scores align with the input array
  const nonempty = inputs.map((input, i) => ({ i, input })).filter(({ input }) => input.length > 0);
  const scores: (number | null)[] = inputs.map(() => null);
  // `scores` is filled in place on success and left all-null on failure.
  const done: Budgeted<number | null> = { out: scores, skipped: 0 };
  // Given up because of the tick budget: the same all-null degrade as any other
  // failure, but counted so fetchCountries can log it.
  const outOfBudget: Budgeted<number | null> = { out: scores, skipped: nonempty.length };
  if (!nonempty.length) return done;
  if (remainingUntil(deadlineAt) <= 0) return outOfBudget;

  const model = modelShortName(modelUrl);
  const start = now();

  // Retry loop for transient failures (mirrors fetchHeadlines): a connection
  // error, a timeout, HTTP 503 "model loading" (cold start), or HTTP 429. Only
  // after retries are exhausted do we fall back to the all-null `scores` array
  // so a momentary blip can't durably leave a whole batch of countries unscored.
  let results: unknown;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(modelUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
          "Content-Type": "application/json",
        },
        // top_k:null forces the model to return ALL labels per input as a nested
        // array ([[{pos},{neu},{neg}],...]). Without it the HF router returns a flat
        // top-1 array ([{label},{label},...]), which the parser below misreads as a
        // single input - collapsing the whole batch into only the first country.
        body: JSON.stringify({
          inputs: nonempty.map(({ input }) => input),
          parameters: { top_k: null },
        }),
        signal: timeoutSignal(requestTimeoutMs(deadlineAt)),
      });
    } catch (e) {
      // Timeout or connection error: retry if transient, else null the batch so
      // it degrades gracefully instead of stalling the tick.
      const status = errField(e, "name") === "TimeoutError" ? "timeout" : "network_error";
      if (isRetryableNetworkError(e) && attempt < HF_MAX_RETRIES) {
        const wait = Math.min(HF_MAX_BACKOFF_MS, HF_BACKOFF_BASE_MS * 2 ** attempt);
        if (remainingUntil(deadlineAt) <= wait) {
          log("HF", model, { status, items: nonempty.length, ms: since(start), budget: "spent" });
          return outOfBudget;
        }
        console.warn(`[HuggingFace] ${model}: ${status} - retrying in ${wait}ms (attempt ${attempt + 1}/${HF_MAX_RETRIES})`);
        await delay(wait);
        continue;
      }
      const cause = errField(e, "cause");
      log("HF", model, { status, items: nonempty.length, ms: since(start) });
      console.error(`[HuggingFace] request failed: ${String(errField(e, "name") ?? (isRecord(cause) ? cause.code : undefined) ?? e)}`);
      return done;
    }

    const rawBody = await res.text().catch(() => "");

    if (!res.ok) {
      // 503 (model cold-start) and 429 (rate limited) are transient - back off and retry.
      const transient = res.status === 503 || res.status === 429;
      if (transient && attempt < HF_MAX_RETRIES) {
        let wait = parseRetryAfter(res.headers.get("retry-after"));
        if (wait === null && res.status === 503) {
          try {
            const parsed: unknown = JSON.parse(rawBody);
            const est = isRecord(parsed) ? parsed.estimated_time : undefined;
            if (typeof est === "number" && Number.isFinite(est)) wait = est * 1000;
          } catch {
            // Non-JSON 503 body; fall through to exponential backoff.
          }
        }
        wait = Math.min(HF_MAX_BACKOFF_MS, wait ?? HF_BACKOFF_BASE_MS * 2 ** attempt);
        if (remainingUntil(deadlineAt) <= wait) {
          log("HF", model, { status: `http_${res.status}`, items: nonempty.length, ms: since(start), budget: "spent" });
          return outOfBudget;
        }
        console.warn(`[HuggingFace] ${model}: HTTP ${res.status} - retrying in ${wait}ms (attempt ${attempt + 1}/${HF_MAX_RETRIES})`);
        await delay(wait);
        continue;
      }
      log("HF", model, { status: `http_${res.status}`, items: nonempty.length, ms: since(start) });
      console.error(`[HuggingFace] HTTP ${res.status}: ${rawBody.slice(0, 200)}`);
      return done;
    }

    try {
      results = JSON.parse(rawBody);
    } catch {
      log("HF", model, { status: "invalid_json", items: nonempty.length, ms: since(start) });
      console.error(`[HuggingFace] JSON parse failed: ${rawBody.slice(0, 300)}`);
      return done;
    }

    if (!Array.isArray(results)) {
      log("HF", model, { status: "bad_shape", items: nonempty.length, ms: since(start) });
      console.error(`[HuggingFace] Unexpected response: ${rawBody.slice(0, 200)}`);
      return done;
    }
    break; // success
  }

  // Re-narrow after the loop (control-flow narrowing doesn't survive the break).
  if (!Array.isArray(results)) return done;
  // HF returns [{label,score},...] for a single input, [[{label,score},...],...]  for a batch
  const isBatch = Array.isArray(results[0]);
  const normalized: unknown[] = isBatch ? results : [results];

  nonempty.forEach(({ i }, j) => {
    const labelArr = normalized[j];
    if (!Array.isArray(labelArr)) return;
    let score = 0;
    for (const item of labelArr) {
      if (!isRecord(item)) continue;
      const lbl = typeof item.label === "string" ? item.label.toLowerCase() : null;
      if (!lbl || typeof item.score !== "number") continue;
      if (lbl.includes("positive")) score += item.score;
      if (lbl.includes("negative")) score -= item.score;
    }
    scores[i] = score;
  });
  log("HF", model, { status: "ok", items: nonempty.length, ms: since(start) });
  return done;
}

async function scoreWithin(modelUrl: string, inputs: string[], deadlineAt?: number): Promise<Budgeted<number | null>> {
  const out: (number | null)[] = [];
  let skipped = 0;
  for (let i = 0; i < inputs.length; i += HF_BATCH_SIZE) {
    const chunk = inputs.slice(i, i + HF_BATCH_SIZE);
    const batch = await batchSentimentModel(modelUrl, chunk, deadlineAt);
    out.push(...batch.out);
    skipped += batch.skipped;
  }
  return { out, skipped };
}

// Scores every input individually, splitting into HF_BATCH_SIZE-sized requests
// so a large headline set never exceeds a single payload. Returns one score
// (or null) per input, aligned to the input array.
// Exported for the eval harness (same reason as translateAll above, and like it
// runs unbounded when no `deadlineAt` is passed).
export async function scoreInChunks(modelUrl: string, inputs: string[], deadlineAt?: number): Promise<(number | null)[]> {
  return (await scoreWithin(modelUrl, inputs, deadlineAt)).out;
}

// The scoring breaker's probe: one fixed English headline, so neither a news provider
// nor translation is involved. Its own PROBE_TIMEOUT_MS deadline caps the request
// and its retries, so a hung scorer can't eat the tick's budget.
const PROBE_HEADLINE = "Markets rise after a strong jobs report";
export const PROBE_TIMEOUT_MS = 30_000;
export async function probeScoring(): Promise<boolean> {
  const { out } = await batchSentimentModel(HF_ENGLISH_MODEL, [PROBE_HEADLINE], Date.now() + PROBE_TIMEOUT_MS);
  return typeof out[0] === "number";
}

// A fetch target is a country to refresh. selectDueCountries yields full CountryDef
// entries, but callers/tests may pass a partial ({ code, name }); the fetchers read
// only `code` and (optionally) `lang`.
export interface FetchTarget {
  code: string;
  name: string;
  lang?: string;
}

// Per-country fetch outcome, merged with scores in Phase 5.
interface Meta {
  status: string;
  ms: number;
  attempts: number;
}

// Optional per-run diagnostics filled in place for the cron's debug response.
export interface FetchStats {
  timings?: { fetchMs: number; translateMs: number; scoreMs: number; totalMs: number };
  counts?: {
    countries: number;
    headlines: number;
    toTranslate: number;
    englishScored: number;
    translatedScored: number;
    nullScores: number;
  };
  countries?: Array<{
    code: string;
    status: string | undefined;
    ms: number | undefined;
    articles: number;
    scored: number;
    score: number | null;
  }>;
  // True when every headline sent to the scorer came back unscored for a reason
  // other than the tick budget. Trips the cron's scoring breaker (see SCORING_DOWN_KEY).
  scoringFailed?: boolean;
}

// A headline flattened out for scoring, carrying enough to write results back.
interface ScoreRef {
  code: string;
  idx: number;
  title: string;
  language: string | null;
}

// A country with its raw (un-enriched) headlines, as produced by a fetch batch.
interface FetchedCountry {
  code: string;
  name: string;
  articles: RawArticle[];
}

type Fetcher = (country: FetchTarget, deadlineAt?: number) => Promise<FetchOutcome>;

// Fetch + score a specific subset of countries. `subset` is a list of
// { code, name } entries (a slice of COUNTRIES). Returns one enriched country
// object per input, in input order.
// The optional `stats` object is filled in place with per-stage timings, counts,
// and a per-country breakdown for debugging (surfaced in the cron's response).
// The whole pipeline ends by `budgetMs` after it starts (see TICK_BUDGET_MS).
export async function fetchCountries(
  subset: FetchTarget[],
  stats: FetchStats = {},
  { budgetMs = TICK_BUDGET_MS }: { budgetMs?: number } = {},
): Promise<CountryResult[]> {
  const t0 = now();
  const deadlineAt = t0 + budgetMs;
  const remaining = () => remainingUntil(deadlineAt);
  // Once per tick: the first stage that loses work to the budget says so.
  let budgetLogged = false;
  const noteBudget = (stage: "fetch" | "translate" | "score", skipped: number) => {
    if (budgetLogged) return;
    budgetLogged = true;
    warn("Tick", "budget_exhausted", { stage, skipped });
  };
  // Per-country fetch outcome, keyed by code (merged with scores in Phase 5).
  const meta = new Map<string, Meta>();

  // Phase 1: fetch headlines in two parallel batches - one per provider.
  // Within each batch, requests are spaced by that provider's gap so its rate
  // limit is respected. The two providers share no quota, so the batches can
  // overlap freely and the wall-clock time is max(gnBatchTime, ndBatchTime)
  // instead of their sum.
  const fetchBatch = async (countries: FetchTarget[], fetcher: Fetcher, delayMs: number, provider: string): Promise<FetchedCountry[]> => {
    const results: FetchedCountry[] = [];
    for (let i = 0; i < countries.length; i++) {
      // The courtesy gap is capped too. If the budget ends inside it, the check
      // below skips the country, so a shortened gap never sends a request early.
      if (i > 0) await delay(Math.max(0, Math.min(delayMs, remaining())));
      const { code, name } = countries[i];
      if (remaining() <= 0) {
        // Never sent, so its credit is refunded and the next tick retries it.
        // status does NOT live on the pushed object. FetchedCountry is { code,
        // name, articles }; the status is read back out of `meta` in Phase 5's
        // merge step.
        // `continue`, not `break`: every input still gets exactly one output.
        meta.set(code, { status: "deadline_skipped", ms: 0, attempts: 0 });
        results.push({ code, name, articles: [] });
        continue;
      }
      try {
        const { articles, status, latencyMs, attempts } = await fetcher(countries[i], deadlineAt);
        meta.set(code, { status, ms: latencyMs, attempts });
        log(provider, code, { status, ms: latencyMs, art: articles.length, tries: attempts });
        results.push({ code, name, articles });
      } catch (err) {
        // One country's failure must never abort the remaining countries.
        meta.set(code, { status: "error", ms: 0, attempts: 0 });
        console.error(`[fetchCountries] ${code} headlines:`, err);
        results.push({ code, name, articles: [] });
      }
    }
    return results;
  };

  const tFetch = now();
  const [gnFetched, ndFetched] = await Promise.all([
    fetchBatch(
      subset.filter((c) => HIGH_PRIORITY_CODES.has(c.code)),
      fetchHeadlinesGNews, GNEWS_DELAY_MS, "GNews"
    ),
    fetchBatch(
      subset.filter((c) => !HIGH_PRIORITY_CODES.has(c.code)),
      fetchHeadlines, NEWSDATA_DELAY_MS, "NewsData"
    ),
  ]);
  const fetched = [...gnFetched, ...ndFetched];
  const fetchMs = since(tFetch);
  const fetchSkipped = [...meta.values()].filter((m) => m.status === "deadline_skipped").length;
  // A retry abandoned at the deadline skips no country but still spends the
  // budget, so either signal means it ran out during the fetch.
  if (fetchSkipped > 0 || remaining() <= 0) noteBudget("fetch", fetchSkipped);

  // Phase 2: flatten to individual headlines, all scored by the English model.
  // Each ref carries code + article index so scores and translations can be
  // written back to the right article.
  //   - english headline     → scored on its original text, no translation
  //   - any other language    → translated (for display AND scoring), then the
  //                             English model scores that translation
  const scoreItems: ScoreRef[] = []; // every titled headline, scored by the English model
  const toTranslate: ScoreRef[] = []; // every non-English headline (display + scoring input)
  for (const country of fetched) {
    country.articles.forEach((a, idx) => {
      if (!a.title) return;
      const ref: ScoreRef = { code: country.code, idx, title: a.title, language: a.language };
      scoreItems.push(ref);
      if (a.language !== "english") toTranslate.push(ref);
    });
  }

  // Phase 3a: translate every non-English headline once. The English text is
  // reused both for display and as the scoring input for that headline.
  const tTranslate = now();
  const translated = toTranslate.length
    ? await translateWithin(toTranslate.map((it) => it.title), deadlineAt)
    : { out: [], skipped: 0 };
  const translations = translated.out;
  const translateMs = since(tTranslate);
  // As in the fetch stage: a last request cut short by the deadline skips
  // nothing but still means the budget ran out here.
  if (translated.skipped > 0 || remaining() <= 0) noteBudget("translate", translated.skipped);
  const translationByRef = new Map<ScoreRef, string | null>();
  toTranslate.forEach((ref, i) => translationByRef.set(ref, translations[i] || null));

  // Phase 3b: score every headline with the English model. English headlines are
  // scored on their original title; non-English on their translation. A failed or
  // missing translation becomes "" so batchSentimentModel skips it and yields null.
  const tScore = now();
  const inputs = scoreItems.map((it) =>
    it.language === "english" ? it.title : (translationByRef.get(it) || "")
  );
  const scored = scoreItems.length
    ? await scoreWithin(HF_ENGLISH_MODEL, inputs, deadlineAt)
    : { out: [], skipped: 0 };
  const scores = scored.out;
  const scoreMs = since(tScore);
  if (scored.skipped > 0 || remaining() <= 0) noteBudget("score", scored.skipped);
  // Empty inputs (failed translations) and headlines the budget skipped aren't
  // sent, so they say nothing about the scorer.
  const sentToScorer = inputs.filter((s) => s.length > 0).length - scored.skipped;
  const scoringFailed = sentToScorer > 0 && scores.every((s) => s === null);

  // Phase 4: write scores + English translations back onto each article (null until set)
  const articleScores = new Map<string, (number | null)[]>(fetched.map((c) => [c.code, c.articles.map(() => null)]));
  const articleTrans = new Map<string, (string | null)[]>(fetched.map((c) => [c.code, c.articles.map(() => null)]));
  scoreItems.forEach((it, i) => {
    const arr = articleScores.get(it.code);
    if (arr) arr[it.idx] = scores[i] ?? null;
  });
  toTranslate.forEach((it) => {
    const arr = articleTrans.get(it.code);
    if (arr) arr[it.idx] = translationByRef.get(it) ?? null;
  });

  // Phase 5: country score = average of its headlines' scores (ignoring nulls)
  const perCountry: NonNullable<FetchStats["countries"]> = [];
  const results: CountryResult[] = fetched.map(({ code, name, articles }) => {
    const cScores = articleScores.get(code) ?? [];
    const trans = articleTrans.get(code) ?? [];
    const enriched: Article[] = articles.map((a, idx) => ({
      ...a,
      score: cScores[idx] ?? null,
      translatedTitle: trans[idx] ?? null, // English translation, or null when not needed
    }));
    const valid = cScores.filter((s): s is number => typeof s === "number");
    const avg = valid.length ? valid.reduce((sum, s) => sum + s, 0) / valid.length : null;

    // Per-headline detail is the noisiest output - only when DEBUG_PIPELINE=1.
    if (DEBUG) {
      enriched.forEach((a, idx) =>
        debug("Article", code, { lang: a.language, score: a.score, translated: trans[idx] ? 1 : 0 })
      );
    }

    const m = meta.get(code);
    perCountry.push({
      code,
      status: m?.status,
      ms: m?.ms,
      articles: articles.length,
      scored: valid.length,
      score: avg === null ? null : Number(avg.toFixed(3)),
    });

    return {
      code,
      name,
      score: avg,
      status: m?.status, // lets persistCountries distinguish transient vs terminal
      articles: enriched,
      fetchedAt: new Date().toISOString(),
    };
  });

  // Fill the caller-supplied stats object (used by the cron's debug response).
  const englishScored = scoreItems.filter((it) => it.language === "english").length;
  const translatedScored = scoreItems.length - englishScored;
  const nullScores = scores.filter((s) => s === null).length;
  stats.timings = { fetchMs, translateMs, scoreMs, totalMs: since(t0) };
  stats.counts = {
    countries: subset.length,
    headlines: scoreItems.length,
    toTranslate: toTranslate.length,
    englishScored,
    translatedScored,
    nullScores,
  };
  stats.countries = perCountry;
  stats.scoringFailed = scoringFailed;
  log("Phase", "done", stats.timings);

  return results;
}
