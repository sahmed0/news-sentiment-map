import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AGG_KEY,
  NEWSDATA_MAX_PER_DAY,
  GNEWS_MAX_PER_DAY,
  DAY_MS,
  NEWSDATA_DAY_OFFSET_MS,
  LOW_PRIORITY_DAYS,
  selectDueCountries,
  reserveCredits,
  releaseCredits,
  refundCounts,
  persistCountries,
  isTransientStatus,
  rebuildAggregate,
  lowPriorityDueOn,
  HISTORY_KEY,
  HISTORY_MAX_DAYS,
} from "../../api/_lib/refresh-core.js";
import { COUNTRIES, HIGH_PRIORITY_CODES } from "../../api/_lib/sentiment-fetch.js";
import { createFakeRedis } from "../helpers/fakeRedis.js";
import type { CountryResult } from "../../shared/types.js";

const dayIdOf = (now: Date) => Math.floor((now.getTime() - NEWSDATA_DAY_OFFSET_MS) / DAY_MS);
const gnDayIdOf = (now: Date) => Math.floor(now.getTime() / DAY_MS);

const NOW = new Date("2024-06-01T12:30:00Z"); // hour 12 UTC - chosen so the tested countries fall to backfill, not tz-due
const allCodes = COUNTRIES.map((c) => c.code);
const doneKey = `sentiment:done:${dayIdOf(NOW)}`;

