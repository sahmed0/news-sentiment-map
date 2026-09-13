// Country search: normalisation, alias table, and deterministic
// ranking.
import { allCountryNames } from "./geo";
import type { CountryResult } from "../../shared/types";

export interface SearchResult {
  code: string; // lowercase alpha-2
  name: string; // the name shown in the results row
  hasData: boolean;
}

// Fold a string to a comparable form: NFD-decompose, strip combining marks,
// lowercase, then drop everything that isn't a letter or digit.
export function normalise(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}


// Normalised alias -> lowercase alpha-2. Every key is a term that normalised
// substring matching would otherwise miss entirely; terms already contained in
// the canonical ISO name are deliberately left out because substring already
// finds them.
export const COUNTRY_ALIASES: Record<string, string> = {
  usa: "us",
  uk: "gb",
  britain: "gb",
  greatbritain: "gb",
  england: "gb",
  scotland: "gb",
  wales: "gb",
  northernireland: "gb",
  uae: "ae",
  drc: "cd",
  drcongo: "cd",
  congobrazzaville: "cg",
  holland: "nl",
  burma: "mm",
  turkey: "tr",
  russia: "ru",
  ivorycoast: "ci",
  czechia: "cz",
  swaziland: "sz",
  caboverde: "cv",
  easttimor: "tl",
  laos: "la",
};

// getNames() rebuilds its object on every call; the map never changes within a
// session, so fold it once.
let isoNamesCache: Record<string, string> | null = null;
const isoNames = (): Record<string, string> => (isoNamesCache ??= allCountryNames());

// Built from all ISO countries, not just the covered ones - an uncovered
// country stays in the list so it can be shown greyed rather than silently
// missing.
export function buildSearchIndex(byCode: Record<string, CountryResult>): SearchResult[] {
  return Object.entries(isoNames()).map(([upper, isoName]) => {
    const covered = typeof byCode[upper]?.score === "number";
    return {
      code: upper.toLowerCase(),
      name: covered ? byCode[upper].name : isoName,
      hasData: covered,
    };
  });
}

// The names to match a query against for one entry: the displayed name plus the
// canonical ISO name when it differs, both normalised. Matching either spelling
// finds the country regardless of which one the row shows.
function matchTerms(r: SearchResult): string[] {
  const terms = [normalise(r.name)];
  const iso = isoNames()[r.code.toUpperCase()];
  if (iso) {
    const n = normalise(iso);
    if (!terms.includes(n)) terms.push(n);
  }
  return terms;
}

// Lower tier = stronger match. 0 means "no match".
const TIER_NONE = 0;
const TIER_EXACT = 1;
const TIER_ALIAS = 2;
const TIER_CODE = 3;
const TIER_PREFIX = 4;
const TIER_SUBSTRING = 5;

function tierFor(q: string, r: SearchResult): number {
  const terms = matchTerms(r);
  if (terms.some((t) => t === q)) return TIER_EXACT;
  if (COUNTRY_ALIASES[q] === r.code) return TIER_ALIAS;
  // An ISO code match only makes sense for a 2-char query.
  if (q.length === 2 && q === r.code) return TIER_CODE;
  if (terms.some((t) => t.startsWith(q))) return TIER_PREFIX;
  if (terms.some((t) => t.includes(q))) return TIER_SUBSTRING;
  return TIER_NONE;
}

// Rank matches for `query`: by tier, then covered countries before uncovered,
// then alphabetically.
export function searchCountries(
  query: string,
  index: readonly SearchResult[],
  limit = 8,
): SearchResult[] {
  const q = normalise(query);
  if (!q) return [];

  const matched: { r: SearchResult; tier: number }[] = [];
  for (const r of index) {
    const tier = tierFor(q, r);
    if (tier !== TIER_NONE) matched.push({ r, tier });
  }

  matched.sort(
    (a, b) =>
      a.tier - b.tier ||
      Number(b.r.hasData) - Number(a.r.hasData) ||
      a.r.name.localeCompare(b.r.name),
  );

  return matched.slice(0, limit).map((m) => m.r);
}
