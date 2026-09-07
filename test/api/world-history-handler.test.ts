import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createFakeRedis } from "../helpers/fakeRedis.js";
import { WORLD_HISTORY_KEY } from "../../api/_lib/refresh-core.js";

// The handler does `new Redis(...)` via a dynamic import; intercept the module so
// it talks to an in-memory fake instead of a real Upstash instance.
vi.mock("@upstash/redis", () => ({ Redis: vi.fn() }));

import handler from "../../api/world-history.js";
import { Redis } from "@upstash/redis";

const req = () => ({}) as unknown as VercelRequest;
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
const call = (res: MockRes) => handler(req(), res as unknown as VercelResponse);

const WH = {
  days: ["2024-10-01", "2024-10-02", "2024-10-03"],
  scores: { us: [0.1, 0.2, null], gb: [null, -0.3, -0.4] },
};

beforeEach(() => {
  vi.stubEnv("KV_REST_API_URL", "https://fake");
  vi.stubEnv("KV_REST_API_TOKEN", "tok");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(Redis).mockReset();
});

describe("GET /api/world-history", () => {
  it("returns 500 when Redis env vars are missing", async () => {
    vi.stubEnv("KV_REST_API_URL", "");
    const res = mockRes();
    await call(res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Redis not configured" });
  });

  it("serves the populated blob with the long edge cache", async () => {
    // Regular function (not arrow) so the handler's `new Redis(...)` can construct it.
    vi.mocked(Redis).mockImplementation(function () {
      return createFakeRedis({ store: { [WORLD_HISTORY_KEY]: WH } }) as any;
    });
    const res = mockRes();
    await call(res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(WH);
    expect(res.headers["Cache-Control"]).toBe("public, s-maxage=1800, stale-while-revalidate=86400");
    // Same-origin frontend: open CORS would only invite hotlinks.
    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("returns a retryable 503 while the key is absent (warming)", async () => {
    vi.mocked(Redis).mockImplementation(function () { return createFakeRedis() as any; });
    const res = mockRes();
    await call(res);
    expect(res.statusCode).toBe(503);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(res.headers["Retry-After"]).toBe("15");
    expect(res.body.error).toMatch(/warming/i);
  });

  it("returns a retryable 503 when the stored key is malformed", async () => {
    vi.mocked(Redis).mockImplementation(function () {
      return createFakeRedis({ store: { [WORLD_HISTORY_KEY]: { days: "nope" } } }) as any;
    });
    const res = mockRes();
    await call(res);
    expect(res.statusCode).toBe(503);
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });

  it("degrades to a 503 instead of throwing when Redis is unreachable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); // handler logs the outage
    vi.mocked(Redis).mockImplementation(function () {
      return { get: vi.fn().mockRejectedValue(new Error("upstash down")) } as any;
    });
    const res = mockRes();
    await expect(call(res)).resolves.toBeDefined(); // no unhandled rejection
    expect(res.statusCode).toBe(503);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(res.headers["Retry-After"]).toBe("30");
    expect(res.body).toEqual({ error: "Data temporarily unavailable" });
  });
});
