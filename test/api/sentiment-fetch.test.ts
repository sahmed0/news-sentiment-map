import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchCountries,
  parseRetryAfter,
  isRetryableNetworkError,
  newsDataLanguages,
  newsDataQuery,
  translateAll,
  scoreInChunks,
  probeScoring,
  PROBE_TIMEOUT_MS,
  HF_ENGLISH_MODEL,
  LOW_PRIORITY_COUNTRIES,
  TICK_BUDGET_MS,
  type FetchStats,
} from "../../api/_lib/sentiment-fetch.js";
import { persistCountries, refundCounts, HISTORY_KEY } from "../../api/_lib/refresh-core.js";
import { createFakeRedis } from "../helpers/fakeRedis.js";

// ---- Response / fetch helpers -------------------------------------------------

// A route handler is either a canned response or a function of (url, opts). These
// are test doubles for `fetch`, so their shapes are deliberately loose.
type FakeResponse = ReturnType<typeof makeResponse>;
type Route = FakeResponse | ((url: string, opts: any) => FakeResponse | Promise<FakeResponse>);
interface Routes {
  news?: Route;
  gnews?: Route;
  hfMulti?: Route;
  hfEng?: Route;
  azure?: Route;
}

// Minimal Response double exposing only what the code touches: status, ok,
// headers.get(), text(), json().
function makeResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => h.get(String(k).toLowerCase()) ?? null },
    text: async () => raw,
    json: async () => JSON.parse(raw),
  };
}