// A low-priority country whose phase cohort is due on NOW's day-bucket. Picked
// dynamically so the cadence tests stay valid regardless of list order/parity.
const DUE_LOW = COUNTRIES.find(
  (c) => !HIGH_PRIORITY_CODES.has(c.code) && lowPriorityDueOn(c.code, dayIdOf(NOW))
)!.code;

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
    // Spend both providers' daily budgets (each provider charged to its own ledger).
    await reserveCredits(
      redis,
      { newsdata: NEWSDATA_MAX_PER_DAY, gnews: GNEWS_MAX_PER_DAY },
      first
    );

    const { subset, diag } = await selectDueCountries(redis, NOW);
    expect(diag.budget).toBe(0);
    expect(subset).toHaveLength(0);
  });

  it("budgets the two providers independently - exhausting GNews still lets NewsData run", async () => {
    // Only one high-priority (us, GNews) and one low-priority (DUE_LOW, NewsData) pending.
    const keep = ["us", DUE_LOW];
    const done = allCodes.filter((c) => !keep.includes(c));
    const redis = createFakeRedis({
      sets: { [doneKey]: done },
      zsets: { "sentiment:freshness": { [DUE_LOW]: NOW.getTime() - (LOW_PRIORITY_DAYS + 1) * DAY_MS } },
    });
    const first = await selectDueCountries(redis, NOW);
    // Both are picked, charged to their own provider.
    expect(first.counts).toEqual({ gnews: 1, newsdata: 1 });

    // Exhaust GNews only; NewsData budget untouched.
    await reserveCredits(redis, { newsdata: 0, gnews: GNEWS_MAX_PER_DAY }, first);
    const { subset, counts, diag } = await selectDueCountries(redis, NOW);
    expect(diag.gnBudget).toBe(0);
    expect(subset.map((c) => c.code)).toEqual([DUE_LOW]); // high-priority us is now starved, DUE_LOW still runs
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

  it("holds an early backfill country until its target hour, unless it's badly overdue", async () => {
    // 03:30 UTC: us (offset -5, target ~11 UTC) is still hours before its 6 am-local
    // target, so backfill must not pull it forward at normal staleness.
    const NOW_EARLY = new Date("2024-06-01T03:30:00Z");
    const earlyDoneKey = `sentiment:done:${dayIdOf(NOW_EARLY)}`;
    const done = allCodes.filter((c) => c !== "us");

    // Fetched 20 h ago: well within a daily cycle → early → gated out of backfill.
    const fresh = createFakeRedis({
      sets: { [earlyDoneKey]: done },
      zsets: { "sentiment:freshness": { us: NOW_EARLY.getTime() - 20 * 60 * 60 * 1000 } },
    });
    const a = await selectDueCountries(fresh, NOW_EARLY);
    expect(a.subset).toHaveLength(0);
    expect(a.diag.notDone).toBe(1); // eligible, just held back as early

    // Fetched 31 h ago: jumped a full cycle → badly overdue → backfilled despite being early.
    const stale = createFakeRedis({
      sets: { [earlyDoneKey]: done },
      zsets: { "sentiment:freshness": { us: NOW_EARLY.getTime() - 31 * 60 * 60 * 1000 } },
    });
    const b = await selectDueCountries(stale, NOW_EARLY);
    expect(b.subset.map((c) => c.code)).toEqual(["us"]);
  });

  it("defers low-priority countries fetched within their cadence, keeps high-priority eligible", async () => {
    const keep = ["us", DUE_LOW]; // us = high priority, DUE_LOW = low priority (due this day-bucket)
    const done = allCodes.filter((c) => !keep.includes(c));

    // DUE_LOW fetched today → inside its cadence → deferred.
    const recent = createFakeRedis({
      sets: { [doneKey]: done },
      zsets: { "sentiment:freshness": { [DUE_LOW]: NOW.getTime() } },
    });
    const a = await selectDueCountries(recent, NOW);
    expect(a.subset.map((c) => c.code)).toEqual(["us"]);
    expect(a.diag.lowDeferred).toBeGreaterThanOrEqual(1);

    // DUE_LOW last fetched a full cadence ago → cadence elapsed → eligible again.
    const stale = createFakeRedis({
      sets: { [doneKey]: done },
      zsets: { "sentiment:freshness": { [DUE_LOW]: NOW.getTime() - (LOW_PRIORITY_DAYS + 1) * DAY_MS } },
    });
    const b = await selectDueCountries(stale, NOW);
    expect(b.subset.map((c) => c.code).sort()).toEqual([DUE_LOW, "us"].sort());
  });

  it("books GNews usage on its own midnight-UTC day near the 00:00-01:00 UTC gap", async () => {
    // 00:30 UTC: GNews' day has already rolled (midnight) but NewsData's hasn't
    // (its day boundary is shifted to 01:00 UTC), so the two ledger days differ.
    const NOW_GAP = new Date("2024-06-02T00:30:00Z");
    const ndDay = dayIdOf(NOW_GAP);
    const gnDay = gnDayIdOf(NOW_GAP);
    expect(gnDay).toBe(ndDay + 1); // GNews day already advanced; NewsData day lags

    const sel = await selectDueCountries(createFakeRedis(), NOW_GAP);
    expect(sel.dayId).toBe(ndDay);
    expect(sel.gnDayId).toBe(gnDay);

    // Usage charged to the GNews day key reduces gnBudget; the same count on the
    // NewsData-shifted day key must NOT (that would be the mis-booking we fixed).
    const right = createFakeRedis({ store: { [`sentiment:credits:gn:day:${gnDay}`]: GNEWS_MAX_PER_DAY } });
    const wrong = createFakeRedis({ store: { [`sentiment:credits:gn:day:${ndDay}`]: GNEWS_MAX_PER_DAY } });
    expect((await selectDueCountries(right, NOW_GAP)).diag.gnBudget).toBe(0);
    expect((await selectDueCountries(wrong, NOW_GAP)).diag.gnBudget).toBeGreaterThan(0);
  });

  it("splits low-priority countries into even per-day cohorts across the cadence", () => {
    const lowCodes = COUNTRIES.filter((c) => !HIGH_PRIORITY_CODES.has(c.code)).map((c) => c.code);

    // Size of each phase cohort (the set due on a given day-bucket of the cadence).
    const cohortSizes = Array.from({ length: LOW_PRIORITY_DAYS }, (_, phase) =>
      lowCodes.filter((code) => lowPriorityDueOn(code, phase)).length
    );

    // Every low-priority country is due on exactly one day of the cadence (the
    // cohorts partition the list), and the cohorts are balanced within ±1.
    expect(cohortSizes.reduce((a, b) => a + b, 0)).toBe(lowCodes.length);
    expect(Math.max(...cohortSizes) - Math.min(...cohortSizes)).toBeLessThanOrEqual(1);
  });
});

