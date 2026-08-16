import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createFakeRedis } from "../helpers/fakeRedis.js";
import { HISTORY_KEY } from "../../api/_lib/refresh-core.js";

// The handler does `new Redis(...)` via a dynamic import; intercept the module so
// it talks to an in-memory fake instead of a real Upstash instance.
vi.mock("@upstash/redis", () => ({ Redis: vi.fn() }));

import handler from "../../api/history.js";
import { Redis } from "@upstash/redis";

// Minimal req/res doubles; cast to the Vercel types at the call site.
const req = (query: Record<string, unknown> = {}) => ({ query }) as unknown as VercelRequest;
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
const call = (res: MockRes, query?: Record<string, unknown>) =>
  handler(req(query), res as unknown as VercelResponse);

// Day bucket 20000 = 2024-10-04 on the NewsData-shifted clock (bucket * DAY_MS +
// the 1 h offset). Hardcoded so a change to the offset fails this test loudly.
const DAY = 20000;
const seedRedis = (members: Record<string, number>) =>
  createFakeRedis({ zsets: { [HISTORY_KEY("us")]: members } });
const point = (d: number, s: number, n: number) => JSON.stringify({ d, s, n });

beforeEach(() => {
  vi.stubEnv("KV_REST_API_URL", "https://fake");
  vi.stubEnv("KV_REST_API_TOKEN", "tok");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(Redis).mockReset();
});

describe("GET /api/history", () => {
  it("returns 500 when Redis env vars are missing", async () => {
    vi.stubEnv("KV_REST_API_URL", "");
    const res = mockRes();
    await call(res, { code: "us" });
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Redis not configured" });
  });

  it("serves the series oldest-first with dates and the long edge cache", async () => {
    const fake = seedRedis({
      [point(DAY, 0.25, 4)]: DAY,
      [point(DAY + 1, -0.5, 2)]: DAY + 1,
    });
    // Regular function (not arrow) so the handler's `new Redis(...)` can construct it.
    vi.mocked(Redis).mockImplementation(function () { return fake as any; });
    const res = mockRes();
    await call(res, { code: "us" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      code: "us",
      points: [
        { date: "2024-10-04", score: 0.25, n: 4 },
        { date: "2024-10-05", score: -0.5, n: 2 },
      ],
    });
    expect(res.headers["Cache-Control"]).toBe("public, s-maxage=3600, stale-while-revalidate=86400");
  });

  it("returns the last 30 points when the series is longer", async () => {
    const members: Record<string, number> = {};
    for (let i = 0; i < 45; i++) members[point(DAY + i, i / 100, 1)] = DAY + i;
    vi.mocked(Redis).mockImplementation(function () { return seedRedis(members) as any; });
    const res = mockRes();
    await call(res, { code: "us" });
    expect(res.body.points).toHaveLength(30);
    expect(res.body.points[0].score).toBe(0.15); // days 0-14 dropped, 15 first
    expect(res.body.points[29].score).toBe(0.44);
  });

  it("treats an empty history as a normal 200 (cold start)", async () => {
    vi.mocked(Redis).mockImplementation(function () { return createFakeRedis() as any; });
    const res = mockRes();
    await call(res, { code: "gb" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ code: "gb", points: [] });
  });

  it("normalises an uppercase code", async () => {
    vi.mocked(Redis).mockImplementation(function () {
      return seedRedis({ [point(DAY, 0.1, 1)]: DAY }) as any;
    });
    const res = mockRes();
    await call(res, { code: "US" });
    expect(res.statusCode).toBe(200);
    expect(res.body.code).toBe("us");
    expect(res.body.points).toHaveLength(1);
  });

  it.each([
    ["a well-formed but unknown code", { code: "zz" }],
    ["an alpha-3 code", { code: "USA" }],
    ["a missing code", {}],
    ["a repeated code param", { code: ["us", "gb"] }],
  ])("rejects %s with 400 before touching Redis", async (_label, query) => {
    const res = mockRes();
    await call(res, query);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "Unknown country code" });
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(Redis).not.toHaveBeenCalled();
  });

  it("degrades to a 503 instead of throwing when Redis is unreachable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); // handler logs the outage
    vi.mocked(Redis).mockImplementation(function () {
      return { zrange: vi.fn().mockRejectedValue(new Error("upstash down")) } as any;
    });
    const res = mockRes();
    await expect(call(res, { code: "us" })).resolves.toBeDefined(); // no unhandled rejection
    expect(res.statusCode).toBe(503);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(res.headers["Retry-After"]).toBe("30");
    expect(res.body).toEqual({ error: "Data temporarily unavailable" });
  });

  it("serves points when the client auto-deserializes ZSET members into objects", async () => {
    // The real @upstash/redis client's automatic deserialization JSON.parses every
    // string in a command's response, so zrange hands back already-parsed objects,
    // not the JSON strings persistCountries wrote. fakeRedis stores/returns raw
    // strings, so this is stubbed directly to reproduce that real-world shape.
    vi.mocked(Redis).mockImplementation(function () {
      return { zrange: vi.fn().mockResolvedValue([{ d: DAY, s: 0.25, n: 4 }]) } as any;
    });
    const res = mockRes();
    await call(res, { code: "us" });
    expect(res.statusCode).toBe(200);
    expect(res.body.points).toEqual([{ date: "2024-10-04", score: 0.25, n: 4 }]);
  });

  it("skips malformed members and still serves the valid ones", async () => {
    vi.mocked(Redis).mockImplementation(function () {
      return seedRedis({
        "not json": DAY,
        [JSON.stringify({ d: "x", s: 0.1, n: 1 })]: DAY + 1,
        [JSON.stringify({ d: DAY + 2 })]: DAY + 2, // missing s/n
        [point(DAY + 3, 0.3, 5)]: DAY + 3,
      }) as any;
    });
    const res = mockRes();
    await call(res, { code: "us" });
    expect(res.statusCode).toBe(200);
    expect(res.body.points).toEqual([{ date: "2024-10-07", score: 0.3, n: 5 }]);
  });
});
