// Pure map-geometry helpers, kept out of the component so they can be unit
// tested without React or a DOM.
import type { GeoPath } from "d3-geo";
import isoCountries from "i18n-iso-countries";
import en from "i18n-iso-countries/langs/en.json";
import type { Feature, Polygon } from "geojson";

// Side effect on import: without a registered locale every
// `isoCountries.getName(alpha2, "en")` returns undefined. Anything that renders
// country names must reach the library through this module (or import it first).
isoCountries.registerLocale(en);

// Derive ISO numeric → alpha-2 from i18n-iso-countries. The library expects the
// numeric code without leading zeros (e.g. "76" → "BR"), so strip padding.
export const numericToAlpha2 = (numId: string): string | undefined =>
  isoCountries.numericToAlpha2(String(parseInt(numId, 10)));

// For MultiPolygon countries (France, USA, Russia, etc.) the full-feature
// centroid is pulled toward distant overseas territories. Use the largest
// sub-polygon's centroid instead so the label lands on the main landmass.
export function dominantCentroid(pathGen: GeoPath, feature: Feature): [number, number] {
  const { geometry } = feature;
  if (geometry?.type !== "MultiPolygon") return pathGen.centroid(feature);
  let best: Feature<Polygon> | null = null;
  let bestArea = -Infinity;
  for (const coords of geometry.coordinates) {
    const poly: Feature<Polygon> = {
      type: "Feature",
      properties: null,
      geometry: { type: "Polygon", coordinates: coords },
    };
    const area = pathGen.area(poly);
    if (area > bestArea) { bestArea = area; best = poly; }
  }
  return best ? pathGen.centroid(best) : pathGen.centroid(feature);
}

// Alpha-2 → flag emoji, built from the two Unicode regional indicator symbols
// rather than a lookup table (there are only 26, so it's cheaper than an
// asset). Falls back to "" for anything that isn't a two-letter code, which
// callers should render as the plain country name with no leading flag.
export function flagEmoji(alpha2: string | undefined | null): string {
  if (!alpha2 || alpha2.length !== 2) return "";
  const codePoints = [...alpha2.toUpperCase()].map((c) => 127397 + c.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}
