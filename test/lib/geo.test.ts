import { describe, it, expect } from "vitest";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import type { Feature, Polygon, MultiPolygon } from "geojson";
import { numericToAlpha2, dominantCentroid } from "../../src/lib/geo.js";

// The real projection the map uses - these helpers are only meaningful in
// projected space, so a synthetic identity projection would prove nothing.
const pathGen = geoPath(geoNaturalEarth1());

// Sized so the first polygon dominates by ~100x, and placed far apart so a
// whole-feature centroid is visibly wrong.
const BIG_RING = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]];
const SMALL_RING = [[60, 40], [60, 41], [61, 41], [61, 40], [60, 40]];

function polygon(ring: number[][]): Feature<Polygon> {
  return { type: "Feature", properties: null, geometry: { type: "Polygon", coordinates: [ring] } };
}

describe("dominantCentroid", () => {
  it("returns the plain centroid for a Polygon", () => {
    const f = polygon(BIG_RING);
    expect(dominantCentroid(pathGen, f)).toEqual(pathGen.centroid(f));
  });

  it("picks the largest sub-polygon of a MultiPolygon, ignoring outlying scraps", () => {
    const multi: Feature<MultiPolygon> = {
      type: "Feature",
      properties: null,
      geometry: { type: "MultiPolygon", coordinates: [[BIG_RING], [SMALL_RING]] },
    };

    // Expected: the mainland's own centroid, not the whole feature's - which the
    // distant scrap drags away (this is the bug the helper exists to avoid).
    const [x, y] = dominantCentroid(pathGen, multi);
    const [bigX, bigY] = pathGen.centroid(polygon(BIG_RING));
    expect(x).toBeCloseTo(bigX, 6);
    expect(y).toBeCloseTo(bigY, 6);
    expect(x).not.toBeCloseTo(pathGen.centroid(multi)[0], 3);
  });

  it("is order-independent - the largest wins whichever comes first", () => {
    const reversed: Feature<MultiPolygon> = {
      type: "Feature",
      properties: null,
      geometry: { type: "MultiPolygon", coordinates: [[SMALL_RING], [BIG_RING]] },
    };
    const [x, y] = dominantCentroid(pathGen, reversed);
    const [bigX, bigY] = pathGen.centroid(polygon(BIG_RING));
    expect(x).toBeCloseTo(bigX, 6);
    expect(y).toBeCloseTo(bigY, 6);
  });
});

describe("numericToAlpha2", () => {
  it("resolves zero-padded ISO numeric codes from the topojson", () => {
    expect(numericToAlpha2("076")).toBe("BR");
    expect(numericToAlpha2("840")).toBe("US");
  });

  it("returns undefined for codes with no country", () => {
    expect(numericToAlpha2("999")).toBeUndefined();
  });
});
