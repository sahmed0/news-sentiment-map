// Shared fetch logic used by both the on-demand handler and the cron pre-warmer

import { now, since, log, debug, DEBUG } from "./logger.js";

// utcOffset = standard-time offset (hours) of the country's primary population
// centre, used to fire each country's daily refresh near 6 am local. Half-hour
// zones are rounded to the nearest hour; DST drift of +-1 h is tolerated since
// NewsData.io's free tier already lags ~12 h, so exact timing doesn't matter.
//
// lang = the country's primary news language as a lowercase English name, in the
// SAME vocabulary NewsData.io reports (see MULTILINGUAL_SUPPORTED_LANGS). High-
// priority countries are fetched from GNews, whose top-headlines response carries
// NO per-article language, so we tag every GNews headline with this value to drive
// the same translate/score routing NewsData's per-article language drives. Azure
// still auto-detects on translate, so a mistagged stray (e.g. an English wire
// story in a non-English feed) degrades gracefully rather than breaking.

export const HIGH_PRIORITY_COUNTRIES = [
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
  { code: "ma", name: "Morocco", utcOffset: 1, lang: "ar" },
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

export const LOW_PRIORITY_COUNTRIES = [
  { code: "ir", name: "Iran", utcOffset: 3, lang: "fa" },
  { code: "hr", name: "Croatia", utcOffset: 1, lang: "hr" },
  { code: "ps", name: "Palestine", utcOffset: 2, lang: "ar" },
  { code: "dk", name: "Denmark", utcOffset: 1, lang: "da" },
  { code: "qa", name: "Qatar", utcOffset: 3, lang: "ar" },
  { code: "by", name: "Belarus", utcOffset: 3, lang: "ru" },
  { code: "dz", name: "Algeria", utcOffset: 1, lang: "ar" },
  { code: "sy", name: "Syria", utcOffset: 3, lang: "ar" },
  { code: "ye", name: "Yemen", utcOffset: 3, lang: "ar" },
  { code: "jo", name: "Jordan", utcOffset: 3, lang: "ar" },
  { code: "iq", name: "Iraq", utcOffset: 3, lang: "ar" },
  { code: "ly", name: "Libya", utcOffset: 2, lang: "ar" },
  { code: "af", name: "Afghanistan", utcOffset: 4, lang: "en" },
  { code: "mm", name: "Myanmar", utcOffset: 6, lang: "my" },
  { code: "uy", name: "Uruguay", utcOffset: -3, lang: "es" },
  { code: "bo", name: "Bolivia", utcOffset: -4, lang: "es" },
  { code: "om", name: "Oman", utcOffset: 4, lang: "ar" },
  { code: "so", name: "Somalia", utcOffset: 3, lang: "en" },
  { code: "sd", name: "Sudan", utcOffset: 2, lang: "ar" },
  { code: "py", name: "Paraguay", utcOffset: -4, lang: "es" },
  { code: "kz", name: "Kazakhstan", utcOffset: 5, lang: "kz" },
  { code: "zm", name: "Zambia", utcOffset: 2, lang: "en" },
  { code: "cd", name: "DR Congo", utcOffset: 1, lang: "fr" },
  { code: "ao", name: "Angola", utcOffset: 1, lang: "pt" },
  { code: "mz", name: "Mozambique", utcOffset: 2, lang: "pt" },
  { code: "uz", name: "Uzbekistan", utcOffset: 5, lang: "uz" },
  { code: "cm", name: "Cameroon", utcOffset: 1, lang: "fr" },
  { code: "mn", name: "Mongolia", utcOffset: 8, lang: "mn" },
  { code: "kp", name: "North Korea", utcOffset: 9, lang: "ko" },
  { code: "ml", name: "Mali", utcOffset: 0, lang: "fr" },
  { code: "td", name: "Chad", utcOffset: 1, lang: "fr" },
  { code: "mr", name: "Mauritania", utcOffset: 0, lang: "ar" },
  { code: "ne", name: "Niger", utcOffset: 1, lang: "fr" },
  { code: "cf", name: "Central African Republic", utcOffset: 1, lang: "fr" },
  { code: "ga", name: "Gabon", utcOffset: 1, lang: "fr" },
  { code: "cg", name: "Congo", utcOffset: 1, lang: "fr" },
  { code: "gn", name: "Guinea", utcOffset: 0, lang: "fr" },
  { code: "ci", name: "Ivory Coast", utcOffset: 0, lang: "fr" },
  { code: "bf", name: "Burkina Faso", utcOffset: 0, lang: "fr" },
  { code: "mg", name: "Madagascar", utcOffset: 3, lang: "fr" },
  { code: "tm", name: "Turkmenistan", utcOffset: 5, lang: "tk" },
  { code: "kg", name: "Kyrgyzstan", utcOffset: 5, lang: "ru" },
  { code: "tj", name: "Tajikistan", utcOffset: 5, lang: "tg" },
  { code: "az", name: "Azerbaijan", utcOffset: 4, lang: "az" },
  { code: "am", name: "Armenia", utcOffset: 4, lang: "hy" },
  { code: "ge", name: "Georgia", utcOffset: 4, lang: "ka" },
  { code: "pg", name: "Papua New Guinea", utcOffset: 10, lang: "en" },
  { code: "kh", name: "Cambodia", utcOffset: 7, lang: "kh" },
  { code: "la", name: "Laos", utcOffset: 7, lang: "en" },
  { code: "al", name: "Albania", utcOffset: 1, lang: "sq" },
  { code: "rs", name: "Serbia", utcOffset: 1, lang: "sr" },
  { code: "ba", name: "Bosnia and Herzegovina", utcOffset: 1, lang: "bs" },
  { code: "mk", name: "North Macedonia", utcOffset: 1, lang: "mk" },
  { code: "me", name: "Montenegro", utcOffset: 1, lang: "sr" },
  { code: "md", name: "Moldova", utcOffset: 2, lang: "ro" },
  { code: "mw", name: "Malawi", utcOffset: 2, lang: "en" },
  { code: "ec", name: "Ecuador", utcOffset: -5, lang: "es" },
  { code: "sr", name: "Suriname", utcOffset: -3, lang: "nl" },
  { code: "gy", name: "Guyana", utcOffset: -4, lang: "en" },
  { code: "lk", name: "Sri Lanka", utcOffset: 6, lang: "en" },
  { code: "np", name: "Nepal", utcOffset: 6, lang: "ne" },
  { code: "gt", name: "Guatemala", utcOffset: -6, lang: "es" },
  { code: "hn", name: "Honduras", utcOffset: -6, lang: "es" },
  { code: "ni", name: "Nicaragua", utcOffset: -6, lang: "es" },
  { code: "cr", name: "Costa Rica", utcOffset: -6, lang: "es" },
  { code: "pa", name: "Panama", utcOffset: -5, lang: "es" },
  { code: "is", name: "Iceland", utcOffset: 0, lang: "is" },
  { code: "tn", name: "Tunisia", utcOffset: 1, lang: "ar" },
  { code: "bt", name: "Bhutan", utcOffset: 6, lang: "en" },
  { code: "kw", name: "Kuwait", utcOffset: 3, lang: "ar" },
  { code: "bh", name: "Bahrain", utcOffset: 3, lang: "ar" },
  { code: "er", name: "Eritrea", utcOffset: 3, lang: "en" },
  { code: "dj", name: "Djibouti", utcOffset: 3, lang: "fr" },
  { code: "rw", name: "Rwanda", utcOffset: 2, lang: "en" },
  { code: "bi", name: "Burundi", utcOffset: 2, lang: "fr" },
  { code: "tg", name: "Togo", utcOffset: 0, lang: "fr" },
  { code: "bj", name: "Benin", utcOffset: 0, lang: "fr" },
  { code: "lr", name: "Liberia", utcOffset: 0, lang: "en" },
  { code: "sl", name: "Sierra Leone", utcOffset: 0, lang: "en" },
  { code: "gm", name: "Gambia", utcOffset: 0, lang: "en" },
  { code: "ls", name: "Lesotho", utcOffset: 2, lang: "en" },
  { code: "gq", name: "Equatorial Guinea", utcOffset: 1, lang: "es" },
  { code: "bz", name: "Belize", utcOffset: -6, lang: "en" },
  { code: "sv", name: "El Salvador", utcOffset: -6, lang: "es" },
  { code: "do", name: "Dominican Republic", utcOffset: -4, lang: "es" },
  { code: "ht", name: "Haiti", utcOffset: -5, lang: "fr" },
];

// All supported countries, high tier first. Derived so existing consumers
// (rebuildAggregate, fetchAllCountries) keep working against one flat list.
export const COUNTRIES = [...HIGH_PRIORITY_COUNTRIES, ...LOW_PRIORITY_COUNTRIES];

// O(1) tier test for the scheduler. Membership = "fetched every day"; every
// country only in LOW_PRIORITY_COUNTRIES is refreshed at most every 3 days
// (see LOW_PRIORITY_DAYS in refresh-core.js).
export const HIGH_PRIORITY_CODES = new Set(HIGH_PRIORITY_COUNTRIES.map((c) => c.code));

export const CACHE_TTL = 25 * 60 * 60; // 25 hours - overlap ensures cron always refreshes before expiry
export const NEWSDATA_DELAY_MS = 2000; // gap between consecutive requests - keeps us under NewsData.io's 1 req/sec limit (1000ms safety margin)
export const NEWSDATA_MAX_RETRIES = 1; // retries on HTTP 429 / transient network errors before giving up on a country
export const NEWSDATA_BACKOFF_BASE_MS = 4000; // first backoff when no Retry-After header is present
export const GNEWS_DELAY_MS = 2000; // gap between consecutive GNews requests - GNews free tier is request-count limited (no strict req/sec), so a small courtesy gap suffices
export const GNEWS_MAX_RETRIES = 1; // retries on HTTP 429 / transient network errors before giving up on a country
export const GNEWS_BACKOFF_BASE_MS = 4000; // first backoff when no Retry-After header is present
export const GNEWS_SIZE = 5; // headlines per high-priority country - matches NewsData's size=5 so cross-provider averages are comparable (free tier caps at 10)

// ISO 639-1 code → NewsData.io / MULTILINGUAL_SUPPORTED_LANGS language name.
// Used in fetchHeadlinesGNews to (a) decide whether to send a `lang=` filter to
// GNews (GNews supports exactly this subset of ISO codes) and (b) tag each GNews
// article with the English name the translate/score router expects - mirroring
// the format NewsData.io uses for its per-article `language` field.
const ISO_TO_NEWSDATA_LANG = {
  "en": "english", "es": "spanish", "it": "italian", "de": "german", "fr": "french",
  "pt": "portuguese", "ru": "russian", "el": "greek", "nl": "dutch", "ja": "japanese",
  "zh": "chinese", "sv": "swedish", "ar": "arabic", "ro": "romanian", "he": "hebrew",
  "uk": "ukrainian", "no": "norwegian", "hi": "hindi",
};

// NewsData.io `language` (ISO 639-1) codes we filter on. Low-priority countries
// already carry their primary language as a 2-letter code (see LOW_PRIORITY_COUNTRIES),
// so fetchHeadlines passes it straight through - but only when it's in this allowlist
// of codes NewsData actually supports. A country whose code is absent (or an invalid
// stray like "kz"/"kh") omits the language parameter and falls back to the country
// filter alone, rather than risking a 422 UnsupportedLanguage.
const NEWSDATA_SUPPORTED_LANGS = new Set([
  "en", "es", "it", "de", "fr", "pt", "ru", "el", "nl", "ja", "zh", "sv", "ar",
  "ro", "he", "uk", "no", "hi", "tr", "ko", "th", "id", "ms", "pl", "cs", "hu",
  "bg", "vi", "bn", "fa", "hr", "da", "et", "lv", "lt", "sk", "sl", "sq", "sr",
  "bs", "mk", "my", "hy", "az", "ne", "ur", "fi", "mn", "ka", "km", "lo", "uz",
]);
export const FETCH_TIMEOUT_MS = 12000; // abort any single external request that hangs, so one stuck connection can't stall the whole tick
export const HF_MAX_RETRIES = 1; // retries on HF 503 (model loading) / 429 / transient network errors before nulling a batch
export const HF_BACKOFF_BASE_MS = 2000; // first backoff when no Retry-After / estimated_time is present
export const HF_MAX_BACKOFF_MS = 20000; // cap a single HF wait (a cold-start estimated_time can be large) so a tick can't stall

// Transient connection-layer failures thrown by undici (Node's fetch) - the
// request never reached an HTTP response, so a quick retry often succeeds.
const RETRYABLE_NETWORK_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT", // connect timed out (newsdata.io:443)
  "UND_ERR_SOCKET",          // socket closed unexpectedly
  "ECONNRESET",              // peer reset the connection
  "ECONNREFUSED",            // peer refused the connection
  "ETIMEDOUT",               // generic socket timeout
  "EAI_AGAIN",               // transient DNS lookup failure
]);

