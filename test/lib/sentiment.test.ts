import { describe, it, expect } from "vitest";
import {
  sentimentBucket,
  scoreColor,
  legendGradientCss,
  bucketColor,
  bucketsWithinOneSE,
} from "../../src/lib/sentiment.js";

// d3-scale returns interpolated colors as "rgb(r, g, b)" even when the range was
// given as hex, so compare through a canonical form rather than on string shape.
function norm(color: string): string {
  const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(color);
  if (!m) return color.toLowerCase();
  return (
    "#" +
    m
      .slice(1)
      .map((n) => Number(n).toString(16).padStart(2, "0"))
      .join("")
  );
}

describe("sentimentBucket", () => {
  it("buckets clearly positive / negative scores", () => {
    expect(sentimentBucket(0.5)).toBe("positive");
    expect(sentimentBucket(-0.5)).toBe("negative");
    expect(sentimentBucket(1)).toBe("positive");
    expect(sentimentBucket(-1)).toBe("negative");
  });

  it("treats scores within ±0.1 (inclusive) as neutral", () => {
    expect(sentimentBucket(0)).toBe("neutral");
    expect(sentimentBucket(0.1)).toBe("neutral"); // boundary is NOT > 0.1
    expect(sentimentBucket(-0.1)).toBe("neutral"); // boundary is NOT < -0.1
    expect(sentimentBucket(0.05)).toBe("neutral");
  });

  it("returns just past the boundary as positive/negative", () => {
    expect(sentimentBucket(0.1001)).toBe("positive");
    expect(sentimentBucket(-0.1001)).toBe("negative");
  });

  it("returns null for unscored / non-numeric input", () => {
    expect(sentimentBucket(null)).toBeNull();
    expect(sentimentBucket(undefined)).toBeNull();
    expect(sentimentBucket("0.5")).toBeNull();
    expect(sentimentBucket(NaN)).toBe("neutral"); // NaN is a number; documents current behavior
  });
});

describe("scoreColor", () => {
  it("returns the exact ColorBrewer anchors at the domain stops", () => {
    expect(norm(scoreColor(-1))).toBe("#d7191c");
    expect(norm(scoreColor(-0.1))).toBe("#fdae61");
    expect(norm(scoreColor(0))).toBe("#ffffbf");
    expect(norm(scoreColor(0.1))).toBe("#abd9e9");
    expect(norm(scoreColor(1))).toBe("#2c7bb6");
  });

  it("clamps scores outside [-1, 1] to the poles", () => {
    expect(norm(scoreColor(-2))).toBe("#d7191c");
    expect(norm(scoreColor(2))).toBe("#2c7bb6");
  });

  it("interpolates between anchors instead of snapping", () => {
    const mid = norm(scoreColor(0.5));
    expect(mid).not.toBe(norm(scoreColor(0.1)));
    expect(mid).not.toBe(norm(scoreColor(1)));
  });
});

describe("legendGradientCss", () => {
  it("places each anchor at its domain position mapped onto 0-100%", () => {
    expect(legendGradientCss()).toBe(
      "linear-gradient(to right, #d7191c 0%, #fdae61 45%, #ffffbf 50%, #abd9e9 55%, #2c7bb6 100%)"
    );
  });
});

describe("bucketColor", () => {
  it("maps each bucket to its theme token", () => {
    expect(bucketColor(0.5)).toBe("rgb(var(--c-positive-rgb))");
    expect(bucketColor(0)).toBe("rgb(var(--c-neutral-rgb))");
    expect(bucketColor(-0.5)).toBe("rgb(var(--c-negative-rgb))");
  });

  it("returns null for unscored / non-numeric input", () => {
    expect(bucketColor(null)).toBeNull();
    expect(bucketColor(undefined)).toBeNull();
  });
});

describe("bucketsWithinOneSE", () => {
  it("returns only the score's own bucket when there is no spread", () => {
    expect(bucketsWithinOneSE(0.05, 0)).toEqual(["neutral"]);
    expect(bucketsWithinOneSE(-0.5, -0.2)).toEqual(["negative"]);
    expect(bucketsWithinOneSE(0.5, Number.NaN)).toEqual(["positive"]);
  });

  it("treats a score exactly on +/-0.1 as neutral, matching sentimentBucket", () => {
    expect(bucketsWithinOneSE(0.1, 0)).toEqual(["neutral"]);
    expect(bucketsWithinOneSE(-0.1, 0)).toEqual(["neutral"]);
    expect(bucketsWithinOneSE(0.1, 0.05)).toEqual(["neutral", "positive"]);
    expect(bucketsWithinOneSE(-0.1, 0.05)).toEqual(["negative", "neutral"]);
  });

  it("spans two buckets when the interval crosses one boundary, in either direction", () => {
    expect(bucketsWithinOneSE(-0.2, 0.15)).toEqual(["negative", "neutral"]);
    expect(bucketsWithinOneSE(0.2, 0.15)).toEqual(["neutral", "positive"]);
  });

  it("stays in one bucket when the interval sits comfortably inside it", () => {
    expect(bucketsWithinOneSE(0.8, 0.05)).toEqual(["positive"]);
    expect(bucketsWithinOneSE(0, 0.05)).toEqual(["neutral"]);
  });

  it("includes neutral when a non-neutral score's interval runs from negative to positive", () => {
    expect(bucketsWithinOneSE(-0.15, 0.3)).toEqual(["negative", "neutral", "positive"]);
  });
});
