import { describe, it, expect } from "vitest";
import {
  patchWorldHistory,
  buildWorldHistory,
  refreshWorldHistory,
  bucketToDate,
  HISTORY_KEY,
  WORLD_HISTORY_KEY,
  WORLD_HISTORY_WINDOW_DAYS,
} from "../../api/_lib/refresh-core.js";
import { parseWorldHistory } from "../../shared/types.js";
import { createFakeRedis } from "../helpers/fakeRedis.js";
import type { WorldHistory } from "../../shared/types.js";

// A fixed day bucket. bucketToDate(20000) is 2024-10-04 (see history-handler
// test); everything here is asserted against bucketToDate so a change to the
// NewsData offset fails loudly rather than silently shifting a column.
const DAY = 20000;
const point = (d: number, s: number, n: number) => JSON.stringify({ d, s, n });
const NOON = new Date("2024-06-01T12:00:00Z"); // not the rebuild hour
const REBUILD = new Date("2024-06-01T04:30:00Z"); // WORLD_HISTORY_REBUILD_HOUR

describe("patchWorldHistory", () => {
  it("builds a full window from scratch when prev is null", () => {
    const wh = patchWorldHistory(null, DAY, [
      { code: "us", score: 0.5 },
      { code: "gb", score: -0.25 },
    ]);
    expect(wh.days).toHaveLength(WORLD_HISTORY_WINDOW_DAYS);
    expect(wh.days[29]).toBe(bucketToDate(DAY));
    expect(wh.days[0]).toBe(bucketToDate(DAY - 29));
    expect(Object.keys(wh.scores).sort()).toEqual(["gb", "us"]);
    expect(wh.scores.us).toHaveLength(WORLD_HISTORY_WINDOW_DAYS);
    expect(wh.scores.us[29]).toBe(0.5);
    expect(wh.scores.us.slice(0, 29).every((v) => v === null)).toBe(true);
    expect(wh.scores.gb[29]).toBe(-0.25);
  });

  it("rounds written scores to 3 dp so a patch matches a rebuild byte-for-byte", () => {
    const wh = patchWorldHistory(null, DAY, [{ code: "us", score: 0.123456 }]);
    expect(wh.scores.us[29]).toBe(0.123);
  });

  it("realigns prior values by date when the window advances one day", () => {
    const p0 = patchWorldHistory(null, DAY, [{ code: "us", score: 0.1 }]);
    const p1 = patchWorldHistory(p0, DAY + 1, [{ code: "us", score: 0.2 }]);

    expect(p1.days[29]).toBe(bucketToDate(DAY + 1));
    expect(p1.days[28]).toBe(bucketToDate(DAY));
    expect(p1.days[0]).toBe(bucketToDate(DAY - 28)); // oldest day dropped
    expect(p1.scores.us[28]).toBe(0.1); // yesterday's value followed its date
    expect(p1.scores.us[29]).toBe(0.2);
  });

  it("aligns by date, not by index, when a tick was skipped (window jumps 5 days)", () => {
    const p0 = patchWorldHistory(null, DAY, [{ code: "us", score: 0.1 }]);
    const p5 = patchWorldHistory(p0, DAY + 5, [{ code: "us", score: 0.5 }]);

    expect(p5.days[29]).toBe(bucketToDate(DAY + 5));
    expect(p5.days[24]).toBe(bucketToDate(DAY));
    expect(p5.scores.us[24]).toBe(0.1); // date(DAY) landed at index 24, not 28
    expect(p5.scores.us[29]).toBe(0.5);
    expect(p5.scores.us.filter((v) => v !== null)).toEqual([0.1, 0.5]);
  });

  it("adds a country absent from prev with a full-length array", () => {
    const p0 = patchWorldHistory(null, DAY, [{ code: "us", score: 0.1 }]);
    const p1 = patchWorldHistory(p0, DAY + 1, [{ code: "gb", score: 0.9 }]);
    expect(p1.scores.gb).toHaveLength(WORLD_HISTORY_WINDOW_DAYS);
    expect(p1.scores.gb[29]).toBe(0.9);
    expect(p1.scores.gb.slice(0, 29).every((v) => v === null)).toBe(true);
  });

  it("keeps a country absent from points, realigning its prior values", () => {
    const p0 = patchWorldHistory(null, DAY, [{ code: "us", score: 0.1 }]);
    const p1 = patchWorldHistory(p0, DAY + 1, [{ code: "gb", score: 0.9 }]);
    expect(p1.scores.us[28]).toBe(0.1); // realigned
    expect(p1.scores.us[29]).toBeNull(); // no us point this tick
  });

  it("nulls a value that has fallen out of the window (kept until a rebuild prunes)", () => {
    const p0 = patchWorldHistory(null, DAY, [{ code: "us", score: 0.1 }]);
    const far = patchWorldHistory(p0, DAY + 40, []);
    expect(far.scores.us).toHaveLength(WORLD_HISTORY_WINDOW_DAYS);
    expect(far.scores.us.every((v) => v === null)).toBe(true);
  });

  it("never mutates prev", () => {
    const p0 = patchWorldHistory(null, DAY, [{ code: "us", score: 0.1 }]);
    const snapshot = JSON.parse(JSON.stringify(p0));
    patchWorldHistory(p0, DAY + 3, [{ code: "us", score: 0.9 }]);
    expect(p0).toEqual(snapshot);
  });
});

