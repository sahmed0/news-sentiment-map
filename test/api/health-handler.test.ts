import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createFakeRedis } from "../helpers/fakeRedis.js";
import {
  FRESH_KEY,
  GN_CREDIT_DAY_KEY,
  GNEWS_MAX_PER_DAY,
  ND_CREDIT_DAY_KEY,
  NEWSDATA_MAX_PER_DAY,
  TICKS_KEY,
  dayId,
  gnDayId,
} from "../../api/_lib/refresh-core.js";
import { COUNTRIES, HIGH_PRIORITY_CODES } from "../../api/_lib/sentiment-fetch.js";
import type { TickSummary } from "../../shared/types.js";

// The handler does `new Redis(...)` via a dynamic import; intercept the module so
// it talks to an in-memory fake instead of a real Upstash instance.
vi.mock("@upstash/redis", () => ({ Redis: vi.fn() }));

import handler from "../../api/health.js";
import { Redis } from "@upstash/redis";

interface MockRes {
  statusCode: number | null;
  headers: Record<string, string>;
  body: any;
  setHeader(k: string, v: string): void;
  status(code: number): MockRes;
  json(obj: any): MockRes;
}
function mockRes(): MockRes {
  return {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
  };
}
const call = (res: MockRes) => handler({} as unknown as VercelRequest, res as unknown as VercelResponse);

const NOW = new Date("2024-06-01T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const tick = (agoMs: number, extra: Partial<TickSummary> = {}): string =>
  JSON.stringify({
    ts: new Date(NOW.getTime() - agoMs).toISOString(),
    ok: 5,
    attempted: 6,
    aggregate: 150,
    tzDue: 2,
    backfill: 4,
    gnUsedDay: 12,
    ndUsedDay: 34,
    refunded: 1,
    ms: 9000,
    ...extra,
  });

// A high- and a low-priority country, picked from the real tables so the stale
// thresholds under test are the ones the scheduler actually applies.
const HIGH = COUNTRIES.find((c) => HIGH_PRIORITY_CODES.has(c.code))!.code;
const [HIGH2, LOW] = [
  COUNTRIES.filter((c) => HIGH_PRIORITY_CODES.has(c.code))[1]!.code,
  COUNTRIES.find((c) => !HIGH_PRIORITY_CODES.has(c.code))!.code,
];

const seed = (opts: { ticks?: string[]; fresh?: Record<string, number>; nd?: number; gn?: number } = {}) =>
  createFakeRedis({
    lists: opts.ticks ? { [TICKS_KEY]: opts.ticks } : {},
    zsets: opts.fresh ? { [FRESH_KEY]: opts.fresh } : {},
    store: {
      ...(opts.nd === undefined ? {} : { [ND_CREDIT_DAY_KEY(dayId(NOW))]: opts.nd }),
      ...(opts.gn === undefined ? {} : { [GN_CREDIT_DAY_KEY(gnDayId(NOW))]: opts.gn }),
    },
  });
const useRedis = (fake: unknown) =>
  // Regular function (not arrow) so the handler's `new Redis(...)` can construct it.
  vi.mocked(Redis).mockImplementation(function () { return fake as any; });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("KV_REST_API_URL", "https://fake");
  vi.stubEnv("KV_REST_API_TOKEN", "tok");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(Redis).mockReset();
});

