import { describe, it, expect } from "vitest";
import { sentimentBucket } from "../../src/lib/sentiment.js";

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
