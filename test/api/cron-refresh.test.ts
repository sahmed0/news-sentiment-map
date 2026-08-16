import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createFakeRedis } from "../helpers/fakeRedis.js";

// Isolate the cron handler from Redis and the fetch/select/persist pipeline so we
// test only its orchestration: auth, env guard, lock, branch selection, lock release.
vi.mock("@upstash/redis", () => ({ Redis: vi.fn() }));
vi.mock("../../api/_lib/sentiment-fetch.js", () => ({ fetchCountries: vi.fn() }));
vi.mock("../../api/_lib/refresh-core.js", () => ({
  selectDueCountries: vi.fn(),
  reserveCredits: vi.fn(),
  releaseCredits: vi.fn(),
  refundCounts: vi.fn(() => ({ newsdata: 0, gnews: 0 })),
  persistCountries: vi.fn(),
  rebuildAggregate: vi.fn(),
  recordTick: vi.fn(),
}));

import handler from "../../api/cron/refresh.js";
import { Redis } from "@upstash/redis";
import { fetchCountries } from "../../api/_lib/sentiment-fetch.js";
import {
  selectDueCountries,
  reserveCredits,
  releaseCredits,
  refundCounts,
  persistCountries,
  rebuildAggregate,
  recordTick,
} from "../../api/_lib/refresh-core.js";

const LOCK_KEY = "sentiment:refresh:lock";

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
const asReq = (headers: Record<string, string> = {}) => ({ headers }) as unknown as VercelRequest;
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
    vi.mocked(rebuildAggregate).mockResolvedValue(1);

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
    vi.mocked(rebuildAggregate).mockResolvedValue(7);

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
    vi.mocked(rebuildAggregate).mockResolvedValue(150);

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
    vi.mocked(rebuildAggregate).mockResolvedValue(7);

    await call(authedReq(), mockRes());

    expect(vi.mocked(recordTick).mock.calls[0][1]).toMatchObject({
      ok: 0,
      attempted: 0,
      aggregate: 7, // the idle rebuild still counts
      tzDue: 0,
      backfill: 0,
      refunded: 0,
    });
  });

  it("records the failure reason when the tick throws", async () => {
    vi.mocked(Redis).mockImplementation(function () { return createFakeRedis() as any; });
    vi.mocked(selectDueCountries).mockRejectedValue(new Error("upstream down"));

    await call(authedReq(), mockRes());

    expect(vi.mocked(recordTick).mock.calls[0][1]).toMatchObject({ ok: 0, attempted: 0, aggregate: 0, error: "upstream down" });
  });

  it("still returns 200 when recording the summary fails", async () => {
    const redis = createFakeRedis();
    vi.mocked(Redis).mockImplementation(function () { return redis as any; });
    vi.mocked(selectDueCountries).mockResolvedValue({ subset: [], counts: { gnews: 0, newsdata: 0 }, dayId: 1, gnDayId: 2, diag: { budget: 0 } } as any);
    vi.mocked(rebuildAggregate).mockResolvedValue(7);
    vi.mocked(recordTick).mockRejectedValue(new Error("ticks key gone"));

    const res = mockRes();
    await call(authedReq(), res);

    expect(res.statusCode).toBe(200); // bookkeeping must never fail a healthy tick
    expect(res.body).toMatchObject({ ok: true, aggregate: 7 });
    expect(redis._store.has(LOCK_KEY)).toBe(false);
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
