import { describe, it, expect } from "vitest";
import {
  resolveSeries,
  resolveWorldHistory,
  scoresForDay,
  CARRY_FORWARD_MAX_DAYS,
} from "../../src/lib/worldHistory.js";
import type { WorldHistory } from "../../shared/types";

describe("resolveSeries", () => {
  it("passes a gapless series straight through, nothing carried", () => {
    const out = resolveSeries([0.1, -0.2, 0.3]);
    expect(out).toEqual([
      { score: 0.1, carried: false },
      { score: -0.2, carried: false },
      { score: 0.3, carried: false },
    ]);
  });

  it("fills a one-day gap from the last measured value and marks it carried", () => {
    const out = resolveSeries([0.4, null, 0.6]);
    expect(out[1]).toEqual({ score: 0.4, carried: true });
    expect(out[2]).toEqual({ score: 0.6, carried: false });
  });

  it("stops carrying after CARRY_FORWARD_MAX_DAYS consecutive gaps", () => {
    // day 0 measured, then 4 gaps: the first 3 carry, the 4th goes unscored.
    const out = resolveSeries([0.5, null, null, null, null]);
    expect(out.map((p) => p.score)).toEqual([0.5, 0.5, 0.5, 0.5, null]);
    expect(out.map((p) => p.carried)).toEqual([false, true, true, true, false]);
    expect(CARRY_FORWARD_MAX_DAYS).toBe(3);
  });

  it("re-measuring resets the carry window", () => {
    const out = resolveSeries([0.2, null, null, null, null, 0.9, null]);
    expect(out.map((p) => p.score)).toEqual([0.2, 0.2, 0.2, 0.2, null, 0.9, 0.9]);
    expect(out[6]).toEqual({ score: 0.9, carried: true });
  });

  it("leaves leading gaps null - there is nothing to carry from", () => {
    const out = resolveSeries([null, null, 0.3]);
    expect(out).toEqual([
      { score: null, carried: false },
      { score: null, carried: false },
      { score: 0.3, carried: false },
    ]);
  });

  it("carries across a trailing gap", () => {
    const out = resolveSeries([0.1, 0.2, null]);
    expect(out[2]).toEqual({ score: 0.2, carried: true });
  });

  it("honours a custom maxCarryDays", () => {
    expect(resolveSeries([0.5, null, null], 1).map((p) => p.score)).toEqual([0.5, 0.5, null]);
  });
});

describe("resolveWorldHistory", () => {
  const history: WorldHistory = {
    days: ["2026-08-01", "2026-08-02", "2026-08-03"],
    scores: { fr: [0.1, null, 0.2], us: [null, -0.3, null] },
  };

  it("uppercases every country key (the map indexes by uppercase alpha-2)", () => {
    const out = resolveWorldHistory(history);
    expect(Object.keys(out).sort()).toEqual(["FR", "US"]);
  });

  it("resolves each country's series independently", () => {
    const out = resolveWorldHistory(history);
    expect(out.FR.map((p) => p.score)).toEqual([0.1, 0.1, 0.2]);
    expect(out.FR[1].carried).toBe(true);
    expect(out.US.map((p) => p.score)).toEqual([null, -0.3, -0.3]);
  });
});

describe("scoresForDay", () => {
  const resolved = resolveWorldHistory({
    days: ["2026-08-01", "2026-08-02"],
    scores: { fr: [0.1, 0.2], us: [null, -0.3] },
  });

  it("returns one score per country for the given index", () => {
    expect(scoresForDay(resolved, 0)).toEqual({ FR: 0.1, US: null });
    expect(scoresForDay(resolved, 1)).toEqual({ FR: 0.2, US: -0.3 });
  });

  it("returns a null for every country on an out-of-range index", () => {
    expect(scoresForDay(resolved, 9)).toEqual({ FR: null, US: null });
    expect(scoresForDay(resolved, -1)).toEqual({ FR: null, US: null });
  });
});