describe("reserveCredits", () => {
  it("charges each provider's ledger - NewsData on dayId, GNews on gnDayId", async () => {
    const redis = createFakeRedis();
    await reserveCredits(redis, { newsdata: 5, gnews: 4 }, { dayId: 100, gnDayId: 101 });
    expect(redis._store.get("sentiment:credits:nd:day:100")).toBe(5);
    expect(redis._store.get("sentiment:credits:gn:day:101")).toBe(4);
    await reserveCredits(redis, { newsdata: 3, gnews: 1 }, { dayId: 100, gnDayId: 101 });
    expect(redis._store.get("sentiment:credits:nd:day:100")).toBe(8);
    expect(redis._store.get("sentiment:credits:gn:day:101")).toBe(5);
  });

  it("touches only the providers with a positive count", async () => {
    const redis = createFakeRedis();
    await reserveCredits(redis, { newsdata: 0, gnews: 2 }, { dayId: 100, gnDayId: 101 });
    expect(redis._store.has("sentiment:credits:nd:day:100")).toBe(false);
    expect(redis._store.get("sentiment:credits:gn:day:101")).toBe(2);
  });

  it("is a no-op for empty/zero counts", async () => {
    const redis = createFakeRedis();
    await reserveCredits(redis, { newsdata: 0, gnews: 0 }, { dayId: 100, gnDayId: 101 });
    expect(redis._store.has("sentiment:credits:nd:day:100")).toBe(false);
    expect(redis._store.has("sentiment:credits:gn:day:101")).toBe(false);
  });
});

describe("releaseCredits + refundCounts", () => {
  it("refundCounts counts only transient fetches, split by provider tier", () => {
    const lowCode = COUNTRIES.find((c) => !HIGH_PRIORITY_CODES.has(c.code))!.code;
    const results = [
      { code: "us", status: "timeout" },           // transient, high tier → GNews
      { code: "gb", status: "ok" },                // success, no refund
      { code: lowCode, status: "rate_limited" },   // transient, low tier → NewsData
      { code: "fr", status: "empty" },             // terminal, no refund
      { code: "de", status: "unsupported" },       // terminal, no refund
    ];
    expect(refundCounts(results)).toEqual({ gnews: 1, newsdata: 1 });
  });

  it("decrements the daily ledgers, reclaiming only the refunded subset", async () => {
    const redis = createFakeRedis();
    const ledger = { dayId: 100, gnDayId: 101 };
    await reserveCredits(redis, { newsdata: 3, gnews: 2 }, ledger);
    await releaseCredits(redis, { newsdata: 1, gnews: 1 }, ledger);
    expect(redis._store.get("sentiment:credits:nd:day:100")).toBe(2); // 3 reserved - 1 refunded
    expect(redis._store.get("sentiment:credits:gn:day:101")).toBe(1); // 2 reserved - 1 refunded
  });

  it("is a no-op for empty/zero counts", async () => {
    const redis = createFakeRedis();
    await reserveCredits(redis, { newsdata: 4, gnews: 0 }, { dayId: 100, gnDayId: 101 });
    await releaseCredits(redis, { newsdata: 0, gnews: 0 }, { dayId: 100, gnDayId: 101 });
    expect(redis._store.get("sentiment:credits:nd:day:100")).toBe(4);
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
      { code: "fr", name: "FR", articles: [], score: null, status: "rate_limited" }, // transient fetch failure
      { code: "jp", name: "JP", articles: [], score: null, status: "unsupported" }, // terminal: unsupported
    ];

    const refreshed = await persistCountries(redis, results, day);

    expect(refreshed).toEqual(["us"]);

    // us: stored + freshened + done
    expect(redis._store.get("sentiment:country:us")).toMatchObject({ code: "us", score: 0.5 });
    expect(redis._zsets.get("sentiment:freshness")!.has("us")).toBe(true);
    expect(redis._sets.get(`sentiment:done:${day}`)!.has("us")).toBe(true);

    // gb: NOT stored, but freshened + done (terminal attempt)
    expect(redis._store.has("sentiment:country:gb")).toBe(false);
    expect(redis._zsets.get("sentiment:freshness")!.has("gb")).toBe(true);
    expect(redis._sets.get(`sentiment:done:${day}`)!.has("gb")).toBe(true);

    // de: entirely untouched → retried next tick
    expect(redis._store.has("sentiment:country:de")).toBe(false);
    expect(redis._zsets.get("sentiment:freshness")!.has("de")).toBe(false);
    expect(redis._sets.get(`sentiment:done:${day}`)!.has("de")).toBe(false);

    // fr: transient failure → entirely untouched, retried next tick (spends slack)
    expect(redis._store.has("sentiment:country:fr")).toBe(false);
    expect(redis._zsets.get("sentiment:freshness")!.has("fr")).toBe(false);
    expect(redis._sets.get(`sentiment:done:${day}`)!.has("fr")).toBe(false);

    // jp: terminal status → freshened + done (not retried)
    expect(redis._store.has("sentiment:country:jp")).toBe(false);
    expect(redis._zsets.get("sentiment:freshness")!.has("jp")).toBe(true);
    expect(redis._sets.get(`sentiment:done:${day}`)!.has("jp")).toBe(true);
  });
});

