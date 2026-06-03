import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchCountries,
  parseRetryAfter,
  isRetryableNetworkError,
} from "../../api/_lib/sentiment-fetch.js";

// ---- Response / fetch helpers -------------------------------------------------

// Minimal Response double exposing only what the code touches: status, ok,
// headers.get(), text(), json().
function makeResponse(status, body, headers = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null },
    text: async () => raw,
    json: async () => JSON.parse(raw),
  };
}

// Route fetch by URL to per-endpoint handlers (static response or fn(url, opts)).
function installFetch({ news, hfMulti, hfEng, azure } = {}) {
  const resolve = (h, url, opts) => {
    if (h == null) throw new Error("no handler configured for: " + url);
    return typeof h === "function" ? h(url, opts) : h;
  };
  const fn = vi.fn(async (url, opts) => {
    if (url.startsWith("https://newsdata.io/")) return resolve(news, url, opts);
    if (url.includes("twitter-xlm-roberta-base-sentiment")) return resolve(hfMulti, url, opts);
    if (url.includes("twitter-roberta-base-sentiment-latest")) return resolve(hfEng, url, opts);
    if (url.includes("cognitive.microsofttranslator")) return resolve(azure, url, opts);
    throw new Error("unexpected fetch URL: " + url);
  });
  global.fetch = fn;
  return fn;
}

// NewsData success body with the given articles.
const newsOk = (articles) => makeResponse(200, { status: "success", results: articles });

