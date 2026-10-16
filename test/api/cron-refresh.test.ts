import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createFakeRedis } from "../helpers/fakeRedis.js";
import { LOCK_KEY } from "../../api/_lib/lock.js";

// Isolate the cron handler from Redis and the fetch/select/persist pipeline so we
// test only its orchestration: auth, env guard, lock, branch selection, lock release.
vi.mock("@upstash/redis", () => ({ Redis: vi.fn() }));
vi.mock("../../api/_lib/sentiment-fetch.js", () => ({ fetchCountries: vi.fn(), probeScoring: vi.fn() }));
vi.mock("../../api/_lib/refresh-core.js", () => ({
  SCORING_DOWN_KEY: "sentiment:scoring:down",
  selectDueCountries: vi.fn(),
  reserveCredits: vi.fn(),
  releaseCredits: vi.fn(),
  refundCounts: vi.fn(() => ({ newsdata: 0, gnews: 0 })),
  persistCountries: vi.fn(),
  rebuildAggregate: vi.fn(),
  refreshWorldHistory: vi.fn(),
  recordTick: vi.fn(),
}));

import handler from "../../api/cron/refresh.js";
import { Redis } from "@upstash/redis";
import { fetchCountries, probeScoring } from "../../api/_lib/sentiment-fetch.js";
import {
  SCORING_DOWN_KEY,
  selectDueCountries,
  reserveCredits,
  releaseCredits,
  refundCounts,
  persistCountries,
  rebuildAggregate,
  refreshWorldHistory,
  recordTick,
} from "../../api/_lib/refresh-core.js";

interface MockRes {
  statusCode: number | null;
  body: any;
  status(code: number): MockRes;
  json(obj: any): MockRes;
}
function mockRes(): MockRes {
  return {
    statusCode: null,
    body: null,
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
// QStash always POSTs, so that is the default; the method guard test overrides it.
const asReq = (headers: Record<string, string> = {}, method = "POST") => ({ headers, method }) as unknown as VercelRequest;
const authedReq = () => asReq({ authorization: "Bearer secret" });
const call = (req: VercelRequest, res: MockRes) => handler(req, res as unknown as VercelResponse);

beforeEach(() => {
  vi.clearAllMocks(); // reset module-mock call history between tests
  vi.stubEnv("CRON_SECRET", "secret");
  vi.stubEnv("KV_REST_API_URL", "https://fake");
  vi.stubEnv("KV_REST_API_TOKEN", "tok");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(Redis).mockReset();
});

describe("POST /api/cron/refresh - guards", () => {
  it("rejects a token of a different length (length guard, before timingSafeEqual)", async () => {
    const res = mockRes();
    await call(asReq({ authorization: "Bearer wrong" }), res); // shorter than "Bearer secret"
    expect(res.statusCode).toBe(401);
    expect(Redis).not.toHaveBeenCalled();
  });

  it("rejects a wrong token of the same length (constant-time compare)", async () => {
    const res = mockRes();
    await call(asReq({ authorization: "Bearer secreT" }), res);
    expect(res.statusCode).toBe(401);
    expect(Redis).not.toHaveBeenCalled();
  });

  it("rejects a request with no authorization header at all", async () => {
    const res = mockRes();
    await call(asReq(), res);
    expect(res.statusCode).toBe(401);
    expect(Redis).not.toHaveBeenCalled();
  });

  it("fails closed with 500 when CRON_SECRET is unset", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const res = mockRes();
    await call(authedReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "CRON_SECRET not configured" });
    expect(Redis).not.toHaveBeenCalled();
  });

  it("returns 500 when Redis env vars are missing", async () => {
    vi.stubEnv("KV_REST_API_URL", "");
    const res = mockRes();
    await call(authedReq(), res);
    expect(res.statusCode).toBe(500);
  });

  it("rejects a GET carrying a valid bearer with 405 and runs no tick", async () => {
    const res = mockRes();
    await call(asReq({ authorization: "Bearer secret" }, "GET"), res);
    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: "Method not allowed" });
    expect(Redis).not.toHaveBeenCalled();
    expect(selectDueCountries).not.toHaveBeenCalled();
  });

  it("answers an unauthenticated GET with 401, not 405, so the method check reveals nothing", async () => {
    const res = mockRes();
    await call(asReq({}, "GET"), res);
    expect(res.statusCode).toBe(401);
  });

  it("exits early when another tick already holds the lock", async () => {
    // Regular function (not arrow) so the handler's `new Redis(...)` can construct it.
    vi.mocked(Redis).mockImplementation(function () { return createFakeRedis({ store: { [LOCK_KEY]: "1" } }) as any; });
    const res = mockRes();
    await call(authedReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: false, reason: "tick already in progress" });
    expect(selectDueCountries).not.toHaveBeenCalled();
  });
});