// Route fetch by URL to per-endpoint handlers (static response or fn(url, opts)).
// The multilingual model was removed from the pipeline; its `hfMulti` route is
// kept (left unconfigured by every test) purely as a tripwire - if the code ever
// hits the multilingual URL again, `resolve` throws "no handler configured".
function installFetch({ news, gnews, hfMulti, hfEng, azure }: Routes = {}) {
  const resolve = (h: Route | undefined, url: string, opts: any) => {
    if (h == null) throw new Error("no handler configured for: " + url);
    return typeof h === "function" ? h(url, opts) : h;
  };
  const fn = vi.fn(async (url: string, opts: any) => {
    if (url.startsWith("https://newsdata.io/")) return resolve(news, url, opts);
    if (url.startsWith("https://gnews.io/")) return resolve(gnews, url, opts);
    if (url.includes("twitter-xlm-roberta-base-sentiment")) return resolve(hfMulti, url, opts);
    if (url.includes("twitter-roberta-base-sentiment-latest")) return resolve(hfEng, url, opts);
    if (url.includes("cognitive.microsofttranslator")) return resolve(azure, url, opts);
    throw new Error("unexpected fetch URL: " + url);
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

// NewsData success body with the given articles.
const newsOk = (articles: unknown[]) => makeResponse(200, { status: "success", results: articles });

// GNews success body with the given articles (no per-article language field).
const gnewsOk = (articles: unknown[]) => makeResponse(200, { totalArticles: articles.length, articles });

// HF handler that scores every input positively (0.8 net). Mirrors the real
// [[{label,score},...],...] batch shape.
const hfPositive = (url: string, opts: any) => {
  const { inputs } = JSON.parse(opts.body);
  return makeResponse(
    200,
    inputs.map(() => [
      { label: "positive", score: 0.8 },
      { label: "neutral", score: 0.1 },
      { label: "negative", score: 0.0 },
    ])
  );
};

// Azure handler that echoes each title prefixed with "EN:".
const azureEcho = (url: string, opts: any) => {
  const docs = JSON.parse(opts.body); // [{ Text }]
  return makeResponse(200, docs.map((d: { Text: string }) => ({ translations: [{ text: "EN:" + d.Text }] })));
};

const netError = (code: string) => Object.assign(new Error("conn"), { cause: { code } });
const timeoutError = () => Object.assign(new Error("t"), { name: "TimeoutError" });

beforeEach(() => {
  vi.stubEnv("NEWSDATA_API_KEY", "test-news-key");
  vi.stubEnv("GNEWS_API_KEY", "test-gnews-key");
  vi.stubEnv("HUGGINGFACE_API_KEY", "test-hf-key");
  vi.stubEnv("AZURE_TRANSLATOR_KEY", "test-azure-key");
  vi.stubEnv("AZURE_TRANSLATOR_REGION", "eastus");
  // Quiet the pipeline's console noise during expected error-path tests.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---- Pure helpers -------------------------------------------------------------

describe("parseRetryAfter", () => {
  it("parses delta-seconds into milliseconds", () => {
    expect(parseRetryAfter("10")).toBe(10000);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("clamps negative delta-seconds to 0", () => {
    expect(parseRetryAfter("-5")).toBe(0);
  });

  it("parses an HTTP-date into a forward-looking wait", () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(5000);
  });

  it("returns null for missing or unparseable values", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("not-a-date")).toBeNull();
  });
});

describe("isRetryableNetworkError", () => {
  it("treats AbortSignal timeouts as retryable", () => {
    expect(isRetryableNetworkError(timeoutError())).toBe(true);
  });

  it("treats known undici connection codes as retryable (via cause.code or code)", () => {
    expect(isRetryableNetworkError(netError("ECONNRESET"))).toBe(true);
    expect(isRetryableNetworkError({ code: "ETIMEDOUT" })).toBe(true);
    expect(isRetryableNetworkError(netError("UND_ERR_SOCKET"))).toBe(true);
  });

  it("treats unknown errors as non-retryable", () => {
    expect(isRetryableNetworkError(new Error("nope"))).toBe(false);
    expect(isRetryableNetworkError(netError("EHOSTUNREACH"))).toBe(false);
  });
});

// ---- NewsData query builder --------------------------------------------------

describe("newsDataQuery", () => {
  const q = (lang: string | undefined, code = "xx") => newsDataQuery({ code, lang });

  it("sends a single supported code as-is (Gambia)", () => {
    expect(q("en", "gm")).toBe("country=gm&language=en&removeduplicate=1&size=5");
  });

  it("sends a multi-code list instead of dropping it (Algeria)", () => {
    expect(q("ar,en,fr", "dz")).toBe("country=dz&language=ar,en,fr&removeduplicate=1&size=5");
  });

  it("keeps the corrected Khmer code (Cambodia)", () => {
    expect(q("km,en", "kh")).toBe("country=kh&language=km,en&removeduplicate=1&size=5");
  });

  it("drops unsupported codes from a mixed list, keeping order", () => {
    expect(q("bm,fr,en", "ml")).toBe("country=ml&language=fr,en&removeduplicate=1&size=5");
    expect(q(" fr , zz ,en ")).toBe("country=xx&language=fr,en&removeduplicate=1&size=5");
  });

  it("leaves a country with no filterable local language on en alone (Tajikistan)", () => {
    expect(q("tk,en", "tm")).toBe("country=tm&language=tk,en&removeduplicate=1&size=5");
    expect(q("tg,en", "tj")).toBe("country=tj&language=en&removeduplicate=1&size=5");
  });

  it("omits the parameter when no code is supported, or there is no list", () => {
    expect(q("zz,yy")).toBe("country=xx&removeduplicate=1&size=5");
    expect(q("")).toBe("country=xx&removeduplicate=1&size=5");
    expect(q(undefined)).toBe("country=xx&removeduplicate=1&size=5");
  });

  it("keeps a five-code list unchanged (Montenegro)", () => {
    expect(q("en,sr,bs,sq,hr", "me")).toBe("country=me&language=en,sr,bs,sq,hr&removeduplicate=1&size=5");
  });

  it("keeps only the first five of six supported codes (NewsData's per-query limit)", () => {
    expect(q("en,fr,es,pt,ar,ru")).toBe("country=xx&language=en,fr,es,pt,ar&removeduplicate=1&size=5");
  });

  it("sends no en for the countries that dropped it to break a duplicate cluster", () => {
    const byCode = new Map(LOW_PRIORITY_COUNTRIES.map((c) => [c.code, c]));
    const query = (code: string): string => {
      const c = byCode.get(code);
      if (!c) throw new Error(`${code} missing`);
      return newsDataQuery(c);
    };
    expect(query("kp")).toBe("country=kp&language=ko&removeduplicate=1&size=5");
    expect(query("mg")).toBe("country=mg&language=fr&removeduplicate=1&size=5");
    expect(query("gq")).toBe("country=gq&language=es,fr,pt&removeduplicate=1&size=5");
  });

  it("never sorts by source (the cause of the duplicate article sets)", () => {
    for (const c of LOW_PRIORITY_COUNTRIES) expect(newsDataQuery(c)).not.toContain("sort=");
  });

  it("gives every low-priority country a language filter of at most five codes", () => {
    for (const c of LOW_PRIORITY_COUNTRIES) {
      const langs = newsDataLanguages(c.lang);
      expect(langs.length, c.code).toBeGreaterThan(0);
      expect(langs.length, c.code).toBeLessThanOrEqual(5);
    }
  });
});

// ---- HTTP request validity & happy path --------------------------------------

describe("fetchCountries - request construction & scoring", () => {
  it("builds the NewsData request URL and scores an English country via the English model on the original title", async () => {
    const fetchFn = installFetch({
      news: newsOk([
        { title: "Good news", link: "http://a", pubDate: "2024-01-01 10:00:00", language: "english" },
      ]),
      hfEng: hfPositive,
    });

    const stats: any = {};
    const results = await fetchCountries([{ code: "ly", name: "Libya", lang: "ar" }], stats);

    const newsCall = fetchFn.mock.calls.find(([u]) => u.startsWith("https://newsdata.io/"))!;
    // The country's 2-letter lang (a NewsData-supported code) is passed straight
    // through as the &language= filter.
    expect(newsCall[0]).toBe(
      "https://newsdata.io/api/1/latest?country=ly&language=ar&removeduplicate=1&size=5&apikey=test-news-key"
    );
    // English headlines are scored by the English model on their original text;
    // the multilingual model and the translator are never called.
    expect(fetchFn.mock.calls.some(([u]) => u.includes("twitter-roberta-base-sentiment-latest"))).toBe(true);
    expect(fetchFn.mock.calls.some(([u]) => u.includes("twitter-xlm-roberta"))).toBe(false);
    expect(fetchFn.mock.calls.some(([u]) => u.includes("microsofttranslator"))).toBe(false);

    // The English model receives the untranslated original title.
    const hfCall = fetchFn.mock.calls.find(([u]) => u.includes("twitter-roberta-base-sentiment-latest"))!;
    expect(JSON.parse(hfCall[1].body).inputs[0]).toBe("Good news");

    expect(results).toHaveLength(1);
    expect(results[0].code).toBe("ly");
    expect(results[0].score).toBeCloseTo(0.8, 5);
    expect(results[0].articles[0].score).toBeCloseTo(0.8, 5);
    expect(results[0].articles[0].translatedTitle).toBeNull();
    expect(typeof results[0].fetchedAt).toBe("string");
    expect(Number.isNaN(Date.parse(results[0].fetchedAt))).toBe(false);

    expect(stats.counts).toMatchObject({
      countries: 1, headlines: 1, englishScored: 1, translatedScored: 0, toTranslate: 0, nullScores: 0,
    });
  });

  it("omits the NewsData language filter for a lang code NewsData doesn't support", async () => {
    const fetchFn = installFetch({
      news: newsOk([{ title: "Hi", link: "http://a", pubDate: null, language: "english" }]),
      hfEng: hfPositive,
    });
    // "kz" is a country code, not a language code -> no language parameter.
    await fetchCountries([{ code: "kz", name: "Kazakhstan", lang: "kz" }]);
    const newsCall = fetchFn.mock.calls.find(([u]) => u.startsWith("https://newsdata.io/"))!;
    expect(newsCall[0]).not.toContain("language=");
  });

  it("sends the HF request with parameters.top_k = null", async () => {
    const fetchFn = installFetch({
      news: newsOk([{ title: "Hi", link: "http://a", pubDate: null, language: "english" }]),
      hfEng: hfPositive,
    });
    await fetchCountries([{ code: "ly", name: "Libya" }]);
    const hfCall = fetchFn.mock.calls.find(([u]) => u.includes("twitter-roberta-base-sentiment-latest"))!;
    const body = JSON.parse(hfCall[1].body);
    expect(body.parameters).toEqual({ top_k: null });
    expect(hfCall[1].headers.Authorization).toBe("Bearer test-hf-key");
  });

  it("translates a non-English/unsupported language and scores it with the English model", async () => {
    const fetchFn = installFetch({
      news: newsOk([{ title: "こんにちは", link: "http://jp", pubDate: null, language: "japanese" }]),
      hfEng: hfPositive,
      azure: azureEcho,
    });

    const results = await fetchCountries([{ code: "dz", name: "Algeria" }]);

    // Japanese is not natively supported → translated, then scored by English model.
    expect(fetchFn.mock.calls.some(([u]) => u.includes("twitter-roberta-base-sentiment-latest"))).toBe(true);
    expect(fetchFn.mock.calls.some(([u]) => u.includes("twitter-xlm-roberta"))).toBe(false);

    const azureCall = fetchFn.mock.calls.find(([u]) => u.includes("microsofttranslator"))!;
    expect(azureCall[1].headers["Ocp-Apim-Subscription-Region"]).toBe("eastus");

    const hfEngCall = fetchFn.mock.calls.find(([u]) => u.includes("twitter-roberta-base-sentiment-latest"))!;
    expect(JSON.parse(hfEngCall[1].body).inputs[0]).toBe("EN:こんにちは");

    expect(results[0].articles[0].translatedTitle).toBe("EN:こんにちは");
    expect(results[0].score).toBeCloseTo(0.8, 5);
  });

  it("scores a formerly-multilingual language (German) with the English model on its translation", async () => {
    const fetchFn = installFetch({
      news: newsOk([{ title: "Guten Tag", link: "http://de", pubDate: null, language: "german" }]),
      hfEng: hfPositive,
      azure: azureEcho,
    });

    const results = await fetchCountries([{ code: "ly", name: "Libya" }]);

    // German is no longer scored natively: it is translated and the English model
    // scores that translation. The multilingual model is never called.
    expect(fetchFn.mock.calls.some(([u]) => u.includes("twitter-xlm-roberta"))).toBe(false);
    expect(fetchFn.mock.calls.some(([u]) => u.includes("microsofttranslator"))).toBe(true); // translated for display + scoring
    const hfCall = fetchFn.mock.calls.find(([u]) => u.includes("twitter-roberta-base-sentiment-latest"))!;
    expect(JSON.parse(hfCall[1].body).inputs[0]).toBe("EN:Guten Tag");
    expect(results[0].articles[0].translatedTitle).toBe("EN:Guten Tag");
    expect(results[0].score).toBeCloseTo(0.8, 5);
  });

  it("dedupes repeated articles by link before scoring", async () => {
    const fetchFn = installFetch({
      news: newsOk([
        { title: "A", link: "http://dup", language: "english" },
        { title: "A again", link: "http://dup", language: "english" }, // same link → dropped
        { title: "B", link: "http://b", language: "english" },
      ]),
      hfEng: hfPositive,
    });

    const results = await fetchCountries([{ code: "ly", name: "Libya" }]);
    expect(results[0].articles).toHaveLength(2);
    const hfCall = fetchFn.mock.calls.find(([u]) => u.includes("twitter-roberta-base-sentiment-latest"))!;
    expect(JSON.parse(hfCall[1].body).inputs).toHaveLength(2);
  });

  it("parses the single-input HF response shape ([{label}…], not nested)", async () => {
    installFetch({
      news: newsOk([{ title: "Solo", link: "http://a", language: "english" }]),
      // One headline → return the flat single-input shape the HF router uses.
      hfEng: makeResponse(200, [
        { label: "positive", score: 0.7 },
        { label: "negative", score: 0.1 },
      ]),
    });
    const results = await fetchCountries([{ code: "ly", name: "Libya" }]);
    expect(results[0].score).toBeCloseTo(0.6, 5); // 0.7 − 0.1
  });
});

// ---- GNews routing (high-priority countries) ---------------------------------

describe("fetchCountries - GNews routing for high-priority countries", () => {
  it("routes a high-priority country to GNews, builds the URL with the lang filter, and never calls NewsData", async () => {
    const fetchFn = installFetch({
      gnews: gnewsOk([{ title: "Big story", url: "http://us", publishedAt: "2024-01-01T10:00:00Z" }]),
      hfEng: hfPositive,
    });

    const results = await fetchCountries([{ code: "us", name: "United States", lang: "en" }]);

    const gnewsCall = fetchFn.mock.calls.find(([u]) => u.startsWith("https://gnews.io/"))!;
    expect(gnewsCall[0]).toBe(
      "https://gnews.io/api/v4/top-headlines?category=general&country=us&max=5&apikey=test-gnews-key&lang=en"
    );
    // High-priority → GNews only; NewsData is never touched.
    expect(fetchFn.mock.calls.some(([u]) => u.startsWith("https://newsdata.io/"))).toBe(false);
    // English headline → scored on the original text by the English model, no
    // translation; the multilingual model is never called.
    expect(fetchFn.mock.calls.some(([u]) => u.includes("twitter-roberta-base-sentiment-latest"))).toBe(true);
    expect(fetchFn.mock.calls.some(([u]) => u.includes("twitter-xlm-roberta"))).toBe(false);
    expect(fetchFn.mock.calls.some(([u]) => u.includes("microsofttranslator"))).toBe(false);
    expect(results[0].code).toBe("us");
    expect(results[0].score).toBeCloseTo(0.8, 5);
    expect(results[0].articles[0].url).toBe("http://us");
  });

  it("tags GNews headlines (no per-article language) with the country's lang, then translates and scores German via the English model", async () => {
    const fetchFn = installFetch({
      gnews: gnewsOk([{ title: "Guten Tag", url: "http://de", publishedAt: null }]),
      hfEng: hfPositive,
      azure: azureEcho,
    });

    const results = await fetchCountries([{ code: "de", name: "Germany", lang: "de" }]);

    const gnewsCall = fetchFn.mock.calls.find(([u]) => u.startsWith("https://gnews.io/"))!;
    expect(gnewsCall[0]).toContain("country=de");
    expect(gnewsCall[0]).toContain("lang=de");
    // German is translated, then the English model scores the translation; the
    // multilingual model is never called.
    expect(fetchFn.mock.calls.some(([u]) => u.includes("twitter-xlm-roberta"))).toBe(false);
    expect(fetchFn.mock.calls.some(([u]) => u.includes("microsofttranslator"))).toBe(true);
    const hfCall = fetchFn.mock.calls.find(([u]) => u.includes("twitter-roberta-base-sentiment-latest"))!;
    expect(JSON.parse(hfCall[1].body).inputs[0]).toBe("EN:Guten Tag");
    expect(results[0].articles[0].language).toBe("german"); // tagged from the country
    expect(results[0].articles[0].translatedTitle).toBe("EN:Guten Tag");
    expect(results[0].score).toBeCloseTo(0.8, 5);
  });

  it("omits the lang filter for a country whose language GNews doesn't support, and still translates it", async () => {
    const fetchFn = installFetch({
      gnews: gnewsOk([{ title: "Merhaba", url: "http://tr", publishedAt: null }]),
      hfEng: hfPositive,
      azure: azureEcho,
    });

    const results = await fetchCountries([{ code: "tr", name: "Turkey", lang: "tr" }]);

    const gnewsCall = fetchFn.mock.calls.find(([u]) => u.startsWith("https://gnews.io/"))!;
    expect(gnewsCall[0]).toContain("country=tr");
    expect(gnewsCall[0]).not.toContain("lang="); // turkish has no GNews lang code
    // Non-English → translated, then scored by the English model; no multilingual call.
    expect(fetchFn.mock.calls.some(([u]) => u.includes("microsofttranslator"))).toBe(true);
    expect(fetchFn.mock.calls.some(([u]) => u.includes("twitter-roberta-base-sentiment-latest"))).toBe(true);
    expect(fetchFn.mock.calls.some(([u]) => u.includes("twitter-xlm-roberta"))).toBe(false);
    expect(results[0].articles[0].translatedTitle).toBe("EN:Merhaba");
    expect(results[0].score).toBeCloseTo(0.8, 5);
  });

  it("dedupes repeated GNews articles by url and reports rate_limited→empty after exhausting retries on 429", async () => {
    vi.useFakeTimers();
    const fetchFn = installFetch({
      gnews: () => makeResponse(429, { errors: ["rate"] }, { "retry-after": "1" }),
    });

    const promise = fetchCountries([{ code: "us", name: "United States", lang: "en" }]);
    await vi.advanceTimersByTimeAsync(120000);
    const results = await promise;

    const gnewsCalls = fetchFn.mock.calls.filter(([u]) => u.startsWith("https://gnews.io/"));
    expect(gnewsCalls).toHaveLength(3); // original + GNEWS_MAX_RETRIES(2)
    expect(results[0].articles).toHaveLength(0);
    expect(results[0].score).toBeNull();
  });
});

// ---- Error handling & Retry-After --------------------------------------------

describe("fetchCountries - NewsData error handling & retry", () => {
  it("honors Retry-After on HTTP 429, then succeeds on retry", async () => {
    vi.useFakeTimers();
    let call = 0;
    const fetchFn = installFetch({
      news: () => {
        call += 1;
        return call === 1
          ? makeResponse(429, { error: "rate" }, { "retry-after": "1" })
          : newsOk([{ title: "OK", link: "http://a", language: "english" }]);
      },
      hfEng: hfPositive,
    });

    const promise = fetchCountries([{ code: "ly", name: "Libya" }]);
    await vi.advanceTimersByTimeAsync(120000);
    const results = await promise;

    const newsCalls = fetchFn.mock.calls.filter(([u]) => u.startsWith("https://newsdata.io/"));
    expect(newsCalls).toHaveLength(2); // original + one retry
    expect(results[0].score).toBeCloseTo(0.8, 5);
  });

  it("gives up after the retry budget on persistent 429 (rate_limited, empty)", async () => {
    vi.useFakeTimers();
    const fetchFn = installFetch({
      news: () => makeResponse(429, { error: "rate" }, { "retry-after": "1" }),
    });

    const promise = fetchCountries([{ code: "ly", name: "Libya" }]);
    await vi.advanceTimersByTimeAsync(120000);
    const results = await promise;

    const newsCalls = fetchFn.mock.calls.filter(([u]) => u.startsWith("https://newsdata.io/"));
    expect(newsCalls).toHaveLength(3); // original + NEWSDATA_MAX_RETRIES(2)
    expect(results[0].articles).toHaveLength(0);
    expect(results[0].score).toBeNull();
    // No headlines → no HF call at all.
    expect(fetchFn.mock.calls.some(([u]) => u.includes("huggingface"))).toBe(false);
  });

  it("retries a transient network error then succeeds", async () => {
    vi.useFakeTimers();
    let call = 0;
    const fetchFn = installFetch({
      news: () => {
        call += 1;
        if (call === 1) throw netError("ECONNRESET");
        return newsOk([{ title: "Back", link: "http://a", language: "english" }]);
      },
      hfEng: hfPositive,
    });

    const promise = fetchCountries([{ code: "ly", name: "Libya" }]);
    await vi.advanceTimersByTimeAsync(120000);
    const results = await promise;

    expect(fetchFn.mock.calls.filter(([u]) => u.startsWith("https://newsdata.io/"))).toHaveLength(2);
    expect(results[0].score).toBeCloseTo(0.8, 5);
  });

  it("marks an unsupported country (HTTP 422 UnsupportedFilter) without throwing", async () => {
    installFetch({
      news: makeResponse(422, "UnsupportedFilter: country not supported"),
    });
    const results = await fetchCountries([{ code: "xx", name: "Nowhere" }]);
    expect(results[0].articles).toHaveLength(0);
    expect(results[0].score).toBeNull();
  });

  it("isolates one country's hard failure so the rest still process", async () => {
    vi.useFakeTimers();
    const fetchFn = installFetch({
      news: (url: string) => {
        // First country (ma) hits a non-retryable error; second (dz) succeeds.
        if (url.includes("country=ly")) throw new Error("boom-non-retryable");
        return newsOk([{ title: "Fine", link: "http://dz", language: "english" }]);
      },
      hfEng: hfPositive,
    });

    const promise = fetchCountries([
      { code: "ly", name: "Libya" },
      { code: "dz", name: "Algeria" },
    ]);
    await vi.advanceTimersByTimeAsync(120000);
    const results = await promise;

    expect(results).toHaveLength(2);
    expect(results[0].articles).toHaveLength(0); // ly failed cleanly
    expect(results[0].score).toBeNull();
    expect(results[1].score).toBeCloseTo(0.8, 5); // dz unaffected
    expect(fetchFn).toHaveBeenCalled();
  });
});

describe("fetchCountries - HuggingFace error handling & retry", () => {
  it("honors a 503 estimated_time cold-start, then succeeds on retry", async () => {
    vi.useFakeTimers();
    let call = 0;
    const fetchFn = installFetch({
      news: newsOk([{ title: "Hi", link: "http://a", language: "english" }]),
      hfEng: (url: string, opts: any) => {
        call += 1;
        return call === 1 ? makeResponse(503, { estimated_time: 3 }) : hfPositive(url, opts);
      },
    });

    const promise = fetchCountries([{ code: "ly", name: "Libya" }]);
    await vi.advanceTimersByTimeAsync(120000);
    const results = await promise;

    expect(fetchFn.mock.calls.filter(([u]) => u.includes("twitter-roberta-base-sentiment-latest"))).toHaveLength(2);
    expect(results[0].score).toBeCloseTo(0.8, 5);
  });

  it("degrades to null scores (no throw) on an invalid HF JSON response", async () => {
    installFetch({
      news: newsOk([{ title: "Hi", link: "http://a", language: "english" }]),
      hfEng: makeResponse(200, "<<not json>>"),
    });
    const results = await fetchCountries([{ code: "ly", name: "Libya" }]);
    expect(results[0].articles).toHaveLength(1);
    expect(results[0].articles[0].score).toBeNull();
    expect(results[0].score).toBeNull();
  });
});

describe("fetchCountries - scoringFailed (the cron's scoring breaker)", () => {
  const oneEnglish = () => newsOk([{ title: "Hi", link: "http://a", language: "english" }]);

  it("is true when the scorer rejects every headline it is sent", async () => {
    installFetch({ news: oneEnglish(), hfEng: makeResponse(402, { error: "You have no remaining credits." }) });
    const stats: FetchStats = {};
    await fetchCountries([{ code: "ly", name: "Libya" }], stats);
    expect(stats.scoringFailed).toBe(true);
  });

  it("is false when the scorer answers", async () => {
    installFetch({ news: oneEnglish(), hfEng: hfPositive });
    const stats: FetchStats = {};
    await fetchCountries([{ code: "ly", name: "Libya" }], stats);
    expect(stats.scoringFailed).toBe(false);
  });

  it("is false when nothing reached the scorer (no headlines fetched)", async () => {
    const fetchFn = installFetch({ news: newsOk([]) });
    const stats: FetchStats = {};
    await fetchCountries([{ code: "ly", name: "Libya" }], stats);
    expect(fetchFn.mock.calls.some(([u]) => u.includes("huggingface"))).toBe(false);
    expect(stats.scoringFailed).toBe(false);
  });

  it("is false when every translation failed, since the scorer was never asked", async () => {
    // Non-English headline + Azure down: the input is "", so HF is never called.
    installFetch({
      news: newsOk([{ title: "Hola", link: "http://a", language: "spanish" }]),
      azure: makeResponse(500, "down"),
    });
    const stats: FetchStats = {};
    await fetchCountries([{ code: "ly", name: "Libya" }], stats);
    expect(stats.scoringFailed).toBe(false);
  });
});

describe("probeScoring", () => {
  it("is true when the scorer returns a score", async () => {
    const fetchFn = installFetch({ hfEng: hfPositive });
    await expect(probeScoring()).resolves.toBe(true);
    // One request, one headline - the probe must stay cheap.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchFn.mock.calls[0][1].body).inputs).toHaveLength(1);
  });

  it("is false when the scorer rejects the request", async () => {
    installFetch({ hfEng: makeResponse(402, { error: "You have no remaining credits." }) });
    await expect(probeScoring()).resolves.toBe(false);
  });

  it("gives up after PROBE_TIMEOUT_MS when the scorer hangs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // Answers only by failing when the request is aborted, so the probe's own
    // deadline - not the mock - decides when it gives up.
    installFetch({
      hfEng: (_url: string, opts: any) =>
        new Promise<FakeResponse>((_, reject) => {
          opts.signal.addEventListener("abort", () => reject(opts.signal.reason));
        }),
    });
    const t0 = Date.now();
    let settledAt = -1;
    const p = probeScoring().then((ok) => {
      settledAt = Date.now();
      return ok;
    });
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 60_000);
    await expect(p).resolves.toBe(false);
    expect(settledAt - t0).toBeLessThanOrEqual(PROBE_TIMEOUT_MS);
  });
});

describe("fetchCountries - partial HuggingFace batch failure", () => {
  it("averages only the scored headlines, and leaves an all-null country retryable", async () => {
    vi.useFakeTimers();
    // 58 English headlines across 12 NewsData countries, scored in two HF chunks
    // (HF_BATCH_SIZE = 50). Sized so the chunk boundary splits one country:
    //   targets[0]     3 headlines   (indices 0-2)    all in chunk 1
    //   targets[1..9]  5 each        (indices 3-47)   all in chunk 1
    //   targets[10]    5             (indices 48-52)  2 in chunk 1, 3 in chunk 2
    //   targets[11]    5             (indices 53-57)  all in chunk 2
    const targets = LOW_PRIORITY_COUNTRIES.slice(0, 12).map(({ code, name }) => ({ code, name }));
    const sizeOf = (i: number) => (i === 0 ? 3 : 5);
    const split = targets[10].code;
    const lost = targets[11].code;
    // The split country's two chunk-1 headlines score +0.8 and -0.6: mean average 0.1.
    // If nulls were given a value of 0, would average to 0.04 instead.
    const titleFor = (code: string, i: number) =>
      code === split && i === 1 ? `neg ${code} ${i}` : `pos ${code} ${i}`;

    let hfCalls = 0;
    installFetch({
      news: (url: string) => {
        const idx = targets.findIndex((t) => url.includes(`country=${t.code}&`)); // the query always continues past the code
        const code = targets[idx].code;
        return newsOk(
          Array.from({ length: sizeOf(idx) }, (_, i) => ({
            title: titleFor(code, i),
            link: `http://${code}/${i}`,
            language: "english",
          }))
        );
      },
      hfEng: (url: string, opts: any) => {
        hfCalls += 1;
        // Chunk 2 fails with a non-retryable status, so its inputs come back null.
        if (hfCalls > 1) return makeResponse(400, { error: "bad request" });
        const { inputs } = JSON.parse(opts.body);
        return makeResponse(
          200,
          inputs.map((t: string) =>
            t.startsWith("neg")
              ? [{ label: "negative", score: 0.6 }, { label: "neutral", score: 0.4 }]
              : [{ label: "positive", score: 0.8 }, { label: "neutral", score: 0.2 }]
          )
        );
      },
    });

    const promise = fetchCountries(targets);
    await vi.advanceTimersByTimeAsync(120000);
    const results = await promise;
    const byCode = new Map(results.map((r) => [r.code, r]));

    expect(hfCalls).toBe(2); // really two chunks, the second failing
    expect(byCode.get(targets[0].code)!.score).toBeCloseTo(0.8, 5); // fully in chunk 1

    const s = byCode.get(split)!;
    expect(s.articles.map((a) => a.score === null)).toEqual([false, false, true, true, true]);
    expect(s.score).toBeCloseTo(0.1, 5);

    const l = byCode.get(lost)!;
    expect(l.articles).toHaveLength(5);
    expect(l.articles.every((a) => a.score === null)).toBe(true);
    expect(l.score).toBeNull();

    // Persist the real results: n counts only the scored headlines, and the
    // all-null country is scorable-but-unscored - untouched, so it is retried.
    const redis = createFakeRedis();
    const day = 500;
    const refreshed = await persistCountries(redis, results, day);
    expect(refreshed).toContain(split);
    expect(refreshed).not.toContain(lost);

    const [point] = (await redis.zrange(HISTORY_KEY(split), 0, -1)) as string[];
    // sd over the same two scores as `s`: 0.8 and -0.6, each 0.7 from the mean,
    // so sqrt(2 * 0.49 / 1) = 0.990. The nulls count toward neither.
    expect(JSON.parse(point)).toEqual({ d: day, s: 0.1, n: 2, sd: 0.99 });

    expect(redis._store.has(`sentiment:country:${lost}`)).toBe(false);
    expect(redis._zsets.get("sentiment:freshness")!.has(lost)).toBe(false);
    expect(redis._sets.get(`sentiment:done:${day}`)!.has(lost)).toBe(false);
  });
});

// ---- Tick time budget (TICK_BUDGET_MS) ---------------------------------------

describe("fetchCountries - tick time budget", () => {
  // Fake only what the budget reads. Every timeout is a setTimeout (timeoutSignal),
  // every deadline check reads Date.now().
  const useBudgetTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

  // A provider that never answers on its own: it rejects only when the request's
  // signal aborts, so the capped timeouts - not the mock - decide the timing.
  const hang = (_url: string, opts: any) =>
    new Promise<FakeResponse>((_, reject) => {
      opts.signal.addEventListener("abort", () => reject(opts.signal.reason));
    });

  const lowPriority = (...codes: string[]) =>
    codes.map((code) => {
      const c = LOW_PRIORITY_COUNTRIES.find((x) => x.code === code)!;
      return { code: c.code, name: c.name, lang: c.lang };
    });

  // Runs fetchCountries to completion under fake timers and reports the virtual
  // time at which it resolved - not when the leftover (unref'd) timers drained.
  async function runTimed(targets: Parameters<typeof fetchCountries>[0], stats: FetchStats, budgetMs?: number) {
    const t0 = Date.now();
    let endedAt = -1;
    const promise = fetchCountries(targets, stats, { budgetMs }).then((r) => {
      endedAt = Date.now() - t0;
      return r;
    });
    await vi.runAllTimersAsync();
    const results = await promise;
    return { results, endedAt };
  }

  const statusOf = (stats: FetchStats, code: string) => stats.countries!.find((c) => c.code === code)!.status;

  it("ends a NewsData outage by the budget (was 598 s)", async () => {
    // Before the budget: dz attempts at 0/66/138 s, zm at
    // 200/266/338 s, gm at 400/466/538 s - 598 s in all, past maxDuration.
    useBudgetTimers();
    const t0 = Date.now();
    const sentAt: number[] = [];
    installFetch({
      news: (url: string, opts: any) => {
        sentAt.push(Date.now() - t0);
        return hang(url, opts);
      },
    });
    const stats: FetchStats = {};
    const { results, endedAt } = await runTimed(lowPriority("dz", "zm", "gm"), stats);

    expect(endedAt).toBeLessThanOrEqual(TICK_BUDGET_MS);
    // dz: three full 60 s timeouts. zm starts at 200 s, its timeout is capped to
    // the 40 s left, and the 6 s retry wait no longer fits. gm is never sent.
    expect(sentAt).toEqual([0, 66_000, 138_000, 200_000]);
    expect(sentAt.every((t) => t < TICK_BUDGET_MS)).toBe(true);
    expect(results.map((r) => r.code)).toEqual(["dz", "zm", "gm"]);
    expect(statusOf(stats, "dz")).toBe("timeout");
    expect(statusOf(stats, "zm")).toBe("timeout"); // it was sent, so it keeps its real status
    expect(statusOf(stats, "gm")).toBe("deadline_skipped");
    expect(results.every((r) => r.articles.length === 0 && r.score === null)).toBe(true);
    expect(console.warn).toHaveBeenCalledWith("[Tick] budget_exhausted stage=fetch skipped=1");
    // All three are refunded: two timeouts (refunded as ambiguous) and one request never sent.
    expect(refundCounts(results)).toEqual({ newsdata: 3, gnews: 0 });
  });

  it("ends an HF outage after a healthy 20-country fetch by the budget (was 434 s)", async () => {
    // Before the budget:
    //   {"fetchMs":38000,"scoreMs":396000,"totalMs":434000}
    // 20 countries x 5 English headlines = 100 inputs = two HF chunks, each of
    // which retried through three 60 s timeouts.
    useBudgetTimers();
    const targets = LOW_PRIORITY_COUNTRIES.slice(0, 20).map(({ code, name }) => ({ code, name }));
    let hfCalls = 0;
    installFetch({
      news: (url: string) => {
        const code = targets.find((t) => url.includes(`country=${t.code}&`))!.code;
        return newsOk(
          Array.from({ length: 5 }, (_, i) => ({ title: `${code} ${i}`, link: `http://${code}/${i}`, language: "english" }))
        );
      },
      hfEng: (url: string, opts: any) => {
        hfCalls += 1;
        return hang(url, opts);
      },
    });
    const stats: FetchStats = {};
    const { results, endedAt } = await runTimed(targets, stats);

    expect(endedAt).toBeLessThanOrEqual(TICK_BUDGET_MS);
    expect(stats.timings!.fetchMs).toBe(38_000); // 19 courtesy gaps, unchanged
    // Chunk 1 retries to 236 s; chunk 2 is sent once with a 4 s timeout and not retried.
    expect(hfCalls).toBe(4);
    expect(results).toHaveLength(20);
    for (const r of results) {
      expect(r.status).toBe("ok");
      expect(r.articles).toHaveLength(5);
      expect(r.articles.every((a) => a.score === null)).toBe(true);
      expect(r.score).toBeNull();
    }
    expect(console.warn).toHaveBeenCalledWith("[Tick] budget_exhausted stage=score skipped=50");

    // Served, so nothing is refunded, and every country is scorable-but-unscored:
    // untouched, so the next tick retries it.
    expect(refundCounts(results)).toEqual({ newsdata: 0, gnews: 0 });
    const redis = createFakeRedis();
    const day = 500;
    expect(await persistCountries(redis, results, day)).toEqual([]);
    for (const { code } of targets) {
      expect(redis._sets.get(`sentiment:done:${day}`)?.has(code) ?? false).toBe(false);
      expect(redis._store.has(`sentiment:country:${code}`)).toBe(false);
    }
  });

  it("does not retry when the backoff would use up exactly the time left", async () => {
    // dz's first timeout ends at 60 s with 6 s left and a 6 s backoff. A retry
    // would be sent at the deadline with a 0 ms timeout - a wasted request.
    useBudgetTimers();
    const t0 = Date.now();
    const sentAt: number[] = [];
    installFetch({
      news: (url: string, opts: any) => {
        sentAt.push(Date.now() - t0);
        return hang(url, opts);
      },
    });
    const stats: FetchStats = {};
    const { endedAt } = await runTimed(lowPriority("dz"), stats, 66_000);

    expect(sentAt).toEqual([0]);
    expect(endedAt).toBe(60_000);
    expect(statusOf(stats, "dz")).toBe("timeout");
  });

  it("logs budget_exhausted when the deadline cuts short the last HF attempt", async () => {
    // One chunk: attempts at 0 / 66 / 138 s, and the third's timeout is capped at
    // the 12 s left. It is the final attempt, so nothing is counted as skipped -
    // the log must still fire.
    useBudgetTimers();
    installFetch({
      news: newsOk(Array.from({ length: 5 }, (_, i) => ({ title: `dz ${i}`, link: `http://dz/${i}`, language: "english" }))),
      hfEng: hang,
    });
    const stats: FetchStats = {};
    const { results, endedAt } = await runTimed(lowPriority("dz"), stats, 150_000);

    expect(endedAt).toBe(150_000);
    expect(results[0].articles.every((a) => a.score === null)).toBe(true);
    expect(console.warn).toHaveBeenCalledWith("[Tick] budget_exhausted stage=score skipped=0");
  });

  it("with budgetMs: 0, sends nothing and marks every country deadline_skipped", async () => {
    const fetchFn = installFetch({}); // any request would throw "no handler configured"
    const targets = [...lowPriority("dz", "zm"), { code: "us", name: "United States", lang: "en" }];
    const stats: FetchStats = {};
    const results = await fetchCountries(targets, stats, { budgetMs: 0 });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(results).toHaveLength(3);
    expect(stats.countries!.map((c) => c.status)).toEqual(["deadline_skipped", "deadline_skipped", "deadline_skipped"]);
    expect(results.every((r) => r.status === "deadline_skipped" && r.articles.length === 0)).toBe(true);
    // Never sent, so every reserved credit comes back, split by provider.
    expect(refundCounts(results)).toEqual({ newsdata: 2, gnews: 1 });

    const redis = createFakeRedis();
    const day = 500;
    expect(await persistCountries(redis, results, day)).toEqual([]);
    for (const { code } of targets) {
      expect(redis._sets.get(`sentiment:done:${day}`)?.has(code) ?? false).toBe(false);
      expect(redis._zsets.get("sentiment:freshness")?.has(code) ?? false).toBe(false);
    }
  });
});

describe("translateAll / scoreInChunks - optional deadline", () => {
  it("without a deadline, retries exactly as before (the eval harness's path)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let call = 0;
    const fetchFn = installFetch({
      hfEng: (url: string, opts: any) => {
        call += 1;
        return call < 3 ? makeResponse(503, { estimated_time: 20 }) : hfPositive(url, opts);
      },
      azure: azureEcho,
    });
    const scoring = scoreInChunks(HF_ENGLISH_MODEL, ["a", "b"]);
    await vi.runAllTimersAsync();
    const scores = await scoring;
    expect(scores[0]).toBeCloseTo(0.8, 5);
    expect(scores[1]).toBeCloseTo(0.8, 5);
    expect(call).toBe(3); // original + HF_MAX_RETRIES(2)
    expect(await translateAll(["Hola"])).toEqual(["EN:Hola"]);
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("with a deadline already passed, degrades without sending anything", async () => {
    const fetchFn = installFetch({ hfEng: hfPositive, azure: azureEcho });
    const past = Date.now() - 1;
    expect(await scoreInChunks(HF_ENGLISH_MODEL, ["a", "b"], past)).toEqual([null, null]);
    expect(await translateAll(["Hola", "Bonjour"], past)).toEqual(["", ""]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
