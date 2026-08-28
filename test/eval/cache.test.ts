import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CACHE_DIR,
  DRY_RUN_CACHE_DIR,
  cacheDirFor,
  cacheKey,
  cached,
  readCache,
  writeCache,
} from "../../eval/cache.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eval-cache-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("cacheKey", () => {
  it("is stable for the same task and payload", () => {
    expect(cacheKey("hf:score", { texts: ["a", "b"] })).toBe(cacheKey("hf:score", { texts: ["a", "b"] }));
  });

  it("changes when the task or any part of the payload changes", () => {
    const base = cacheKey("hf:score", { texts: ["a"] });
    expect(cacheKey("azure:to-fr", { texts: ["a"] })).not.toBe(base);
    expect(cacheKey("hf:score", { texts: ["b"] })).not.toBe(base);
  });
});

describe("cacheDirFor", () => {
  it("keeps dry-run responses out of the live cache", () => {
    // A fixture score served to a later live run would be a fabricated result.
    expect(cacheDirFor(false)).toBe(CACHE_DIR);
    expect(cacheDirFor(true)).toBe(DRY_RUN_CACHE_DIR);
    expect(CACHE_DIR).not.toBe(DRY_RUN_CACHE_DIR);
  });
});

describe("read/write round trip", () => {
  it("returns null on a miss and the stored value on a hit", () => {
    const key = cacheKey("t", 1);
    expect(readCache(dir, key)).toBeNull();
    writeCache(dir, key, { scores: [0.5, null] });
    expect(readCache(dir, key)).toEqual({ scores: [0.5, null] });
  });

  it("treats a truncated entry as a miss rather than throwing", () => {
    const key = cacheKey("t", 2);
    writeFileSync(join(dir, `${key}.json`), '{"scores":[0.5', "utf8");
    expect(readCache(dir, key)).toBeNull();
  });
});

describe("cached", () => {
  it("runs the work once and serves the cached value afterwards", async () => {
    const work = vi.fn().mockResolvedValue([0.25]);
    const first = await cached(dir, "hf:score", { texts: ["a"] }, work);
    const second = await cached(dir, "hf:score", { texts: ["a"] }, work);
    expect(first).toEqual([0.25]);
    expect(second).toEqual([0.25]);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("does not persist anything when the work throws", async () => {
    const work = vi.fn().mockRejectedValue(new Error("Azure translate to fr: HTTP 429"));
    await expect(cached(dir, "azure:to-fr", ["a"], work)).rejects.toThrow("HTTP 429");
    // A failed call must stay a miss, or the next run would serve the failure.
    expect(readCache(dir, cacheKey("azure:to-fr", ["a"]))).toBeNull();
  });

  it("distinguishes batches by their exact contents", async () => {
    const work = vi.fn().mockResolvedValue(["x"]);
    await cached(dir, "azure:to-en", ["a"], work);
    await cached(dir, "azure:to-en", ["a", "b"], work);
    expect(work).toHaveBeenCalledTimes(2);
  });
});