describe("POST /api/cron/refresh - orchestration", () => {
  it("runs the full pipeline and releases the lock on success", async () => {
    const redis = createFakeRedis();
    vi.mocked(Redis).mockImplementation(function () { return redis as any; });

    const selection: any = {
      subset: [{ code: "us" }],
      counts: { gnews: 1, newsdata: 0 },
      dayId: 1,
      gnDayId: 2,
      diag: { budget: 5 },
    };
    vi.mocked(selectDueCountries).mockResolvedValue(selection);
    vi.mocked(reserveCredits).mockResolvedValue(undefined);
    const fetched: any = [{ code: "us", score: 0.3, articles: [] }];
    vi.mocked(fetchCountries).mockResolvedValue(fetched);
    vi.mocked(refundCounts).mockReturnValue({ newsdata: 0, gnews: 0 });
    vi.mocked(releaseCredits).mockResolvedValue(undefined);
    vi.mocked(persistCountries).mockResolvedValue(["us"]);
    vi.mocked(rebuildAggregate).mockResolvedValue({ count: 1, dupSets: 0, sharedFeed: 0 });

    const res = mockRes();
    await call(authedReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, refreshed: ["us"], attempted: 1, aggregate: 1 });
    expect(reserveCredits).toHaveBeenCalledWith(redis, selection.counts, selection);
    expect(fetchCountries).toHaveBeenCalledWith(selection.subset, expect.any(Object));
    // Refund runs between fetch and persist, charged against the same selection ledger.
    expect(refundCounts).toHaveBeenCalledWith(fetched);
    expect(releaseCredits).toHaveBeenCalledWith(redis, { newsdata: 0, gnews: 0 }, selection);
    expect(persistCountries).toHaveBeenCalled();
    expect(rebuildAggregate).toHaveBeenCalled();
    // finally → lock released
    expect(redis._store.has(LOCK_KEY)).toBe(false);
  });

  it("takes the idle branch (rebuild only) when nothing is due / budget exhausted", async () => {
    vi.mocked(Redis).mockImplementation(function () { return createFakeRedis() as any; });
    vi.mocked(selectDueCountries).mockResolvedValue({ subset: [], counts: { gnews: 0, newsdata: 0 }, dayId: 1, gnDayId: 2, diag: { budget: 0 } } as any);
    vi.mocked(rebuildAggregate).mockResolvedValue({ count: 7, dupSets: 0, sharedFeed: 0 });

    const res = mockRes();
    await call(authedReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, refreshed: [], aggregate: 7 });
    expect(res.body.debug.reason).toBe("budget_exhausted");
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(fetchCountries).not.toHaveBeenCalled();
  });

  it("records a tick summary describing the work it did", async () => {
    vi.mocked(Redis).mockImplementation(function () { return createFakeRedis() as any; });
    vi.mocked(selectDueCountries).mockResolvedValue({
      subset: [{ code: "us" }, { code: "gb" }],
      counts: { gnews: 2, newsdata: 0 },
      dayId: 1,
      gnDayId: 2,
      diag: { budget: 5, tzDue: 1, backfill: 1, gnUsedDay: 12, ndUsedDay: 34 },
    } as any);
    vi.mocked(fetchCountries).mockResolvedValue([] as any);
    vi.mocked(refundCounts).mockReturnValue({ newsdata: 3, gnews: 4 });
    vi.mocked(persistCountries).mockResolvedValue(["us"]);
    vi.mocked(rebuildAggregate).mockResolvedValue({ count: 150, dupSets: 6, sharedFeed: 11 });

    await call(authedReq(), mockRes());

    expect(recordTick).toHaveBeenCalledTimes(1);
    const summary = vi.mocked(recordTick).mock.calls[0][1];
    expect(summary).toMatchObject({
      ok: 1,
      attempted: 2,
      aggregate: 150,
      tzDue: 1,
      backfill: 1,
      gnUsedDay: 12,
      ndUsedDay: 34,
      refunded: 7, // both providers' refunds summed
      dupSets: 6,
      sharedFeed: 11,
    });
    expect(typeof summary.ms).toBe("number");
    expect(new Date(summary.ts).toISOString()).toBe(summary.ts);
    expect(summary.error).toBeUndefined();
    // The summary is stored as JSON, so it must survive a round trip unchanged.
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });

  it("records a zeroed summary for an idle tick", async () => {
    vi.mocked(Redis).mockImplementation(function () { return createFakeRedis() as any; });
    vi.mocked(selectDueCountries).mockResolvedValue({ subset: [], counts: { gnews: 0, newsdata: 0 }, dayId: 1, gnDayId: 2, diag: { budget: 0 } } as any);
    vi.mocked(rebuildAggregate).mockResolvedValue({ count: 7, dupSets: 2, sharedFeed: 3 });

    await call(authedReq(), mockRes());

    expect(vi.mocked(recordTick).mock.calls[0][1]).toMatchObject({
      ok: 0,
      attempted: 0,
      aggregate: 7, // the idle rebuild still counts
      tzDue: 0,
      backfill: 0,
      refunded: 0,
      dupSets: 2,
      sharedFeed: 3,
    });
  });

  it("records the failure reason when the tick throws", async () => {
    vi.mocked(Redis).mockImplementation(function () { return createFakeRedis() as any; });
    vi.mocked(selectDueCountries).mockRejectedValue(new Error("upstream down"));

    await call(authedReq(), mockRes());

    const summary = vi.mocked(recordTick).mock.calls[0][1];
    expect(summary).toMatchObject({ ok: 0, attempted: 0, aggregate: 0, error: "upstream down" });
    // No aggregate rebuild on this path, so no overlap numbers (not zeros).
    expect(summary).not.toHaveProperty("dupSets");
    expect(summary).not.toHaveProperty("sharedFeed");
  });

  it("still returns 200 when recording the summary fails", async () => {
    const redis = createFakeRedis();
    vi.mocked(Redis).mockImplementation(function () { return redis as any; });
    vi.mocked(selectDueCountries).mockResolvedValue({ subset: [], counts: { gnews: 0, newsdata: 0 }, dayId: 1, gnDayId: 2, diag: { budget: 0 } } as any);
    vi.mocked(rebuildAggregate).mockResolvedValue({ count: 7, dupSets: 0, sharedFeed: 0 });
    vi.mocked(recordTick).mockRejectedValue(new Error("ticks key gone"));

    const res = mockRes();
    await call(authedReq(), res);

    expect(res.statusCode).toBe(200); // bookkeeping must never fail a healthy tick
    expect(res.body).toMatchObject({ ok: true, aggregate: 7 });
    expect(redis._store.has(LOCK_KEY)).toBe(false);
  });

  it("patches world history from the countries that actually scored", async () => {
    const redis = createFakeRedis();
    vi.mocked(Redis).mockImplementation(function () { return redis as any; });
    vi.mocked(selectDueCountries).mockResolvedValue({
      subset: [{ code: "us" }, { code: "gb" }],
      counts: { gnews: 2, newsdata: 0 },
      dayId: 42,
      gnDayId: 43,
      diag: { budget: 5, tzDue: 2, backfill: 0 },
    } as any);
    vi.mocked(fetchCountries).mockResolvedValue([
      { code: "us", score: 0.4, articles: [{ title: "a", score: 0.4 }] },
      { code: "gb", score: null, articles: [] }, // never scored → excluded from the patch
    ] as any);
    vi.mocked(refundCounts).mockReturnValue({ newsdata: 0, gnews: 0 });
    vi.mocked(persistCountries).mockResolvedValue(["us"]);
    vi.mocked(rebuildAggregate).mockResolvedValue({ count: 2, dupSets: 0, sharedFeed: 0 });
    vi.mocked(refreshWorldHistory).mockResolvedValue("patched");

    const res = mockRes();
    await call(authedReq(), res);

    expect(refreshWorldHistory).toHaveBeenCalledWith(redis, [{ code: "us", score: 0.4 }], 42);
    expect(res.body.debug.worldHistory).toBe("patched");
  });

  it("maintains world history on the idle path with an empty points array", async () => {
    vi.mocked(Redis).mockImplementation(function () { return createFakeRedis() as any; });
    vi.mocked(selectDueCountries).mockResolvedValue({ subset: [], counts: { gnews: 0, newsdata: 0 }, dayId: 9, gnDayId: 10, diag: { budget: 0 } } as any);
    vi.mocked(rebuildAggregate).mockResolvedValue({ count: 7, dupSets: 0, sharedFeed: 0 });
    vi.mocked(refreshWorldHistory).mockResolvedValue("rebuilt");

    const res = mockRes();
    await call(authedReq(), res);

    expect(refreshWorldHistory).toHaveBeenCalledWith(expect.anything(), [], 9);
    expect(res.body.debug.worldHistory).toBe("rebuilt");
  });

  it("survives a world-history failure without failing the tick", async () => {
    const redis = createFakeRedis();
    vi.mocked(Redis).mockImplementation(function () { return redis as any; });
    vi.mocked(selectDueCountries).mockResolvedValue({
      subset: [{ code: "us" }],
      counts: { gnews: 1, newsdata: 0 },
      dayId: 1,
      gnDayId: 2,
      diag: { budget: 5 },
    } as any);
    vi.mocked(fetchCountries).mockResolvedValue([{ code: "us", score: 0.4, articles: [{ title: "a", score: 0.4 }] }] as any);
    vi.mocked(refundCounts).mockReturnValue({ newsdata: 0, gnews: 0 });
    vi.mocked(persistCountries).mockResolvedValue(["us"]);
    vi.mocked(rebuildAggregate).mockResolvedValue({ count: 1, dupSets: 0, sharedFeed: 0 });
    vi.mocked(refreshWorldHistory).mockRejectedValue(new Error("world history boom"));

    const res = mockRes();
    await call(authedReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, refreshed: ["us"] });
    expect(res.body.debug.worldHistory).toBe("failed");
    expect(redis._store.has(LOCK_KEY)).toBe(false); // released in finally
  });

  it("returns 500 and still releases the lock when the tick throws", async () => {
    const redis = createFakeRedis();
    vi.mocked(Redis).mockImplementation(function () { return redis as any; });
    vi.mocked(selectDueCountries).mockRejectedValue(new Error("upstream down"));

    const res = mockRes();
    await call(authedReq(), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: "upstream down" });
    expect(redis._store.has(LOCK_KEY)).toBe(false); // released in finally
  });
});

