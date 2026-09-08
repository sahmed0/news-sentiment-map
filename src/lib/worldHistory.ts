// Turns the raw bulk-history wire format (per-country arrays with null holes)
// into something the scrubber can paint a frame from. Pure and index-only, so
// the carry-forward rule and the uppercase key boundary are unit-testable
// without a DOM or a fetch.
import type { WorldHistory } from "../../shared/types";

// How many consecutive missing days a country's last known score is allowed to
// stand in for before the map shows it as unscored again.
export const CARRY_FORWARD_MAX_DAYS = 3;

// Below this many days of history the scrubber is not worth showing at all -
// the app stays on the live view and no timeline control renders anywhere.
export const MIN_HISTORY_DAYS = 7;

export interface ResolvedPoint {
  score: number | null;
  // true when this value was filled from an earlier day rather than measured on
  // this one - the in-context disclosure needs to tell the two apart.
  carried: boolean;
}

// Carry a country's last measured score forward across gaps, but only for
// CARRY_FORWARD_MAX_DAYS: low-priority countries refresh every 2 days, so
// without this half the map flickers gray while scrubbing - and with an
// uncapped carry a country that stopped being scored weeks ago would still
// show a confident color. Leading gaps have nothing to carry from and stay null.
export function resolveSeries(
  series: readonly (number | null)[],
  maxCarryDays: number = CARRY_FORWARD_MAX_DAYS,
): ResolvedPoint[] {
  const out: ResolvedPoint[] = [];
  let last: number | null = null;
  let sinceMeasured = 0; // days elapsed since `last` was actually measured

  for (const raw of series) {
    if (typeof raw === "number") {
      last = raw;
      sinceMeasured = 0;
      out.push({ score: raw, carried: false });
      continue;
    }
    sinceMeasured += 1;
    if (last !== null && sinceMeasured <= maxCarryDays) {
      out.push({ score: last, carried: true });
    } else {
      out.push({ score: null, carried: false });
    }
  }
  return out;
}

// Same, for every country. Keys are UPPERCASED here: the API serves lowercase
// alpha-2 but the map indexes by uppercase (see byCode in useSentimentData).
export function resolveWorldHistory(
  history: WorldHistory,
  maxCarryDays: number = CARRY_FORWARD_MAX_DAYS,
): Record<string, ResolvedPoint[]> {
  const out: Record<string, ResolvedPoint[]> = {};
  for (const [code, series] of Object.entries(history.scores)) {
    out[code.toUpperCase()] = resolveSeries(series, maxCarryDays);
  }
  return out;
}

// One day's scores in the shape CountryPaths wants: UPPERCASE alpha-2 -> score
// or null. An out-of-range index yields a null for every country rather than a
// short or empty map, so a caller mid-animation never gets an inconsistent frame.
export function scoresForDay(
  resolved: Record<string, ResolvedPoint[]>,
  dayIndex: number,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [code, points] of Object.entries(resolved)) {
    const point = points[dayIndex];
    out[code] = point ? point.score : null;
  }
  return out;
}