describe("GET /api/health", () => {
  it("returns 500 when Redis env vars are missing", async () => {
    vi.stubEnv("KV_REST_API_URL", "");
    const res = mockRes();
    await call(res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Redis not configured" });
  });

  it("reports ok for a recent clean tick, with budgets and a short edge cache", async () => {
    useRedis(seed({ ticks: [tick(12 * 60 * 1000)], nd: 34, gn: 12 }));
    const res = mockRes();
    await call(res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.minutesSinceLastTick).toBe(12);
    expect(res.body.lastTick).toMatchObject({ ok: 5, attempted: 6, aggregate: 150 });
    expect(res.body.budgets).toEqual({
      gnews: { used: 12, limit: GNEWS_MAX_PER_DAY },
      newsdata: { used: 34, limit: NEWSDATA_MAX_PER_DAY },
    });
    expect(res.headers["Cache-Control"]).toBe("public, s-maxage=60");
  });

  it("reports zero usage when today's credit ledgers do not exist yet", async () => {
    useRedis(seed({ ticks: [tick(0)] }));
    const res = mockRes();
    await call(res);
    expect(res.body.budgets.gnews.used).toBe(0);
    expect(res.body.budgets.newsdata.used).toBe(0);
  });

  it("serves only the newest tick when several are stored", async () => {
    useRedis(seed({ ticks: [tick(HOUR, { ok: 9 }), tick(2 * HOUR, { ok: 1 })] }));
    const res = mockRes();
    await call(res);
    expect(res.body.lastTick.ok).toBe(9);
  });

  it("degrades when the last tick is 3 hours old", async () => {
    useRedis(seed({ ticks: [tick(3 * HOUR)] }));
    const res = mockRes();
    await call(res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("degraded");
    expect(res.body.minutesSinceLastTick).toBe(180);
  });

  it("degrades on a fresh tick that carries an error", async () => {
    useRedis(seed({ ticks: [tick(60_000, { error: "upstream down" })] }));
    const res = mockRes();
    await call(res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("degraded");
    expect(res.body.lastTick.error).toBe("upstream down");
  });

  it("is down with 503 when no tick has ever been recorded", async () => {
    useRedis(seed());
    const res = mockRes();
    await call(res);
    expect(res.statusCode).toBe(503);
    expect(res.body.status).toBe("down");
    expect(res.body.lastTick).toBeNull();
    expect(res.body.minutesSinceLastTick).toBeNull();
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });

  it("is down when the last tick is older than six hours", async () => {
    useRedis(seed({ ticks: [tick(7 * HOUR)] }));
    const res = mockRes();
    await call(res);
    expect(res.statusCode).toBe(503);
    expect(res.body.status).toBe("down");
  });

  it("treats a malformed tick entry as no tick at all", async () => {
    useRedis(seed({ ticks: ["not json"] }));
    const res = mockRes();
    await call(res);
    expect(res.statusCode).toBe(503);
    expect(res.body.lastTick).toBeNull();
  });

  it("counts a country stale once it passes twice its cadence", async () => {
    useRedis(
      seed({
        ticks: [tick(0)],
        fresh: {
          [HIGH]: NOW.getTime() - HOUR, // fresh
          [HIGH2]: NOW.getTime() - 3 * DAY, // past the 48 h high-priority limit
          [LOW]: NOW.getTime() - 5 * DAY, // past the 96 h low-priority limit
        },
      })
    );
    const res = mockRes();
    await call(res);
    // Every country absent from the freshness ZSET is stale too - only the three
    // seeded above are known, and one of them is fresh.
    expect(res.body.staleCountries).toEqual({
      count: COUNTRIES.length - 1,
      of: COUNTRIES.length,
    });
  });

  it("does not count a low-priority country stale at three days (inside its 96 h limit)", async () => {
    useRedis(seed({ ticks: [tick(0)], fresh: { [LOW]: NOW.getTime() - 3 * DAY } }));
    const res = mockRes();
    await call(res);
    expect(res.body.staleCountries.count).toBe(COUNTRIES.length - 1);
  });

  it("degrades to a 503 instead of throwing when Redis is unreachable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); // handler logs the outage
    useRedis({ lrange: vi.fn().mockRejectedValue(new Error("upstash down")), zrange: vi.fn(), get: vi.fn() });
    const res = mockRes();
    await expect(call(res)).resolves.toBeDefined(); // no unhandled rejection
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ status: "down", error: "Data temporarily unavailable" });
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });
});