describe("POST /api/cron/refresh - scoring breaker", () => {
  const dueSelection = () =>
    ({
      subset: [{ code: "us" }, { code: "gb" }],
      counts: { gnews: 2, newsdata: 0 },
      dayId: 1,
      gnDayId: 2,
      diag: { budget: 5, tzDue: 2, backfill: 0 },
    }) as any;
  const DOWN_SINCE = "2026-10-07T12:00:00.000Z";

  beforeEach(() => {
    vi.mocked(selectDueCountries).mockResolvedValue(dueSelection());
    vi.mocked(refundCounts).mockReturnValue({ newsdata: 0, gnews: 0 });
    vi.mocked(rebuildAggregate).mockResolvedValue({ count: 150, dupSets: 2, sharedFeed: 8 });
  });

  it("does not probe the scorer while no outage is flagged", async () => {
    vi.mocked(Redis).mockImplementation(function () { return createFakeRedis() as any; });
    vi.mocked(fetchCountries).mockResolvedValue([] as any);
    vi.mocked(persistCountries).mockResolvedValue([]);

    await call(authedReq(), mockRes());

    expect(probeScoring).not.toHaveBeenCalled();
    expect(fetchCountries).toHaveBeenCalledWith(expect.any(Array), expect.any(Object));
  });

  it("flags the scorer down when every headline came back unscored", async () => {
    const redis = createFakeRedis();
    vi.mocked(Redis).mockImplementation(function () { return redis as any; });
    vi.mocked(fetchCountries).mockImplementation(async (_subset, stats) => {
      stats!.scoringFailed = true;
      return [] as any;
    });
    vi.mocked(persistCountries).mockResolvedValue([]);

    await call(authedReq(), mockRes());

    expect(new Date(redis._store.get(SCORING_DOWN_KEY) as string).toISOString()).toBe(redis._store.get(SCORING_DOWN_KEY));
    expect(vi.mocked(recordTick).mock.calls[0][1].error).toBe("scoring failed for every headline");
  });

  it("starts a new outage clock when scoring fails again after a passing probe", async () => {
    const redis = createFakeRedis({ store: { [SCORING_DOWN_KEY]: DOWN_SINCE } });
    vi.mocked(Redis).mockImplementation(function () { return redis as any; });
    vi.mocked(probeScoring).mockResolvedValue(true); // probe passes, then the tick's scoring fails again
    vi.mocked(fetchCountries).mockImplementation(async (_subset, stats) => {
      stats!.scoringFailed = true;
      return [] as any;
    });
    vi.mocked(persistCountries).mockResolvedValue([]);

    await call(authedReq(), mockRes());

    // The probe cleared it and the tick set it afresh - a new outage, a new time.
    expect(redis._store.get(SCORING_DOWN_KEY)).not.toBe(DOWN_SINCE);
    expect(redis._store.has(SCORING_DOWN_KEY)).toBe(true);
  });

  it("spends no credits while the probe still fails", async () => {
    const redis = createFakeRedis({ store: { [SCORING_DOWN_KEY]: DOWN_SINCE } });
    vi.mocked(Redis).mockImplementation(function () { return redis as any; });
    vi.mocked(probeScoring).mockResolvedValue(false);

    const res = mockRes();
    await call(authedReq(), res);

    expect(res.statusCode).toBe(200); // a non-2xx would make QStash retry
    expect(res.body).toEqual({ ok: false, reason: "scoring_unavailable", since: DOWN_SINCE, aggregate: 150 });
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(fetchCountries).not.toHaveBeenCalled();
    expect(redis._store.get(SCORING_DOWN_KEY)).toBe(DOWN_SINCE);
    expect(vi.mocked(recordTick).mock.calls[0][1]).toMatchObject({
      ok: 0,
      attempted: 0,
      aggregate: 150,
      error: `scoring unavailable since ${DOWN_SINCE}`,
      dupSets: 2,
      sharedFeed: 8,
    });
    expect(redis._store.has(LOCK_KEY)).toBe(false);
  });

  it("clears the flag and runs the tick once the probe passes", async () => {
    const redis = createFakeRedis({ store: { [SCORING_DOWN_KEY]: DOWN_SINCE } });
    vi.mocked(Redis).mockImplementation(function () { return redis as any; });
    vi.mocked(probeScoring).mockResolvedValue(true);
    vi.mocked(fetchCountries).mockResolvedValue([{ code: "us", score: 0.4, articles: [{ title: "a", score: 0.4 }] }] as any);
    vi.mocked(persistCountries).mockResolvedValue(["us"]);

    const res = mockRes();
    await call(authedReq(), res);

    expect(redis._store.has(SCORING_DOWN_KEY)).toBe(false);
    expect(reserveCredits).toHaveBeenCalled();
    expect(fetchCountries).toHaveBeenCalled();
    expect(res.body).toMatchObject({ ok: true, refreshed: ["us"] });
    expect(vi.mocked(recordTick).mock.calls[0][1].error).toBeUndefined();
  });
});

