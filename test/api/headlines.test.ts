import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createFakeRedis } from "../helpers/fakeRedis.js";
import { HEADLINES_KEY, bucketToDate, dayId } from "../../api/_lib/refresh-core.js";
import { parseStoredHeadlineDay } from "../../shared/types.js";

// The handler does `new Redis(...)` via a dynamic import; intercept the module so
// it talks to an in-memory fake instead of a real Upstash instance.
vi.mock("@upstash/redis", () => ({ Redis: vi.fn() }));

import handler from "../../api/headlines.js";
import { Redis } from "@upstash/redis";

const article = (title: string) => ({
  title,
  url: `https://e.x/${title}`,
  publishedAt: "2026-11-20T08:00:00Z",
  language: "english",
  translatedTitle: null,
  score: 0.25,
});

describe("parseStoredHeadlineDay", () => {
  it("parses an object or a JSON string", () => {
    const value = { d: 500, articles: [article("a")] };
    expect(parseStoredHeadlineDay(value)).toEqual(value);
    expect(parseStoredHeadlineDay(JSON.stringify(value))).toEqual(value);
  });

  it.each([
    ["an invalid JSON string", "{not json"],
    ["null", null],
    ["a string d", { d: "500", articles: [] }],
    ["non-array articles", { d: 500, articles: { title: "a" } }],
  ])("returns null for %s", (_label, v) => {
    expect(parseStoredHeadlineDay(v)).toBeNull();
  });

  it("drops non-records and sets missing or wrong-typed fields to null", () => {
    const parsed = parseStoredHeadlineDay({
      d: 500,
      articles: [
        7,
        null,
        { title: 3, url: false, publishedAt: {}, language: [], translatedTitle: 1, score: "0.5", extra: "x" },
        { title: "a", score: 0.1 }, // the partial shape persistCountries accepts
      ],
    });
    expect(parsed).toEqual({
      d: 500,
      articles: [
        { title: null, url: null, publishedAt: null, language: null, translatedTitle: null, score: null },
        { title: "a", url: null, publishedAt: null, language: null, translatedTitle: null, score: 0.1 },
      ],
    });
    expect(parsed!.articles[0]).not.toHaveProperty("extra");
  });
});

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

const NOW = new Date("2026-11-27T12:00:00Z");
const TODAY = dayId(NOW);
const CACHEABLE = "public, s-maxage=1800, stale-while-revalidate=3600";
const stored = (d: number, title = `t${d}`) => ({ d, articles: [article(title)] });
const useRedis = (store: Record<string, unknown>) => {
  const fake = createFakeRedis({ store });
  // Regular function (not arrow) so the handler's `new Redis(...)` can construct it.
  vi.mocked(Redis).mockImplementation(function () { return fake as any; });
  return fake;
};

beforeEach(() => {
  vi.stubEnv("KV_REST_API_URL", "https://fake");
  vi.stubEnv("KV_REST_API_TOKEN", "tok");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(Redis).mockReset();
});

describe("GET /api/headlines", () => {
  it("returns 500 when Redis env vars are missing", async () => {
    vi.stubEnv("KV_REST_API_URL", "");
    const res = mockRes();
    await call(res, { code: "us" });
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Redis not configured" });
  });

  it.each([
    ["an unknown code", { code: "zz" }],
    ["a repeated code param", { code: ["us", "gb"] }],
  ])("rejects %s with 400 before touching Redis", async (_label, query) => {
    const res = mockRes();
    await call(res, query);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "Unknown country code" });
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(Redis).not.toHaveBeenCalled();
  });

  it("degrades to a 503 when Redis is unreachable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); // handler logs the outage
    vi.mocked(Redis).mockImplementation(function () {
      return { mget: vi.fn().mockRejectedValue(new Error("upstash down")) } as any;
    });
    const res = mockRes();
    await expect(call(res, { code: "us" })).resolves.toBeDefined();
    expect(res.statusCode).toBe(503);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(res.headers["Retry-After"]).toBe("30");
    expect(res.body).toEqual({ error: "Data temporarily unavailable" });
  });

  it("returns every unexpired day ascending, in one mget, and not day today-33", async () => {
    const fake = useRedis(
      Object.fromEntries([0, 1, 30, 32, 33].map((ago) => [HEADLINES_KEY("us", TODAY - ago), stored(TODAY - ago)]))
    );
    const mget = vi.spyOn(fake, "mget");
    const res = mockRes();
    await call(res, { code: "US" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe(CACHEABLE);
    expect(res.body.code).toBe("us");
    expect(res.body.days).toEqual(
      [32, 30, 1, 0].map((ago) => ({ date: bucketToDate(TODAY - ago), articles: [article(`t${TODAY - ago}`)] }))
    );
    expect(mget).toHaveBeenCalledTimes(1);
    expect(mget.mock.calls[0]).toHaveLength(33);
  });

  it("omits a misfiled day, an empty day and a malformed value", async () => {
    useRedis({
      [HEADLINES_KEY("us", TODAY - 3)]: stored(TODAY - 4), // d disagrees with its key
      [HEADLINES_KEY("us", TODAY - 2)]: { d: TODAY - 2, articles: [null, 5] }, // empty after normalising
      [HEADLINES_KEY("us", TODAY - 1)]: "{truncated",
      [HEADLINES_KEY("us", TODAY)]: stored(TODAY),
    });
    const res = mockRes();
    await call(res, { code: "us" });
    expect(res.body.days.map((x: { date: string }) => x.date)).toEqual([bucketToDate(TODAY)]);
  });
});
