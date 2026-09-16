import { describe, it, expect } from "vitest";
import {
  normalise,
  COUNTRY_ALIASES,
  buildSearchIndex,
  searchCountries,
} from "../../src/lib/search.js";
import type { CountryResult } from "../../shared/types";

const mk = (code: string, name: string, score: number | null = 0.1): CountryResult => ({
  code,
  name,
  score,
  status: "ok",
  articles: [],
  fetchedAt: "2026-01-01T00:00:00.000Z",
});

// This test's 'covered' set; every other ISO country is present in the index but
// flagged hasData:false. Names mirror COUNTRIES table.
// Both Koreas are covered, so a "korea" query can't
// lean on the covered-before-uncovered tiebreak to separate them.
const BY_CODE: Record<string, CountryResult> = {
  US: mk("us", "United States"),
  GB: mk("gb", "United Kingdom"),
  IN: mk("in", "India"),
  FR: mk("fr", "France"),
  CD: mk("cd", "DR Congo"),
  TR: mk("tr", "Turkey"),
  KR: mk("kr", "South Korea"),
  KP: mk("kp", "North Korea"),
};

const index = buildSearchIndex(BY_CODE);
const top = (q: string) => searchCountries(q, index)[0];
const codes = (q: string, limit?: number) =>
  searchCountries(q, index, limit).map((r) => r.code);

describe("normalise", () => {
  it("folds case, diacritics and punctuation to a bare alnum key", () => {
    expect(normalise("Côte d'Ivoire")).toBe("cotedivoire");
    expect(normalise("Türkiye")).toBe("turkiye");
    expect(normalise("  United   States!  ")).toBe("unitedstates");
    expect(normalise("São Tomé & Príncipe")).toBe("saotomeprincipe");
  });
});

describe("buildSearchIndex", () => {
  it("covers every ISO country, flagging the ones with data", () => {
    expect(index.length).toBeGreaterThan(200);

    const us = index.find((r) => r.code === "us")!;
    expect(us).toMatchObject({ code: "us", name: "United States", hasData: true });

    const fj = index.find((r) => r.code === "fj")!;
    expect(fj).toMatchObject({ code: "fj", name: "Fiji", hasData: false });
  });

  it("treats a covered country with no numeric score as uncovered", () => {
    const idx = buildSearchIndex({ US: mk("us", "United States", null) });
    expect(idx.find((r) => r.code === "us")!.hasData).toBe(false);
  });
});

describe("searchCountries ranking", () => {
  it("returns nothing for an empty or whitespace query", () => {
    expect(searchCountries("", index)).toEqual([]);
    expect(searchCountries("   ", index)).toEqual([]);
  });

  it("resolves common aliases to the right country", () => {
    expect(top("usa").code).toBe("us");
    expect(top("uk").code).toBe("gb");
    expect(top("drc")).toMatchObject({ code: "cd", name: "DR Congo" });
    expect(top("ivory coast").code).toBe("ci");
  });

  it("finds Türkiye by both the alias and the canonical spelling", () => {
    expect(top("turkey").code).toBe("tr");
    expect(top("turkiye").code).toBe("tr");
  });

  it("leaves a substring shared by two countries to the alphabetical tiebreak", () => {
    // "korea" is a substring of both Korean names, and
    // the alphabetical tiebreak decides: North before South.
    const result = codes("korea");
    expect(result).toEqual(expect.arrayContaining(["kp", "kr"]));
    expect(result.indexOf("kp")).toBeLessThan(result.indexOf("kr"));
  });

  it("matches a 2-char query as an ISO code, but not a 3-char one", () => {
    expect(top("fr").code).toBe("fr");
    expect(top("us").code).toBe("us"); // beats the "us" inside "russia" etc.
    // "fra" is not a code; it only reaches France through the weaker prefix tier.
    expect(top("xq")).toBeUndefined();
  });

  it("matches an interior substring of the ISO name", () => {
    expect(codes("states")).toContain("us");
  });

  it("orders exact over prefix over substring, and covered over not", () => {
    // "india" is an exact hit for IN and only a substring of
    // "British Indian Ocean Territory".
    expect(top("india").code).toBe("in");

    // "united" is a prefix of both covered UK and US (alphabetical), and only
    // then the uncovered "United Arab Emirates" / "United States Minor
    // Outlying Islands" (uncovered means not in this test's BY_CODE fixture).
    expect(codes("united").slice(0, 2)).toEqual(["gb", "us"]);
  });

  it("keeps a covered country's table name while still matching its ISO name", () => {
    const r = top("democratic republic of the congo");
    expect(r).toMatchObject({ code: "cd", name: "DR Congo", hasData: true });
  });

  it("returns uncovered countries too, flagged", () => {
    expect(top("fiji")).toMatchObject({ code: "fj", name: "Fiji", hasData: false });
  });

  it("respects the result limit", () => {
    expect(searchCountries("a", index).length).toBeLessThanOrEqual(8);
    expect(searchCountries("a", index, 3).length).toBeLessThanOrEqual(3);
  });
});

describe("COUNTRY_ALIASES", () => {
  it("maps normalised keys to lowercase alpha-2 codes", () => {
    for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) {
      expect(alias).toBe(normalise(alias));
      expect(code).toMatch(/^[a-z]{2}$/);
    }
  });

  it("does not include spellings already contained in the canonical name", () => {
    for (const dropped of ["emirates", "syria", "moldova", "venezuela", "turkiye"]) {
      expect(COUNTRY_ALIASES[dropped]).toBeUndefined();
    }
  });

  it("does not single out Korea for a favoured ranking", () => {
    // "korea" is reachable by substring for both Koreas,
    // neither has an alias, so rank on equal terms.
    expect(COUNTRY_ALIASES.korea).toBeUndefined();
  });
});