// fetch() rejects with a TypeError whose `cause` carries the real code. An
// AbortSignal.timeout() firing rejects with a DOMException named "TimeoutError" -
// treat that like a transient failure so a slow request retries then gives up.
export function isRetryableNetworkError(err) {
  if (err?.name === "TimeoutError") return true;
  const code = err?.cause?.code ?? err?.code;
  return RETRYABLE_NETWORK_CODES.has(code);
}
const AZURE_BATCH_SIZE = 100;           // Azure Translator max documents per request
const HF_BATCH_SIZE = 50;               // headlines per HuggingFace request - keeps payloads small

// Languages natively supported by cardiffnlp/twitter-xlm-roberta-base-sentiment.
// NewsData.io reports language as a full lowercase English name ("german",
// "english"), NOT a 2-letter code - match those names or every country falls
// through to the Azure-translate path.
const MULTILINGUAL_SUPPORTED_LANGS = new Set([
  "arabic", "english", "french", "german", "hindi", "italian", "portuguese", "spanish",
]);

const HF_ENGLISH_MODEL =
  "https://router.huggingface.co/hf-inference/models/cardiffnlp/twitter-roberta-base-sentiment-latest";
const HF_MULTILINGUAL_MODEL =
  "https://router.huggingface.co/hf-inference/models/cardiffnlp/twitter-xlm-roberta-base-sentiment";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Last path segment of a HF model URL, for terse log lines (e.g. "twitter-xlm-roberta-base-sentiment").
