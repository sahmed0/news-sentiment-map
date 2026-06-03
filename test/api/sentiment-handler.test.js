import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createFakeRedis } from "../helpers/fakeRedis.js";

// The handler does `new Redis(...)` via a dynamic import; intercept the module so
// it talks to an in-memory fake instead of a real Upstash instance.
vi.mock("@upstash/redis", () => ({ Redis: vi.fn() }));

import handler from "../../api/sentiment.js";
import { Redis } from "@upstash/redis";

function mockRes() {
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

beforeEach(() => {
  vi.stubEnv("KV_REST_API_URL", "https://fake");
  vi.stubEnv("KV_REST_API_TOKEN", "tok");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  Redis.mockReset();
});

describe("GET /api/sentiment", () => {
  it("returns 500 when Redis env vars are missing", async () => {
    vi.stubEnv("KV_REST_API_URL", "");
    const res = mockRes();
    await handler({}, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Redis not configured" });
  });

  it("returns 503 with Retry-After while the cache is cold (no aggregate yet)", async () => {
    Redis.mockImplementation(function () {
      return createFakeRedis(); // sentiment:world absent → get() → null
    });
    const res = mockRes();
    await handler({}, res);
    expect(res.statusCode).toBe(503);
    expect(res.headers["Retry-After"]).toBe("15");
    expect(res.body.error).toMatch(/warming/i);
  });

  it("serves the aggregate with cached flag", async () => {
    const data = [
      { code: "us", name: "US", score: 0.2, fetchedAt: "2024-01-02T00:00:00.000Z" },
      { code: "gb", name: "UK", score: -0.1, fetchedAt: "2024-01-01T00:00:00.000Z" },
    ];
    Redis.mockImplementation(function () {
      return createFakeRedis({ store: { "sentiment:world": data } });
    });
    const res = mockRes();
    await handler({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
  });
});
