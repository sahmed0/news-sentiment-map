import { describe, it, expect } from "vitest";
import {
  computeWorldSummary,
  summaryHeadline,
  IN_LINE_HEADLINE,
  MIN_COUNTRIES_FOR_SUMMARY,
} from "../../src/lib/summary.js";
import type { ResolvedPoint } from "../../src/lib/worldHistory";

// N identical countries, each holding `series` as its resolved points.
// Every day's mean is that day's value and the baseline is the mean
// of the series.
function fixture(series: number[], countries = MIN_COUNTRIES_FOR_SUMMARY): Record<string, ResolvedPoint[]> {
  const out: Record<string, ResolvedPoint[]> = {};
  for (let c = 0; c < countries; c++) {
    out[`C${c}`] = series.map((score) => ({ score, carried: false }));
  }
  return out;
}

const days = (n: number) =>
  Array.from({ length: n }, (_, i) => `2026-08-${String(i + 1).padStart(2, "0")}`);

describe("summaryHeadline", () => {
  it("bands delta into five plain-English strings at the exact boundaries", () => {
    expect(summaryHeadline(-0.2)).toBe("More negative than usual");
    expect(summaryHeadline(-0.06)).toBe("More negative than usual");
    expect(summaryHeadline(-0.0599)).toBe("Slightly more negative than usual");
    expect(summaryHeadline(-0.02)).toBe("Slightly more negative than usual");
    expect(summaryHeadline(-0.0199)).toBe(IN_LINE_HEADLINE);
    expect(summaryHeadline(0)).toBe(IN_LINE_HEADLINE);
    expect(summaryHeadline(0.0199)).toBe(IN_LINE_HEADLINE);
    expect(summaryHeadline(0.02)).toBe("Slightly more positive than usual");
    expect(summaryHeadline(0.0599)).toBe("Slightly more positive than usual");
    expect(summaryHeadline(0.06)).toBe("More positive than usual");
    expect(summaryHeadline(0.2)).toBe("More positive than usual");
  });
});

describe("computeWorldSummary", () => {
  it("computes the day mean, the mean-of-daily-means baseline and their delta", () => {
    const summary = computeWorldSummary(fixture([0, 0, 0, 0, 0, 0, -0.14]), days(7), 6, true);

    expect(summary).not.toBeNull();
    expect(summary!.score).toBeCloseTo(-0.14, 10);
    expect(summary!.baseline).toBeCloseTo(-0.02, 10);
    expect(summary!.delta).toBeCloseTo(-0.12, 10);
    expect(summary!.countries).toBe(MIN_COUNTRIES_FOR_SUMMARY);
    expect(summary!.headline).toBe("More negative than usual");
  });

  it("weights every day equally regardless of how many countries it scored", () => {
    const resolved = fixture([0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2]);
    // Drop most of day 0's coverage: its mean is unchanged (still 0.2) so the
    // baseline must not move even though day 0 now has far fewer readings.
    for (const code of Object.keys(resolved).slice(2)) resolved[code][0] = { score: null, carried: false };

    const summary = computeWorldSummary(resolved, days(7), 6, true);
    expect(summary!.baseline).toBeCloseTo(0.2, 10);
    expect(summary!.delta).toBeCloseTo(0, 10);
  });

  it("returns null below the country threshold", () => {
    const resolved = fixture([0, 0, 0, 0, 0, 0, -0.14], MIN_COUNTRIES_FOR_SUMMARY - 1);
    expect(computeWorldSummary(resolved, days(7), 6, true)).toBeNull();
  });

  it("returns null below the minimum history length", () => {
    const resolved = fixture([0, 0, 0, 0, 0, 0]);
    expect(computeWorldSummary(resolved, days(6), 5, true)).toBeNull();
  });

  it("writes a live detail line with U+2212, not an ASCII hyphen", () => {
    const summary = computeWorldSummary(fixture([0, 0, 0, 0, 0, 0, -0.14]), days(7), 6, true);
    expect(summary!.detail).toBe("−0.14 today · 0.12 below the 30-day average");
    // U+2212 for the negative symbol, not an ASCII hyphen ("-")
    // ("30-day" keeps its ordinary hyphen).
    expect(summary!.detail).not.toMatch(/-\d/);
    expect(summary!.detail).toContain("−");
  });

  it("names the scrubbed day in the detail line instead of 'today'", () => {
    const summary = computeWorldSummary(fixture([0, 0, 0, 0, 0, 0, -0.14]), days(7), 6, false);
    expect(summary!.detail).toBe("−0.14 on Aug 7 · 0.12 below the 30-day average");
  });

  it("uses 'above' and an explicit + sign when the day is more positive than usual", () => {
    const summary = computeWorldSummary(fixture([0, 0, 0, 0, 0, 0, 0.14]), days(7), 6, true);
    expect(summary!.headline).toBe("More positive than usual");
    expect(summary!.detail).toBe("+0.14 today · 0.12 above the 30-day average");
  });

  it("drops the magnitude clause when the day is in line with the baseline", () => {
    const summary = computeWorldSummary(fixture([-0.05, -0.05, -0.05, -0.05, -0.05, -0.05, -0.05]), days(7), 6, true);
    expect(summary!.headline).toBe(IN_LINE_HEADLINE);
    expect(summary!.detail).toBe("−0.05 today · in line with the 30-day average");
  });
});
