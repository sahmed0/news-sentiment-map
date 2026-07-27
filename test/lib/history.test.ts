import { describe, it, expect } from "vitest";
import { buildPolyline, computeDelta7d } from "../../src/lib/history.js";
import type { HistoryPoint } from "../../shared/types";

const pt = (date: string, score: number): HistoryPoint => ({ date, score, n: 3 });

describe("buildPolyline", () => {
  it("maps index to x and score to an inverted, padded y", () => {
    const points = [pt("2026-07-01", -1), pt("2026-07-02", 0), pt("2026-07-03", 1)];
    // Height 36 with 2 units of padding leaves a 32-unit band: -1 -> 34,
    // 0 -> 18, +1 -> 2. Pinned exactly so a change to the padding or the
    // inversion fails here rather than silently reshaping the chart.
    expect(buildPolyline(points, 100, 36)).toBe("0,34 50,18 100,2");
  });

  it("places a single point at x=0 instead of dividing by zero", () => {
    expect(buildPolyline([pt("2026-07-01", 0.5)], 100, 36)).toBe("0,10");
  });

  it("returns an empty string for an empty series", () => {
    expect(buildPolyline([], 100, 36)).toBe("");
  });
});

describe("computeDelta7d", () => {
  it("uses a point exactly seven days older", () => {
    const delta = computeDelta7d([pt("2026-07-01", 0.1), pt("2026-07-08", 0.4)]);
    expect(delta).toBeCloseTo(0.3, 10);
  });

  it("picks the most recent point that is still at least seven days back", () => {
    const points = [
      pt("2026-07-06", 0.5), // 9 days back - older than needed
      pt("2026-07-07", 0.2), // 8 days back - the one to use
      pt("2026-07-10", 0.9), // 5 days back - too recent
      pt("2026-07-15", 0.6),
    ];
    expect(computeDelta7d(points)).toBeCloseTo(0.4, 10);
  });

  it("returns null when the whole series spans less than seven days", () => {
    const points = [pt("2026-07-10", 0.1), pt("2026-07-12", 0.2), pt("2026-07-15", 0.3)];
    expect(computeDelta7d(points)).toBeNull();
  });

  it("returns null for a single point and for an empty series", () => {
    expect(computeDelta7d([pt("2026-07-15", 0.3)])).toBeNull();
    expect(computeDelta7d([])).toBeNull();
  });
});
