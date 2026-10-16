import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createFakeRedis } from "../helpers/fakeRedis.js";
import type { FakeRedis } from "../helpers/fakeRedis.js";

// Unlike cron-refresh.test.ts, this file runs the REAL refresh-core against the
// fake Redis, so "the credits are still charged" is asserted on the ledger keys
// themselves rather than as "releaseCredits was not called" (a mock call count).
// Only the Redis client and the network-facing fetchCountries are replaced.
vi.mock("@upstash/redis", () => ({ Redis: vi.fn() }));
vi.mock("../../api/_lib/sentiment-fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/_lib/sentiment-fetch.js")>()),
  fetchCountries: vi.fn(),
}));

import handler from "../../api/cron/refresh.js";
import { Redis } from "@upstash/redis";
import { fetchCountries, HIGH_PRIORITY_CODES } from "../../api/_lib/sentiment-fetch.js";
import type { FetchTarget } from "../../api/_lib/sentiment-fetch.js";
import { ND_CREDIT_DAY_KEY, GN_CREDIT_DAY_KEY, TICKS_KEY, dayId, gnDayId } from "../../api/_lib/refresh-core.js";
import { LOCK_KEY } from "../../api/_lib/lock.js";
import { parseTickSummary } from "../../shared/types.js";

// Same instant as refresh-core.test.ts: with an empty store every country is
// never-fetched, so selection genuinely picks from both providers.
const NOW = new Date("2024-06-01T12:30:00Z");

const res = () => {
  const r = {
    statusCode: null as number | null,
    body: null as unknown,
    status(code: number) { r.statusCode = code; return r; },
    json(obj: unknown) { r.body = obj; return r; },
  };
  return r;
};
const postReq = { method: "POST", headers: { authorization: "Bearer secret" } } as unknown as VercelRequest;

let redis: FakeRedis;

beforeEach(() => {
  // Only Date is faked: the handler reads the clock for dayId/gnDayId, and no
  // timers run once fetchCountries is mocked.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("CRON_SECRET", "secret");
  vi.stubEnv("KV_REST_API_URL", "https://fake");
  vi.stubEnv("KV_REST_API_TOKEN", "tok");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  redis = createFakeRedis();
  vi.mocked(Redis).mockImplementation(function () { return redis as any; });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(Redis).mockReset();
  vi.mocked(fetchCountries).mockReset();
});

describe("cron tick that throws after reserveCredits", () => {
  it("returns 500, records the error, releases the lock, and keeps the reserved credits charged", async () => {
    let subset: FetchTarget[] = [];
    vi.mocked(fetchCountries).mockImplementation(async (s) => {
      subset = s;
      throw new Error("fetch pipeline exploded");
    });

    const r = res();
    await handler(postReq, r as unknown as VercelResponse);

    expect(r.statusCode).toBe(500);
    expect(r.body).toMatchObject({ ok: false, error: "fetch pipeline exploded" });

    // The selection was real and reached both providers.
    const gnews = subset.filter((c) => HIGH_PRIORITY_CODES.has(c.code)).length;
    const newsdata = subset.length - gnews;
    expect(gnews).toBeGreaterThan(0);
    expect(newsdata).toBeGreaterThan(0);

    // Still charged: the documented over-count direction. A crash after the
    // reservation must never let the ledger under-count what may have been spent.
    expect(redis._store.get(ND_CREDIT_DAY_KEY(dayId(NOW)))).toBe(newsdata);
    expect(redis._store.get(GN_CREDIT_DAY_KEY(gnDayId(NOW)))).toBe(gnews);

    const [latest] = await redis.lrange(TICKS_KEY, 0, 0);
    expect(parseTickSummary(latest)).toMatchObject({ ok: 0, error: "fetch pipeline exploded" });

    expect(redis._store.has(LOCK_KEY)).toBe(false);
  });
});