describe("POST /api/cron/refresh - lock ownership", () => {
  const idleSelection = { subset: [], counts: { gnews: 0, newsdata: 0 }, dayId: 1, gnDayId: 2, diag: { budget: 0 } } as any;

  it("holds the lock under a per-invocation token and releases the lock it owns", async () => {
    const redis = createFakeRedis();
    vi.mocked(Redis).mockImplementation(function () { return redis as any; });
    let heldDuringTick: unknown;
    vi.mocked(selectDueCountries).mockImplementation(async () => {
      heldDuringTick = redis._store.get(LOCK_KEY);
      return idleSelection;
    });
    vi.mocked(rebuildAggregate).mockResolvedValue({ count: 0, dupSets: 0, sharedFeed: 0 });

    await call(authedReq(), mockRes());

    // A random token rather than the old constant "1", so two ticks can tell
    // their locks apart.
    expect(heldDuringTick).toMatch(/^[0-9a-f-]{36}$/);
    expect(redis._store.has(LOCK_KEY)).toBe(false);
  });

  it("does not delete a lock that a successor acquired after this tick's expired", async () => {
    const redis = createFakeRedis();
    vi.mocked(Redis).mockImplementation(function () { return redis as any; });
    // Simulate the TTL expiring mid-tick and another invocation taking the lock.
    vi.mocked(selectDueCountries).mockImplementation(async () => {
      redis._store.set(LOCK_KEY, "successor-token");
      return idleSelection;
    });
    vi.mocked(rebuildAggregate).mockResolvedValue({ count: 0, dupSets: 0, sharedFeed: 0 });

    const res = mockRes();
    await call(authedReq(), res);

    expect(res.statusCode).toBe(200);
    expect(redis._store.get(LOCK_KEY)).toBe("successor-token");
  });

  it("does not delete the successor's lock on the error path either", async () => {
    const redis = createFakeRedis();
    vi.mocked(Redis).mockImplementation(function () { return redis as any; });
    vi.mocked(selectDueCountries).mockImplementation(async () => {
      redis._store.set(LOCK_KEY, "successor-token");
      throw new Error("upstream down");
    });

    const res = mockRes();
    await call(authedReq(), res);

    expect(res.statusCode).toBe(500);
    expect(redis._store.get(LOCK_KEY)).toBe("successor-token");
  });

  it("still returns 200 when the lock release itself fails", async () => {
    const redis = createFakeRedis();
    redis.eval = async () => { throw new Error("redis unreachable"); };
    vi.mocked(Redis).mockImplementation(function () { return redis as any; });
    vi.mocked(selectDueCountries).mockResolvedValue(idleSelection);
    vi.mocked(rebuildAggregate).mockResolvedValue({ count: 7, dupSets: 0, sharedFeed: 0 });

    const res = mockRes();
    await call(authedReq(), res);

    // The TTL is the backstop for a failed release; the tick itself succeeded.
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, aggregate: 7 });
  });
});