// HF handler that scores every input positively (0.8 net). Mirrors the real
// [[{label,score},...],...] batch shape.
const hfPositive = (url, opts) => {
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
const azureEcho = (url, opts) => {
  const docs = JSON.parse(opts.body); // [{ Text }]
  return makeResponse(200, docs.map((d) => ({ translations: [{ text: "EN:" + d.Text }] })));
};

const netError = (code) => Object.assign(new Error("conn"), { cause: { code } });
const timeoutError = () => Object.assign(new Error("t"), { name: "TimeoutError" });

beforeEach(() => {
  vi.stubEnv("NEWSDATA_API_KEY", "test-news-key");
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

// ---- HTTP request validity & happy path --------------------------------------

describe("fetchCountries — request construction & scoring", () => {
  it("builds the NewsData request URL and scores an English country via the multilingual model", async () => {
    const fetchFn = installFetch({
      news: newsOk([
        { title: "Good news", link: "http://a", pubDate: "2024-01-01 10:00:00", language: "english" },
      ]),
      hfMulti: hfPositive,
    });

    const stats = {};
    const results = await fetchCountries([{ code: "us", name: "United States" }], stats);

    const newsCall = fetchFn.mock.calls.find(([u]) => u.startsWith("https://newsdata.io/"));
    expect(newsCall[0]).toBe(
      "https://newsdata.io/api/1/latest?country=us&category=top&removeduplicate=1&size=5&apikey=test-news-key"
    );
    // English headlines are scored directly by the multilingual model; the
    // English-only model and the translator are never called.
    expect(fetchFn.mock.calls.some(([u]) => u.includes("twitter-xlm-roberta"))).toBe(true);
    expect(fetchFn.mock.calls.some(([u]) => u.includes("twitter-roberta-base-sentiment-latest"))).toBe(false);
    expect(fetchFn.mock.calls.some(([u]) => u.includes("microsofttranslator"))).toBe(false);

    expect(results).toHaveLength(1);
    expect(results[0].code).toBe("us");
    expect(results[0].score).toBeCloseTo(0.8, 5);
    expect(results[0].articles[0].score).toBeCloseTo(0.8, 5);
    expect(results[0].articles[0].translatedTitle).toBeNull();
    expect(typeof results[0].fetchedAt).toBe("string");
    expect(Number.isNaN(Date.parse(results[0].fetchedAt))).toBe(false);

    expect(stats.counts).toMatchObject({ countries: 1, headlines: 1, multiScored: 1, transScored: 0, toTranslate: 0 });
  });

  it("sends the HF request with parameters.top_k = null", async () => {
    const fetchFn = installFetch({
      news: newsOk([{ title: "Hi", link: "http://a", pubDate: null, language: "english" }]),
      hfMulti: hfPositive,
    });
    await fetchCountries([{ code: "us", name: "US" }]);
    const hfCall = fetchFn.mock.calls.find(([u]) => u.includes("twitter-xlm-roberta"));
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

    const results = await fetchCountries([{ code: "jp", name: "Japan" }]);

    // Japanese is not natively supported → translated, then scored by English model.
    expect(fetchFn.mock.calls.some(([u]) => u.includes("twitter-roberta-base-sentiment-latest"))).toBe(true);
    expect(fetchFn.mock.calls.some(([u]) => u.includes("twitter-xlm-roberta"))).toBe(false);

    const azureCall = fetchFn.mock.calls.find(([u]) => u.includes("microsofttranslator"));
    expect(azureCall[1].headers["Ocp-Apim-Subscription-Region"]).toBe("eastus");

    const hfEngCall = fetchFn.mock.calls.find(([u]) => u.includes("twitter-roberta-base-sentiment-latest"));
    expect(JSON.parse(hfEngCall[1].body).inputs[0]).toBe("EN:こんにちは");

    expect(results[0].articles[0].translatedTitle).toBe("EN:こんにちは");
    expect(results[0].score).toBeCloseTo(0.8, 5);
  });

  it("scores a supported non-English language with the multilingual model but still translates it for display", async () => {
    const fetchFn = installFetch({
      news: newsOk([{ title: "Guten Tag", link: "http://de", pubDate: null, language: "german" }]),
      hfMulti: hfPositive,
      azure: azureEcho,
    });

    const results = await fetchCountries([{ code: "de", name: "Germany" }]);

    expect(fetchFn.mock.calls.some(([u]) => u.includes("twitter-xlm-roberta"))).toBe(true); // scored by multilingual
    expect(fetchFn.mock.calls.some(([u]) => u.includes("microsofttranslator"))).toBe(true); // translated for display
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
      hfMulti: hfPositive,
    });

    const results = await fetchCountries([{ code: "us", name: "US" }]);
    expect(results[0].articles).toHaveLength(2);
    const hfCall = fetchFn.mock.calls.find(([u]) => u.includes("twitter-xlm-roberta"));
    expect(JSON.parse(hfCall[1].body).inputs).toHaveLength(2);
  });

  it("parses the single-input HF response shape ([{label}…], not nested)", async () => {
    installFetch({
      news: newsOk([{ title: "Solo", link: "http://a", language: "english" }]),
      // One headline → return the flat single-input shape the HF router uses.
      hfMulti: makeResponse(200, [
        { label: "positive", score: 0.7 },
        { label: "negative", score: 0.1 },
      ]),
    });
    const results = await fetchCountries([{ code: "us", name: "US" }]);
    expect(results[0].score).toBeCloseTo(0.6, 5); // 0.7 − 0.1
  });
});

// ---- Error handling & Retry-After --------------------------------------------

describe("fetchCountries — NewsData error handling & retry", () => {
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
      hfMulti: hfPositive,
    });

    const promise = fetchCountries([{ code: "us", name: "US" }]);
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

    const promise = fetchCountries([{ code: "us", name: "US" }]);
    await vi.advanceTimersByTimeAsync(120000);
    const results = await promise;

    const newsCalls = fetchFn.mock.calls.filter(([u]) => u.startsWith("https://newsdata.io/"));
    expect(newsCalls).toHaveLength(2); // original + NEWSDATA_MAX_RETRIES(1)
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
      hfMulti: hfPositive,
    });

    const promise = fetchCountries([{ code: "us", name: "US" }]);
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
      news: (url) => {
        // First country (us) hits a non-retryable error; second (gb) succeeds.
        if (url.includes("country=us")) throw new Error("boom-non-retryable");
        return newsOk([{ title: "Fine", link: "http://gb", language: "english" }]);
      },
      hfMulti: hfPositive,
    });

    const promise = fetchCountries([
      { code: "us", name: "US" },
      { code: "gb", name: "UK" },
    ]);
    await vi.advanceTimersByTimeAsync(120000);
    const results = await promise;

    expect(results).toHaveLength(2);
    expect(results[0].articles).toHaveLength(0); // us failed cleanly
    expect(results[0].score).toBeNull();
    expect(results[1].score).toBeCloseTo(0.8, 5); // gb unaffected
    expect(fetchFn).toHaveBeenCalled();
  });
});

describe("fetchCountries — HuggingFace error handling & retry", () => {
  it("honors a 503 estimated_time cold-start, then succeeds on retry", async () => {
    vi.useFakeTimers();
    let call = 0;
    const fetchFn = installFetch({
      news: newsOk([{ title: "Hi", link: "http://a", language: "english" }]),
      hfMulti: (url, opts) => {
        call += 1;
        return call === 1 ? makeResponse(503, { estimated_time: 3 }) : hfPositive(url, opts);
      },
    });

    const promise = fetchCountries([{ code: "us", name: "US" }]);
    await vi.advanceTimersByTimeAsync(120000);
    const results = await promise;

    expect(fetchFn.mock.calls.filter(([u]) => u.includes("twitter-xlm-roberta"))).toHaveLength(2);
    expect(results[0].score).toBeCloseTo(0.8, 5);
  });

  it("degrades to null scores (no throw) on an invalid HF JSON response", async () => {
    installFetch({
      news: newsOk([{ title: "Hi", link: "http://a", language: "english" }]),
      hfMulti: makeResponse(200, "<<not json>>"),
    });
    const results = await fetchCountries([{ code: "us", name: "US" }]);
    expect(results[0].articles).toHaveLength(1);
    expect(results[0].articles[0].score).toBeNull();
    expect(results[0].score).toBeNull();
  });
});
