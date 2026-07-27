// The fake's zset trimming is what the history cap and the same-day overwrite
// rely on, and its list ops are what the tick log's newest-first ordering and cap
// rely on, so its Redis fidelity is worth asserting directly - a bug here would
// silently weaken every test that trusts it.
import { describe, it, expect } from "vitest";
import { createFakeRedis } from "./fakeRedis.js";

const seed = (scores: number[]) =>
  createFakeRedis({
    zsets: { k: Object.fromEntries(scores.map((s) => [`m${s}`, s])) },
  });
const members = (redis: ReturnType<typeof createFakeRedis>) =>
  [...(redis._zsets.get("k") ?? new Map<string, number>()).entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([m]) => m);

describe("fakeRedis zremrangebyscore", () => {
  it("removes an inclusive score range and returns the count", async () => {
    const redis = seed([1, 2, 3, 4]);
    expect(await redis.zremrangebyscore("k", 2, 3)).toBe(2);
    expect(members(redis)).toEqual(["m1", "m4"]); // both bounds removed
  });

  it("removes every member sharing one score (the same-day overwrite case)", async () => {
    const redis = createFakeRedis({ zsets: { k: { a: 7, b: 7, c: 8 } } });
    expect(await redis.zremrangebyscore("k", 7, 7)).toBe(2);
    expect(members(redis)).toEqual(["c"]);
  });

  it("is a no-op on a missing key or an empty range", async () => {
    expect(await createFakeRedis().zremrangebyscore("k", 0, 100)).toBe(0);
    const redis = seed([1, 2]);
    expect(await redis.zremrangebyscore("k", 10, 20)).toBe(0);
    expect(members(redis)).toEqual(["m1", "m2"]);
  });
});

describe("fakeRedis zremrangebyrank", () => {
  it("keeps the last N when trimming with a negative stop", async () => {
    const redis = seed([1, 2, 3, 4, 5]);
    expect(await redis.zremrangebyrank("k", 0, -(3 + 1))).toBe(2); // keep 3
    expect(members(redis)).toEqual(["m3", "m4", "m5"]);
  });

  it("keeps everything when the set is shorter than the cap", async () => {
    const redis = seed([1, 2]);
    expect(await redis.zremrangebyrank("k", 0, -(5 + 1))).toBe(0);
    expect(members(redis)).toEqual(["m1", "m2"]);
  });

  it("removes the full range and the whole set", async () => {
    const redis = seed([1, 2, 3]);
    expect(await redis.zremrangebyrank("k", 0, -1)).toBe(3);
    expect(members(redis)).toEqual([]);
  });

  it("ranks by score, not insertion order", async () => {
    const redis = createFakeRedis({ zsets: { k: { late: 9, early: 1, mid: 5 } } });
    expect(await redis.zremrangebyrank("k", 0, 0)).toBe(1);
    expect(members(redis)).toEqual(["mid", "late"]); // lowest score dropped
  });

  it("is a no-op on a missing key", async () => {
    expect(await createFakeRedis().zremrangebyrank("k", 0, -1)).toBe(0);
  });
});
