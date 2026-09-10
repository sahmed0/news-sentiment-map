// Gives a short summary of global news sentiment on a specific day.
// Reports a change from the norm rather than an absolute claim
// about global mood because the evaluation shows the model is
// negative leaning, so using its scores to make absolute claims is
// misleading.
import { MIN_HISTORY_DAYS, type ResolvedPoint } from "./worldHistory";
import { formatShortDate } from "./history";

// Below this many scored countries on the active day, the stat renders nothing
// rather than generalising about "the world" from a handful of readings.
export const MIN_COUNTRIES_FOR_SUMMARY = 20;

export const IN_LINE_HEADLINE = "In line with the last 30 days";

export interface WorldSummary {
  score: number;     // mean across countries with a score on the active day
  baseline: number;  // mean of the per-day means across the whole window
  delta: number;     // score - baseline
  countries: number; // how many countries the day's mean averaged
  headline: string;
  detail: string;
}

// delta -> plain-English band. The "slightly" bands own their outer boundary:
// -0.02 and 0.02 exactly read as slightly off, not in line.
export function summaryHeadline(delta: number): string {
  if (delta <= -0.06) return "More negative than usual";
  if (delta <= -0.02) return "Slightly more negative than usual";
  if (delta < 0.02) return IN_LINE_HEADLINE;
  if (delta < 0.06) return "Slightly more positive than usual";
  return "More positive than usual";
}

// Mean of the non-null scores at one day index, and how many there were. A
// carried value counts: it is what the map paints for that country that day, so
// the stat should average the same picture the map shows.
function dayMean(
  resolved: Record<string, ResolvedPoint[]>,
  dayIndex: number,
): { mean: number; count: number } {
  let sum = 0;
  let count = 0;
  for (const points of Object.values(resolved)) {
    const score = points[dayIndex]?.score;
    if (typeof score === "number") {
      sum += score;
      count += 1;
    }
  }
  return { mean: count > 0 ? sum / count : NaN, count };
}

const fmtSigned = (n: number): string => `${n < 0 ? "−" : "+"}${Math.abs(n).toFixed(2)}`;

export function computeWorldSummary(
  resolved: Record<string, ResolvedPoint[]>,
  days: string[],
  dayIndex: number,
  isLive: boolean,
): WorldSummary | null {
  if (days.length < MIN_HISTORY_DAYS) return null;

  const today = dayMean(resolved, dayIndex);
  if (today.count < MIN_COUNTRIES_FOR_SUMMARY) return null;

  // A mean of daily means, so a day with wider coverage does not pull the
  // baseline toward itself. Days with nothing scored are skipped, not zeroed.
  const dailyMeans: number[] = [];
  for (let i = 0; i < days.length; i++) {
    const { mean, count } = dayMean(resolved, i);
    if (count > 0) dailyMeans.push(mean);
  }
  const baseline = dailyMeans.reduce((a, b) => a + b, 0) / dailyMeans.length;

  const score = today.mean;
  const delta = score - baseline;
  const headline = summaryHeadline(delta);

  const when = isLive ? "today" : `on ${formatShortDate(days[dayIndex])}`;
  const magnitude =
    headline === IN_LINE_HEADLINE
      ? "in line with the 30-day average"
      : `${Math.abs(delta).toFixed(2)} ${delta < 0 ? "below" : "above"} the 30-day average`;
  const detail = `${fmtSigned(score)} ${when} · ${magnitude}`;

  return { score, baseline, delta, countries: today.count, headline, detail };
}