const modelShortName = (url) => url.split("/").pop();

// Normalize a provider timestamp to an ISO string, or null if missing/unparseable.
// new Date(bad).toISOString() THROWS (RangeError), so a single malformed publishedAt
// must be parsed defensively or it would abort the whole country's fetch.
const toIsoOrNull = (value) => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

// Parse a Retry-After header (RFC 7231): either delta-seconds or an HTTP date.
// Returns the wait in ms, or null when the header is missing/unparseable.
export function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(headerValue);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

// Shared retry loop for HTTP headline fetches. Handles two transient failure modes:
//   - HTTP 429: honor Retry-After when present, else exponential backoff.
//   - connection errors (fetch throws): exponential backoff.
// Returns { res, attempts } on a non-429 HTTP response, or
//         { res: null, status, attempts } when retries are exhausted.
async function fetchWithRetry(url, { tag, code, maxRetries, minGapMs, backoffBaseMs }) {
  let res;
  let attempts = 0;
  for (let attempt = 0; ; attempt++) {
    attempts = attempt + 1;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
      if (!isRetryableNetworkError(err)) throw err;
      const errCode = err?.cause?.code ?? err?.code ?? err?.name;
      const status = err?.name === "TimeoutError" ? "timeout" : "network_error";
      if (attempt >= maxRetries) {
        console.error(`[${tag}] ${code}: ${errCode} - gave up after ${attempt} retries`);
        return { res: null, status, attempts };
      }
      const wait = Math.max(minGapMs, backoffBaseMs * 2 ** attempt);
      console.warn(`[${tag}] ${code}: ${errCode} - retrying in ${wait}ms (attempt ${attempt + 1}/${maxRetries})`);
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
    console.warn(`[${tag}] ${code}: HTTP 429 - retrying in ${wait}ms (attempt ${attempt + 1}/${maxRetries})`);
    await delay(wait);
  }
  return { res, status: null, attempts };
}