describe("buildWorldHistory", () => {
  it("places each country's points at their date index, gaps as null", async () => {
    const redis = createFakeRedis({
      zsets: {
        [HISTORY_KEY("us")]: { [point(DAY, 0.2, 3)]: DAY, [point(DAY - 1, 0.4, 2)]: DAY - 1 },
        [HISTORY_KEY("gb")]: { [point(DAY, -0.5, 1)]: DAY, [point(DAY - 3, -0.1, 4)]: DAY - 3 },
      },
    });
    const wh = await buildWorldHistory(redis, DAY);

    expect(wh.days).toHaveLength(WORLD_HISTORY_WINDOW_DAYS);
    expect(wh.scores.us[29]).toBe(0.2);
    expect(wh.scores.us[28]).toBe(0.4);
    expect(wh.scores.us[27]).toBeNull();
    expect(wh.scores.gb[29]).toBe(-0.5);
    expect(wh.scores.gb[26]).toBe(-0.1); // DAY-3 -> index 26
    expect(wh.scores.gb[28]).toBeNull();
    expect(wh.scores.gb[27]).toBeNull();
  });

  it("omits countries with no in-window points entirely", async () => {
    const redis = createFakeRedis({
      zsets: { [HISTORY_KEY("us")]: { [point(DAY, 0.2, 1)]: DAY } },
    });
    const wh = await buildWorldHistory(redis, DAY);
    expect(wh.scores.us).toBeDefined();
    expect(wh.scores.gb).toBeUndefined();
  });

  it("drops points older than the window even if zrange returns them", async () => {
    const redis = createFakeRedis({
      zsets: {
        [HISTORY_KEY("us")]: {
          [point(DAY - 40, 0.9, 1)]: DAY - 40,
          [point(DAY, 0.2, 1)]: DAY,
        },
      },
    });
    const wh = await buildWorldHistory(redis, DAY);
    expect(wh.scores.us.filter((v) => v !== null)).toEqual([0.2]);
  });

  it("rounds rebuilt scores to 3 dp", async () => {
    const redis = createFakeRedis({
      zsets: { [HISTORY_KEY("us")]: { [point(DAY, 0.123456, 1)]: DAY } },
    });
    const wh = await buildWorldHistory(redis, DAY);
    expect(wh.scores.us[29]).toBe(0.123);
  });
});

describe("refreshWorldHistory", () => {
  it("rebuilds (ignoring points) when the key is absent, and writes it", async () => {
    const redis = createFakeRedis({
      zsets: { [HISTORY_KEY("us")]: { [point(DAY, 0.2, 1)]: DAY } },
    });
    const outcome = await refreshWorldHistory(redis, [{ code: "us", score: 0.9 }], DAY, NOON);
    expect(outcome).toBe("rebuilt");
    const stored = redis._store.get(WORLD_HISTORY_KEY) as WorldHistory;
    expect(stored.scores.us[29]).toBe(0.2); // from the ZSET, not the 0.9 point
  });

  it("rebuilds at the daily rebuild hour even when a valid key exists", async () => {
    const existing = patchWorldHistory(null, DAY, [{ code: "us", score: 0.1 }]);
    const redis = createFakeRedis({
      store: { [WORLD_HISTORY_KEY]: existing },
      zsets: { [HISTORY_KEY("us")]: { [point(DAY, 0.44, 1)]: DAY } },
    });
    const outcome = await refreshWorldHistory(redis, [], DAY, REBUILD);
    expect(outcome).toBe("rebuilt");
    expect((redis._store.get(WORLD_HISTORY_KEY) as WorldHistory).scores.us[29]).toBe(0.44);
  });

  it("rebuilds when the stored key is unparseable", async () => {
    const redis = createFakeRedis({
      store: { [WORLD_HISTORY_KEY]: { days: "not an array" } },
      zsets: { [HISTORY_KEY("us")]: { [point(DAY, 0.2, 1)]: DAY } },
    });
    expect(await refreshWorldHistory(redis, [], DAY, NOON)).toBe("rebuilt");
  });

  it("patches from the stored key outside the rebuild hour", async () => {
    const existing = patchWorldHistory(null, DAY, [{ code: "us", score: 0.1 }]);
    const redis = createFakeRedis({ store: { [WORLD_HISTORY_KEY]: existing } });
    const outcome = await refreshWorldHistory(redis, [{ code: "us", score: 0.7 }], DAY + 1, NOON);
    expect(outcome).toBe("patched");
    const stored = redis._store.get(WORLD_HISTORY_KEY) as WorldHistory;
    expect(stored.days[29]).toBe(bucketToDate(DAY + 1));
    expect(stored.scores.us[28]).toBe(0.1); // realigned
    expect(stored.scores.us[29]).toBe(0.7); // this tick's point
  });
});

describe("parseWorldHistory", () => {
  const valid: WorldHistory = { days: ["2024-10-01", "2024-10-02"], scores: { us: [0.1, null], gb: [null, -0.3] } };

  it("accepts a well-formed object and a JSON string of one", () => {
    expect(parseWorldHistory(valid)).toEqual(valid);
    expect(parseWorldHistory(JSON.stringify(valid))).toEqual(valid);
  });

  it("reads malformed input as absent (null)", () => {
    expect(parseWorldHistory(null)).toBeNull();
    expect(parseWorldHistory("{ not json")).toBeNull();
    expect(parseWorldHistory({ days: "nope", scores: {} })).toBeNull();
    expect(parseWorldHistory({ days: [1, 2], scores: {} })).toBeNull();
    expect(parseWorldHistory({ days: ["a", "b"], scores: { us: [0.1] } })).toBeNull(); // length mismatch
    expect(parseWorldHistory({ days: ["a", "b"], scores: { us: [0.1, "x"] } })).toBeNull(); // non-number
  });
});