describe("persistCountries history", () => {
  // The stored members are JSON; decode a country's whole series, oldest first.
  const series = (redis: ReturnType<typeof createFakeRedis>, code: string) =>
    [...(redis._zsets.get(HISTORY_KEY(code)) ?? new Map<string, number>()).entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([member]) => JSON.parse(member) as { d: number; s: number; n: number });

  it("writes one point per scored country, rounded to 3 dp, counting scored headlines", async () => {
    const redis = createFakeRedis();
    await persistCountries(
      redis,
      [
        {
          code: "us",
          score: 0.123456,
          articles: [{ title: "a", score: 0.5 }, { title: "b", score: -0.25 }, { title: "c", score: null }],
        },
      ],
      500
    );
    expect(series(redis, "us")).toEqual([{ d: 500, s: 0.123, n: 2 }]); // 3rd article unscored
    expect(redis._zsets.get(HISTORY_KEY("us"))!.size).toBe(1);
  });

  it("replaces the same day's point on a re-run instead of piling up", async () => {
    const redis = createFakeRedis();
    const day = 500;
    await persistCountries(redis, [{ code: "us", score: 0.2, articles: [{ title: "a", score: 0.2 }] }], day);
    await persistCountries(redis, [{ code: "us", score: -0.4, articles: [{ title: "a", score: -0.4 }] }], day);
    expect(series(redis, "us")).toEqual([{ d: day, s: -0.4, n: 1 }]); // one member, latest wins
  });

  it("caps the series at HISTORY_MAX_DAYS, dropping the oldest day", async () => {
    const redis = createFakeRedis();
    const firstDay = 1000;
    for (let i = 0; i <= HISTORY_MAX_DAYS; i++) { // one more day than the cap
      await persistCountries(
        redis,
        [{ code: "us", score: 0.1, articles: [{ title: "a", score: 0.1 }] }],
        firstDay + i
      );
    }
    const points = series(redis, "us");
    expect(points).toHaveLength(HISTORY_MAX_DAYS);
    expect(points[0].d).toBe(firstDay + 1); // day 1000 evicted
    expect(points[points.length - 1].d).toBe(firstDay + HISTORY_MAX_DAYS);
  });

  it("writes nothing for unscorable, transient, or terminal countries", async () => {
    const redis = createFakeRedis();
    await persistCountries(
      redis,
      [
        { code: "gb", score: null, articles: [] },                            // nothing scorable
        { code: "de", score: null, articles: [{ title: "x", score: null }] }, // scoring failed
        { code: "fr", score: null, articles: [], status: "rate_limited" },    // transient
        { code: "jp", score: null, articles: [], status: "unsupported" },     // terminal
      ],
      500
    );
    for (const code of ["gb", "de", "fr", "jp"]) {
      expect(redis._zsets.has(HISTORY_KEY(code))).toBe(false); // gaps are honest data
    }
  });
});

describe("isTransientStatus", () => {
  it("classifies provider blips as transient and terminal outcomes as not", () => {
    for (const s of ["timeout", "network_error", "rate_limited", "api_error", "invalid_json", "error", "http_500", "http_503"]) {
      expect(isTransientStatus(s)).toBe(true);
    }
    for (const s of ["empty", "unsupported", "ok", "http_404", "http_422", undefined, null, ""]) {
      expect(isTransientStatus(s)).toBe(false);
    }
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
    const agg = redis._store.get(AGG_KEY) as CountryResult[];
    expect(agg).toHaveLength(2);
    expect(agg.map((c) => c.code).sort()).toEqual(["gb", "us"]);
  });
});