// Returns { articles, status, latencyMs, attempts } - `status` is a coarse outcome
// label (ok | empty | unsupported | rate_limited | http_<code> | timeout |
// network_error | invalid_json | api_error) the caller folds into the run summary.
async function fetchHeadlines(country) {
  const { code: countryCode, lang } = country;
  const langParam = lang && NEWSDATA_SUPPORTED_LANGS.has(lang) ? `&language=${lang}` : "";
  const url = `https://newsdata.io/api/1/latest?country=${countryCode.toLowerCase()}${langParam}&category=top&prioritydomain=top&sort=source&removeduplicate=1&size=5&apikey=${process.env.NEWSDATA_API_KEY}`;
  const start = now();
  const { res, status: earlyStatus, attempts } = await fetchWithRetry(url, {
    tag: "NewsData", code: countryCode,
    maxRetries: NEWSDATA_MAX_RETRIES, minGapMs: NEWSDATA_DELAY_MS, backoffBaseMs: NEWSDATA_BACKOFF_BASE_MS,
  });
  const out = (articles, status) => ({ articles, status, latencyMs: since(start), attempts });

  if (!res) return out([], earlyStatus);
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
  let data;
  try {
    data = await res.json();
  } catch {
    console.error(`[NewsData] ${countryCode}: invalid JSON response`);
    return out([], "invalid_json");
  }
  if (data.status !== "success") {
    console.error(`[NewsData] ${countryCode}: ${JSON.stringify(data)}`);
    return out([], "api_error");
  }
  // NewsData.io can return the same article multiple times in one response -
  // dedupe by link (falling back to normalized title) so a country isn't filled
  // with repeats and its average isn't skewed by a duplicated headline.
  const seen = new Set();
  const articles = [];
  for (const a of data.results || []) {
    const key = (a.link || a.title || "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    articles.push({
      title: a.title,
      url: a.link,
      publishedAt: toIsoOrNull(a.pubDate ? a.pubDate.replace(" ", "T") + "Z" : null),
      language: a.language || null,
    });
  }
  return out(articles, articles.length ? "ok" : "empty");
}

