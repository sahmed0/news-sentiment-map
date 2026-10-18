import { describe, it, expect } from "vitest";
import { headlineStats } from "../../shared/stats.js";
import { parseHistoryPoint } from "../../shared/types.js";

describe("headlineStats", () => {
  it("returns null for no scores - no mean is not a mean of zero", () => {
    expect(headlineStats([])).toBeNull();
  });

  it("returns null when every headline failed to score", () => {
    expect(headlineStats([null, undefined, null])).toBeNull();
  });

  it("reports zero spread for a single score rather than NaN", () => {
    expect(headlineStats([0.4])).toEqual({ n: 1, mean: 0.4, sd: 0, se: 0 });
  });

  it("uses the n-1 sample SD", () => {
    // Mean 0.5, squared deviations 0.09 + 0.01 + 0.01 + 0.09 = 0.2, / (4-1)
    // = 0.0667, so sd = 0.2582 and se = 0.2582 / 2 = 0.1291. Worked by hand;
    // dividing by n instead would give 0.2236 and fail here.
    const s = headlineStats([0.2, 0.4, 0.6, 0.8])!;
    expect(s.n).toBe(4);
    expect(s.mean).toBeCloseTo(0.5, 12);
    expect(s.sd).toBeCloseTo(0.258199, 6);
    expect(s.se).toBeCloseTo(0.129099, 6);
  });

  it("skips nulls interleaved with scores instead of counting them as zero", () => {
    const s = headlineStats([null, 0.2, undefined, 0.4, null, 0.6, 0.8])!;
    expect(s).toEqual(headlineStats([0.2, 0.4, 0.6, 0.8]));
  });
});

describe("parseHistoryPoint", () => {
  it("parses the legacy shape with no sd, without inventing one", () => {
    const p = parseHistoryPoint(JSON.stringify({ d: 500, s: 0.1, n: 5 }));
    expect(p).toEqual({ d: 500, s: 0.1, n: 5 });
    expect(p).not.toHaveProperty("sd");
  });

  it("keeps sd when it is stored, from a string or an already-parsed object", () => {
    expect(parseHistoryPoint(JSON.stringify({ d: 500, s: 0.1, n: 5, sd: 0.42 }))).toEqual({ d: 500, s: 0.1, n: 5, sd: 0.42 });
    expect(parseHistoryPoint({ d: 500, s: 0.1, n: 5, sd: 0 })).toEqual({ d: 500, s: 0.1, n: 5, sd: 0 });
  });

  it.each([
    ["null", null],
    ["a string", "0.4"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("drops a point whose sd is present but %s", (_label, sd) => {
    expect(parseHistoryPoint({ d: 500, s: 0.1, n: 5, sd })).toBeNull();
  });

  it("still requires d, s and n to be finite", () => {
    expect(parseHistoryPoint({ d: 500, s: 0.1, sd: 0.2 })).toBeNull();
    expect(parseHistoryPoint("not json")).toBeNull();
  });
});
