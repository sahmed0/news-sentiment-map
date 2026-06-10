import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AGG_KEY,
  MAX_PER_WINDOW,
  GNEWS_MAX_PER_DAY,
  DAY_MS,
  NEWSDATA_DAY_OFFSET_MS,
  LOW_PRIORITY_DAYS,
  selectDueCountries,
  reserveCredits,
  persistCountries,
  rebuildAggregate,
} from "../../api/_lib/refresh-core.js";
import { COUNTRIES, HIGH_PRIORITY_CODES } from "../../api/_lib/sentiment-fetch.js";
import { createFakeRedis } from "../helpers/fakeRedis.js";

const dayIdOf = (now) => Math.floor((now.getTime() - NEWSDATA_DAY_OFFSET_MS) / DAY_MS);

const NOW = new Date("2024-06-01T12:30:00Z"); // hour 12 UTC — chosen so the tested countries fall to backfill, not tz-due
const allCodes = COUNTRIES.map((c) => c.code);
const doneKey = `sentiment:done:${dayIdOf(NOW)}`;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("selectDueCountries", () => {
  it("clamps each provider independently to NEWSDATA_MAX_COUNTRIES so both are represented", async () => {
    vi.stubEnv("NEWSDATA_MAX_COUNTRIES", "2");
    const redis = createFakeRedis();
    const { subset, counts } = await selectDueCountries(redis, NOW);
    // Each provider is capped at devLimit, not the combined array.
    expect(counts.gnews).toBeLessThanOrEqual(2);
    expect(counts.newsdata).toBeLessThanOrEqual(2);
    expect(counts.gnews).toBeGreaterThan(0);
    expect(counts.newsdata).toBeGreaterThan(0);
    expect(subset).toHaveLength(counts.gnews + counts.newsdata);
    subset.forEach((c) => expect(typeof c.code).toBe("string"));
  });

  it("excludes countries already marked done today", async () => {
    const redis = createFakeRedis({ sets: { [doneKey]: allCodes.filter((c) => c !== "us") } });
    const { subset, diag } = await selectDueCountries(redis, NOW);
    expect(diag.done).toBe(allCodes.length - 1);
    expect(subset).toHaveLength(1);
    expect(subset[0].code).toBe("us");
  });

  it("returns an empty subset once both providers' budgets are exhausted", async () => {
    const redis = createFakeRedis();
    const first = await selectDueCountries(redis, NOW);
    // Spend NewsData's 15-min window budget and GNews's daily budget.
    await reserveCredits(
      redis,
      { newsdata: MAX_PER_WINDOW, gnews: GNEWS_MAX_PER_DAY },
      { dayId: first.dayId, windowId: first.windowId }
    );

    const { subset, diag } = await selectDueCountries(redis, NOW);
    expect(diag.budget).toBe(0);
    expect(subset).toHaveLength(0);
  });

  it("budgets the two providers independently - exhausting GNews still lets NewsData run", async () => {
    // Only one high-priority (us, GNews) and one low-priority (ly, NewsData) pending.
    const keep = ["us", "ly"];
    const done = allCodes.filter((c) => !keep.includes(c));
    const redis = createFakeRedis({
      sets: { [doneKey]: done },
      zsets: { "sentiment:freshness": { ly: NOW.getTime() - (LOW_PRIORITY_DAYS + 1) * DAY_MS } },
    });
    const first = await selectDueCountries(redis, NOW);
    // Both are picked, charged to their own provider.
    expect(first.counts).toEqual({ gnews: 1, newsdata: 1 });

    // Exhaust GNews only; NewsData budget untouched.
    await reserveCredits(redis, { newsdata: 0, gnews: GNEWS_MAX_PER_DAY }, first);
    const { subset, counts, diag } = await selectDueCountries(redis, NOW);
    expect(diag.gnBudget).toBe(0);
    expect(subset.map((c) => c.code)).toEqual(["ly"]); // high-priority us is now starved, ly still runs
    expect(counts).toEqual({ gnews: 0, newsdata: 1 });
    subset.forEach((c) => expect(HIGH_PRIORITY_CODES.has(c.code)).toBe(false));
  });

  it("orders backfill by staleness, never-fetched countries first", async () => {
    // Only us, gb, de are pending; the rest are done.
    const done = allCodes.filter((c) => !["us", "gb", "de"].includes(c));
    const redis = createFakeRedis({
      sets: { [doneKey]: done },
      // us fetched most recently, de older, gb absent (never fetched → ranks first).
      zsets: { "sentiment:freshness": { us: 2000, de: 1000 } },
    });
    const { subset } = await selectDueCountries(redis, NOW);
    expect(subset.map((c) => c.code)).toEqual(["gb", "de", "us"]);
  });

  it("defers low-priority countries fetched within their cadence, keeps high-priority eligible", async () => {
    const keep = ["us", "ly"]; // us = high priority, ly = low priority
    const done = allCodes.filter((c) => !keep.includes(c));

    // ly fetched today → inside its 3-day cadence → deferred.
    const recent = createFakeRedis({
      sets: { [doneKey]: done },
      zsets: { "sentiment:freshness": { ly: NOW.getTime() } },
    });
    const a = await selectDueCountries(recent, NOW);
    expect(a.subset.map((c) => c.code)).toEqual(["us"]);
    expect(a.diag.lowDeferred).toBeGreaterThanOrEqual(1);

    // ly last fetched 4 days ago → cadence elapsed → eligible again.
    const stale = createFakeRedis({
      sets: { [doneKey]: done },
      zsets: { "sentiment:freshness": { ly: NOW.getTime() - (LOW_PRIORITY_DAYS + 1) * DAY_MS } },
    });
    const b = await selectDueCountries(stale, NOW);
    expect(b.subset.map((c) => c.code).sort()).toEqual(["ly", "us"]);
  });
});