// GNews top-headlines: popularity/relevance-ranked top stories per country - the
// app's focus - complementing NewsData's recency-only feed. Used for high-priority
// countries (all within GNews's ~71-country coverage). Returns the SAME contract
// as fetchHeadlines - { articles, status, latencyMs, attempts } - so fetchCountries
// can route by tier without caring which provider produced the headlines.
//
// `country` is a HIGH_PRIORITY_COUNTRIES entry (needs `code` + `lang`). GNews gives
// no per-article language, so every headline is tagged with `country.lang`.
async function fetchHeadlinesGNews(country) {
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
  if (ISO_TO_NEWSDATA_LANG[lang]) params.set("lang", lang);
  const url = `https://gnews.io/api/v4/top-headlines?${params}`;
  const start = now();
  const { res, status: earlyStatus, attempts } = await fetchWithRetry(url, {
    tag: "GNews", code,
    maxRetries: GNEWS_MAX_RETRIES, minGapMs: GNEWS_DELAY_MS, backoffBaseMs: GNEWS_BACKOFF_BASE_MS,
  });
  const out = (articles, status) => ({ articles, status, latencyMs: since(start), attempts });

  if (!res) return out([], earlyStatus);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[GNews] ${code}: HTTP ${res.status} - ${body.slice(0, 400)}`);
    return out([], `http_${res.status}`);
  }
  let data;
  try {
    data = await res.json();
  } catch {
    console.error(`[GNews] ${code}: invalid JSON response`);
    return out([], "invalid_json");
  }
  if (!Array.isArray(data.articles)) {
    console.error(`[GNews] ${code}: ${JSON.stringify(data).slice(0, 400)}`);
    return out([], "api_error");
  }
  // Dedupe by url (falling back to normalized title) so a country isn't filled
  // with repeats - mirrors the NewsData path.
  const seen = new Set();
  const articles = [];
  for (const a of data.articles) {
    const key = (a.url || a.title || "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    articles.push({
      title: a.title,
      url: a.url,
      publishedAt: toIsoOrNull(a.publishedAt),
      // Convert ISO code to the English name MULTILINGUAL_SUPPORTED_LANGS and the
      // "english" routing guard expect. Falls back to the ISO code for unmapped
      // languages (they route to the translate path, which is correct).
      language: ISO_TO_NEWSDATA_LANG[lang] ?? lang,
    });
  }
  return out(articles, articles.length ? "ok" : "empty");
}

function dominantLanguage(articles) {
  const counts = {};
  for (const { language } of articles) {
    if (language) counts[language] = (counts[language] || 0) + 1;
  }
  let best = null, bestCount = 0;
  for (const [lang, count] of Object.entries(counts)) {
    if (count > bestCount) { best = lang; bestCount = count; }
  }
  return best;
}

async function translateHeadlines(titles) {
  if (!titles.length) return titles;
  const headers = {
    "Ocp-Apim-Subscription-Key": process.env.AZURE_TRANSLATOR_KEY,
    "Content-Type": "application/json",
  };
  // Regional (non-Global) Translator resources require the region header,
  // otherwise the global endpoint rejects the key with HTTP 401 (code 401001).
  if (process.env.AZURE_TRANSLATOR_REGION) {
    headers["Ocp-Apim-Subscription-Region"] = process.env.AZURE_TRANSLATOR_REGION;
  }
  const start = now();
  let res;
  try {
    res = await fetch(
      "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=en",
      {
        method: "POST",
        headers,
        body: JSON.stringify(titles.map((t) => ({ Text: t }))),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    );
  } catch (e) {
    // Timeout or connection error: degrade like an HTTP failure so callers
    // substitute empty translations rather than the whole tick hanging.
    const status = e?.name === "TimeoutError" ? "timeout" : "network_error";
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
    const results = JSON.parse(rawBody);
    log("Azure", "translate", { status: "ok", docs: titles.length, ms: since(start) });
    return results.map((r) => r.translations?.[0]?.text ?? "");
  } catch {
    log("Azure", "translate", { status: "invalid_json", docs: titles.length, ms: since(start) });
    console.error(`[Azure] translate invalid response: ${rawBody.slice(0, 200)}`);
    return null;
  }
}

async function translateAll(titles) {
  const out = [];
  for (let i = 0; i < titles.length; i += AZURE_BATCH_SIZE) {
    const chunk = titles.slice(i, i + AZURE_BATCH_SIZE);
    const translated = await translateHeadlines(chunk);
    // On Azure failure, substitute empty strings so HF scores null rather than untranslated text
    out.push(...(translated !== null ? translated : chunk.map(() => "")));
  }
  return out;
}

async function batchSentimentModel(modelUrl, inputs) {
  // Skip empty inputs but track original indices so scores align with the input array
  const nonempty = inputs.map((input, i) => ({ i, input })).filter(({ input }) => input.length > 0);
  const scores = inputs.map(() => null);
  if (!nonempty.length) return scores;

  const model = modelShortName(modelUrl);
  const start = now();

  // Retry loop for transient failures (mirrors fetchHeadlines): a connection
  // error, a timeout, HTTP 503 "model loading" (cold start), or HTTP 429. Only
  // after retries are exhausted do we fall back to the all-null `scores` array
  // so a momentary blip can't durably leave a whole batch of countries unscored.
  let results;
  for (let attempt = 0; ; attempt++) {
    let res;
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
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      // Timeout or connection error: retry if transient, else null the batch so
      // it degrades gracefully instead of stalling the tick.
      const status = e?.name === "TimeoutError" ? "timeout" : "network_error";
      if (isRetryableNetworkError(e) && attempt < HF_MAX_RETRIES) {
        const wait = Math.min(HF_MAX_BACKOFF_MS, HF_BACKOFF_BASE_MS * 2 ** attempt);
        console.warn(`[HuggingFace] ${model}: ${status} - retrying in ${wait}ms (attempt ${attempt + 1}/${HF_MAX_RETRIES})`);
        await delay(wait);
        continue;
      }
      log("HF", model, { status, items: nonempty.length, ms: since(start) });
      console.error(`[HuggingFace] request failed: ${e?.name ?? e?.cause?.code ?? e}`);
      return scores;
    }

    const rawBody = await res.text().catch(() => "");

    if (!res.ok) {
      // 503 (model cold-start) and 429 (rate limited) are transient - back off and retry.
      const transient = res.status === 503 || res.status === 429;
      if (transient && attempt < HF_MAX_RETRIES) {
        let wait = parseRetryAfter(res.headers.get("retry-after"));
        if (wait === null && res.status === 503) {
          try {
            const { estimated_time } = JSON.parse(rawBody);
            if (Number.isFinite(estimated_time)) wait = estimated_time * 1000;
          } catch {
            // Non-JSON 503 body; fall through to exponential backoff.
          }
        }
        wait = Math.min(HF_MAX_BACKOFF_MS, wait ?? HF_BACKOFF_BASE_MS * 2 ** attempt);
        console.warn(`[HuggingFace] ${model}: HTTP ${res.status} - retrying in ${wait}ms (attempt ${attempt + 1}/${HF_MAX_RETRIES})`);
        await delay(wait);
        continue;
      }
      log("HF", model, { status: `http_${res.status}`, items: nonempty.length, ms: since(start) });
      console.error(`[HuggingFace] HTTP ${res.status}: ${rawBody.slice(0, 200)}`);
      return scores;
    }

    try {
      results = JSON.parse(rawBody);
    } catch {
      log("HF", model, { status: "invalid_json", items: nonempty.length, ms: since(start) });
      console.error(`[HuggingFace] JSON parse failed: ${rawBody.slice(0, 300)}`);
      return scores;
    }

    if (!Array.isArray(results)) {
      log("HF", model, { status: "bad_shape", items: nonempty.length, ms: since(start) });
      console.error(`[HuggingFace] Unexpected response: ${rawBody.slice(0, 200)}`);
      return scores;
    }
    break; // success
  }

  // HF returns [{label,score},...] for a single input, [[{label,score},...],...]  for a batch
  const isBatch = Array.isArray(results[0]);
  const normalized = isBatch ? results : [results];

  nonempty.forEach(({ i }, j) => {
    const labelArr = normalized[j];
    if (!Array.isArray(labelArr)) return;
    let score = 0;
    for (const item of labelArr) {
      const lbl = item?.label?.toLowerCase();
      if (!lbl || typeof item.score !== "number") continue;
      if (lbl.includes("positive")) score += item.score;
      if (lbl.includes("negative")) score -= item.score;
    }
    scores[i] = score;
  });
  log("HF", model, { status: "ok", items: nonempty.length, ms: since(start) });
  return scores;
}

// Scores every input individually, splitting into HF_BATCH_SIZE-sized requests
// so a large headline set never exceeds a single payload. Returns one score
// (or null) per input, aligned to the input array.
async function scoreInChunks(modelUrl, inputs) {
  const scores = [];
  for (let i = 0; i < inputs.length; i += HF_BATCH_SIZE) {
    const chunk = inputs.slice(i, i + HF_BATCH_SIZE);
    scores.push(...(await batchSentimentModel(modelUrl, chunk)));
  }
  return scores;
}

// Fetch + score a specific subset of countries. `subset` is a list of
// { code, name } entries (a slice of COUNTRIES). Returns one enriched country
// object per input, in input order. `fetchAllCountries` is the whole-world case.
// The optional `stats` object is filled in place with per-stage timings, counts,
// and a per-country breakdown for debugging (surfaced in the cron's response).
export async function fetchCountries(subset, stats = {}) {
  const t0 = now();
  // Per-country fetch outcome, keyed by code (merged with scores in Phase 5).
  const meta = new Map();

  // Phase 1: fetch headlines in two parallel batches - one per provider.
  // Within each batch, requests are spaced by that provider's gap so its rate
  // limit is respected. The two providers share no quota, so the batches can
  // overlap freely and the wall-clock time is max(gnBatchTime, ndBatchTime)
  // instead of their sum.
  const fetchBatch = async (countries, fetcher, delayMs, provider) => {
    const results = [];
    for (let i = 0; i < countries.length; i++) {
      if (i > 0) await delay(delayMs);
      const { code, name } = countries[i];
      try {
        const { articles, status, latencyMs, attempts } = await fetcher(countries[i]);
        meta.set(code, { status, ms: latencyMs, attempts });
        log(provider, code, { status, ms: latencyMs, art: articles.length, tries: attempts });
        results.push({ code, name, articles, lang: dominantLanguage(articles) });
      } catch (err) {
        // One country's failure must never abort the remaining countries.
        meta.set(code, { status: "error", ms: 0, attempts: 0 });
        console.error(`[fetchCountries] ${code} headlines:`, err);
        results.push({ code, name, articles: [], lang: null });
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

  // Phase 2: flatten to individual headlines, routed by EACH headline's own
  // language (not the country's dominant one). Each ref carries code + article
  // index so scores and translations can be written back to the right article.
  //   - supported language (incl. english) → scored on the original text
  //   - other language                     → scored on its English translation
  //   - any non-English headline           → translated for display regardless
  const multiItems = []; // scored directly by the multilingual model
  const transItems = []; // scored by the English model, on the translation
  const toTranslate = []; // every non-English headline (display + trans-scoring)
  for (const country of fetched) {
    country.articles.forEach((a, idx) => {
      if (!a.title) return;
      const ref = { code: country.code, idx, title: a.title };
      if (MULTILINGUAL_SUPPORTED_LANGS.has(a.language)) multiItems.push(ref);
      else transItems.push(ref);
      if (a.language !== "english") toTranslate.push(ref);
    });
  }

  // Phase 3a: translate every non-English headline once. The English text is
  // reused both for display and for scoring the non-multilingual headlines.
  const tTranslate = now();
  const translations = toTranslate.length
    ? await translateAll(toTranslate.map((it) => it.title))
    : [];
  const translateMs = since(tTranslate);
  const translationByRef = new Map();
  toTranslate.forEach((ref, i) => translationByRef.set(ref, translations[i] || null));

  // Phase 3b: score every headline individually (multilingual + English in parallel)
  const tScore = now();
  const [multiScores, transScores] = await Promise.all([
    multiItems.length
      ? scoreInChunks(HF_MULTILINGUAL_MODEL, multiItems.map((it) => it.title))
      : Promise.resolve([]),
    transItems.length
      ? scoreInChunks(HF_ENGLISH_MODEL, transItems.map((it) => translationByRef.get(it) || ""))
      : Promise.resolve([]),
  ]);
  const scoreMs = since(tScore);

  // Phase 4: write scores + English translations back onto each article (null until set)
  const articleScores = new Map(fetched.map((c) => [c.code, c.articles.map(() => null)]));
  const articleTrans = new Map(fetched.map((c) => [c.code, c.articles.map(() => null)]));
  multiItems.forEach((it, i) => { articleScores.get(it.code)[it.idx] = multiScores[i] ?? null; });
  transItems.forEach((it, i) => { articleScores.get(it.code)[it.idx] = transScores[i] ?? null; });
  toTranslate.forEach((it) => { articleTrans.get(it.code)[it.idx] = translationByRef.get(it); });

  // Phase 5: country score = average of its headlines' scores (ignoring nulls)
  const perCountry = [];
  const results = fetched.map(({ code, name, articles }) => {
    const scores = articleScores.get(code);
    const trans = articleTrans.get(code);
    const enriched = articles.map((a, idx) => ({
      ...a,
      score: scores[idx],
      translatedTitle: trans[idx], // English translation, or null when not needed
    }));
    const valid = scores.filter((s) => typeof s === "number");
    const avg = valid.length ? valid.reduce((sum, s) => sum + s, 0) / valid.length : null;

    // Per-headline detail is the noisiest output - only when DEBUG_PIPELINE=1.
    if (DEBUG) {
      enriched.forEach((a, idx) =>
        debug("Article", code, { lang: a.language, score: a.score, translated: trans[idx] ? 1 : 0 })
      );
    }

    const m = meta.get(code) || {};
    perCountry.push({
      code,
      status: m.status,
      ms: m.ms,
      articles: articles.length,
      scored: valid.length,
      score: avg === null ? null : Number(avg.toFixed(3)),
    });

    return {
      code,
      name,
      score: avg,
      articles: enriched,
      fetchedAt: new Date().toISOString(),
    };
  });

  // Fill the caller-supplied stats object (used by the cron's debug response).
  const nullScores =
    multiScores.filter((s) => s === null).length + transScores.filter((s) => s === null).length;
  stats.timings = { fetchMs, translateMs, scoreMs, totalMs: since(t0) };
  stats.counts = {
    countries: subset.length,
    headlines: multiItems.length + transItems.length,
    toTranslate: toTranslate.length,
    multiScored: multiItems.length,
    transScored: transItems.length,
    nullScores,
  };
  stats.countries = perCountry;
  log("Phase", "done", stats.timings);

  return results;
}

// Whole-world fetch - kept for the daily safety-net cron and any full reconcile.
export async function fetchAllCountries() {
  return fetchCountries(COUNTRIES);
}
