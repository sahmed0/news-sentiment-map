// Legend's derived data (leaderboards + data freshness), kept out of the
// component so the ordering and the null handling are testable without a DOM.
import type { CountryResult } from "../../shared/types";

// A country that actually carries a score - the type predicate below narrows to
// this, which lets the sort and .toFixed at the call sites stay clean.
export type ScoredCountry = CountryResult & { score: number };

export interface Rankings {
  scored: ScoredCountry[];
  top3: ScoredCountry[];
  bottom3: ScoredCountry[];
  newestFetchedAt: Date | null;
}

export function deriveRankings(data: CountryResult[]): Rankings {
  // Type predicate so the scored subset carries a non-null score - lets the sort
  // and .toFixed below stay clean without per-use null checks.
  const scored = data.filter(
    (c): c is ScoredCountry => c.score !== null
  );
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const top3 = sorted.slice(0, 3);
  const bottom3 = sorted.slice(-3).reverse();

  const newestFetchedAt = data.reduce<Date | null>((best, c) => {
    if (!c.fetchedAt) return best;
    const d = new Date(c.fetchedAt);
    return !best || d > best ? d : best;
  }, null);

  return { scored, top3, bottom3, newestFetchedAt };
}