describe("reserveCredits", () => {
  it("charges each provider's ledger from the counts object", async () => {
    const redis = createFakeRedis();
    await reserveCredits(redis, { newsdata: 5, gnews: 4 }, { dayId: 100, windowId: 200 });
    expect(redis._store.get("sentiment:credits:nd:15m:200")).toBe(5);
    expect(redis._store.get("sentiment:credits:nd:day:100")).toBe(5);
    expect(redis._store.get("sentiment:credits:gn:day:100")).toBe(4);
    await reserveCredits(redis, { newsdata: 3, gnews: 1 }, { dayId: 100, windowId: 200 });
    expect(redis._store.get("sentiment:credits:nd:15m:200")).toBe(8);
    expect(redis._store.get("sentiment:credits:gn:day:100")).toBe(5);
  });

  it("touches only the providers with a positive count", async () => {
    const redis = createFakeRedis();
    await reserveCredits(redis, { newsdata: 0, gnews: 2 }, { dayId: 100, windowId: 200 });
    expect(redis._store.has("sentiment:credits:nd:15m:200")).toBe(false);
    expect(redis._store.get("sentiment:credits:gn:day:100")).toBe(2);
  });

  it("is a no-op for empty/zero counts", async () => {
    const redis = createFakeRedis();
    await reserveCredits(redis, { newsdata: 0, gnews: 0 }, { dayId: 100, windowId: 200 });
    expect(redis._store.has("sentiment:credits:nd:15m:200")).toBe(false);
    expect(redis._store.has("sentiment:credits:gn:day:100")).toBe(false);
  });
});

describe("persistCountries", () => {
  it("stores+freshens+marks scored countries, freshens+marks unscorable, leaves scoring-failures untouched", async () => {
    const redis = createFakeRedis();
    const day = 500;
    const results = [
      { code: "us", name: "US", articles: [{ title: "a", score: 0.5 }], score: 0.5 }, // scored
      { code: "gb", name: "UK", articles: [], score: null }, // nothing scorable
      { code: "de", name: "DE", articles: [{ title: "x", score: null }], score: null }, // had text, scoring failed
    ];

    const refreshed = await persistCountries(redis, results, day);

    expect(refreshed).toEqual(["us"]);

    // us: stored + freshened + done
    expect(redis._store.get("sentiment:country:us")).toMatchObject({ code: "us", score: 0.5 });
    expect(redis._zsets.get("sentiment:freshness").has("us")).toBe(true);
    expect(redis._sets.get(`sentiment:done:${day}`).has("us")).toBe(true);

    // gb: NOT stored, but freshened + done (terminal attempt)
    expect(redis._store.has("sentiment:country:gb")).toBe(false);
    expect(redis._zsets.get("sentiment:freshness").has("gb")).toBe(true);
    expect(redis._sets.get(`sentiment:done:${day}`).has("gb")).toBe(true);

    // de: entirely untouched → retried next tick
    expect(redis._store.has("sentiment:country:de")).toBe(false);
    expect(redis._zsets.get("sentiment:freshness").has("de")).toBe(false);
    expect(redis._sets.get(`sentiment:done:${day}`).has("de")).toBe(false);
  });
});

describe("rebuildAggregate", () => {
  it("writes only present country keys to the aggregate and returns the count", async () => {
    const redis = createFakeRedis({
      store: {
        "sentiment:country:us": { code: "us", score: 0.2 },
        "sentiment:country:gb": { code: "gb", score: -0.1 },
      },
    });
    const count = await rebuildAggregate(redis);
    expect(count).toBe(2);
    const agg = redis._store.get(AGG_KEY);
    expect(agg).toHaveLength(2);
    expect(agg.map((c) => c.code).sort()).toEqual(["gb", "us"]);
  });
});
