import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AGG_KEY,
  selectDueCountries,
  reserveCredits,
  persistCountries,
  rebuildAggregate,
} from "../../api/_lib/refresh-core.js";
import { COUNTRIES } from "../../api/_lib/sentiment-fetch.js";
import { createFakeRedis } from "../helpers/fakeRedis.js";

// Mirrors refresh-core's internal dayId so tests can seed the right done-key /
// freshness timestamps for a chosen `now`. (Kept in sync with the module.)
const DAY_MS = 24 * 60 * 60 * 1000;
const NEWSDATA_DAY_OFFSET_MS = 59 * 60 * 1000;
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
  it("clamps the picked count to the NEWSDATA_MAX_COUNTRIES dev cap", async () => {
    vi.stubEnv("NEWSDATA_MAX_COUNTRIES", "3");
    const redis = createFakeRedis();
    const { subset, diag } = await selectDueCountries(redis, NOW);
    expect(diag.budget).toBe(3);
    expect(subset).toHaveLength(3);
    subset.forEach((c) => expect(typeof c.code).toBe("string"));
  });

  it("excludes countries already marked done today", async () => {
    const redis = createFakeRedis({ sets: { [doneKey]: allCodes.filter((c) => c !== "us") } });
    const { subset, diag } = await selectDueCountries(redis, NOW);
    expect(diag.done).toBe(allCodes.length - 1);
    expect(subset).toHaveLength(1);
    expect(subset[0].code).toBe("us");
  });

  it("returns an empty subset once the credit budget is exhausted", async () => {
    const redis = createFakeRedis();
    const first = await selectDueCountries(redis, NOW);
    // Spend the whole 15-min window budget (MAX_PER_WINDOW = 12).
    await reserveCredits(redis, 12, { dayId: first.dayId, windowId: first.windowId });

    const { subset, diag } = await selectDueCountries(redis, NOW);
    expect(diag.budget).toBe(0);
    expect(subset).toHaveLength(0);
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
    const keep = ["us", "ma"]; // us = high priority, ma = low priority
    const done = allCodes.filter((c) => !keep.includes(c));

    // ma fetched today → inside its 3-day cadence → deferred.
    const recent = createFakeRedis({
      sets: { [doneKey]: done },
      zsets: { "sentiment:freshness": { ma: NOW.getTime() } },
    });
    const a = await selectDueCountries(recent, NOW);
    expect(a.subset.map((c) => c.code)).toEqual(["us"]);
    expect(a.diag.lowDeferred).toBeGreaterThanOrEqual(1);

    // ma last fetched 4 days ago → cadence elapsed → eligible again.
    const stale = createFakeRedis({
      sets: { [doneKey]: done },
      zsets: { "sentiment:freshness": { ma: NOW.getTime() - 4 * DAY_MS } },
    });
    const b = await selectDueCountries(stale, NOW);
    expect(b.subset.map((c) => c.code).sort()).toEqual(["ma", "us"]);
  });
});

describe("reserveCredits", () => {
  it("increments both the 15-min and daily counters by n", async () => {
    const redis = createFakeRedis();
    await reserveCredits(redis, 5, { dayId: 100, windowId: 200 });
    expect(redis._store.get("sentiment:credits:15m:200")).toBe(5);
    expect(redis._store.get("sentiment:credits:day:100")).toBe(5);
    await reserveCredits(redis, 3, { dayId: 100, windowId: 200 });
    expect(redis._store.get("sentiment:credits:15m:200")).toBe(8);
  });

  it("is a no-op for n <= 0", async () => {
    const redis = createFakeRedis();
    await reserveCredits(redis, 0, { dayId: 100, windowId: 200 });
    expect(redis._store.has("sentiment:credits:15m:200")).toBe(false);
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
