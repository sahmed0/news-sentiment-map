import { describe, it, expect } from "vitest";
import { deriveRankings } from "../../src/lib/rankings.js";
import type { CountryResult } from "../../shared/types";

const country = (
  code: string,
  score: number | null,
  fetchedAt = "2026-07-20T00:00:00.000Z"
): CountryResult => ({
  code,
  name: code.toUpperCase(),
  score,
  status: "ok",
  articles: [],
  fetchedAt,
});

describe("deriveRankings leaderboards", () => {
  it("excludes unscored countries from every list", () => {
    const { scored, top3, bottom3 } = deriveRankings([
      country("us", 0.5),
      country("fr", null),
      country("de", -0.5),
    ]);

    expect(scored.map((c) => c.code)).toEqual(["us", "de"]);
    expect(top3.map((c) => c.code)).toEqual(["us", "de"]);
    expect(bottom3.map((c) => c.code)).toEqual(["de", "us"]);
  });

  it("ranks most positive first and most negative first", () => {
    const { top3, bottom3 } = deriveRankings([
      country("a", -0.9),
      country("b", 0.7),
      country("c", 0.1),
      country("d", 0.9),
      country("e", -0.4),
      country("f", 0.3),
    ]);

    expect(top3.map((c) => c.code)).toEqual(["d", "b", "f"]);
    // bottom3 is reversed, so the worst score leads the list.
    expect(bottom3.map((c) => c.code)).toEqual(["a", "e", "c"]);
  });

  it("keeps tied countries in input order", () => {
    const { top3 } = deriveRankings([
      country("a", 0.4),
      country("b", 0.4),
      country("c", 0.4),
      country("d", -1),
    ]);

    expect(top3.map((c) => c.code)).toEqual(["a", "b", "c"]);
  });

  it("returns short lists rather than padding when fewer than three are scored", () => {
    const { top3, bottom3 } = deriveRankings([country("us", 0.2), country("fr", null)]);

    expect(top3).toHaveLength(1);
    // With fewer than six scored countries the two lists overlap by design -
    // the same country can be both the most and the least positive.
    expect(bottom3.map((c) => c.code)).toEqual(["us"]);
  });

  it("returns empty lists when nothing is scored", () => {
    const { scored, top3, bottom3 } = deriveRankings([country("us", null)]);

    expect(scored).toEqual([]);
    expect(top3).toEqual([]);
    expect(bottom3).toEqual([]);
  });

  it("does not mutate the input array's order", () => {
    const data = [country("a", -1), country("b", 1)];
    deriveRankings(data);

    expect(data.map((c) => c.code)).toEqual(["a", "b"]);
  });
});

describe("deriveRankings freshness", () => {
  it("picks the most recent fetchedAt", () => {
    const { newestFetchedAt } = deriveRankings([
      country("a", 0.1, "2026-07-19T08:00:00.000Z"),
      country("b", 0.2, "2026-07-21T17:30:00.000Z"),
      country("c", 0.3, "2026-07-20T23:59:00.000Z"),
    ]);

    expect(newestFetchedAt?.toISOString()).toBe("2026-07-21T17:30:00.000Z");
  });

  it("ignores countries with a missing or empty fetchedAt", () => {
    const { newestFetchedAt } = deriveRankings([
      country("a", 0.1, ""),
      country("b", 0.2, "2026-07-18T00:00:00.000Z"),
    ]);

    expect(newestFetchedAt?.toISOString()).toBe("2026-07-18T00:00:00.000Z");
  });

  it("is null when no country carries a timestamp", () => {
    expect(deriveRankings([]).newestFetchedAt).toBeNull();
    expect(deriveRankings([country("a", 0.1, "")]).newestFetchedAt).toBeNull();
  });
});
