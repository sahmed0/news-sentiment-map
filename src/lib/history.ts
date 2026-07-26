// Geometry behind the country panel's 30-day trend chart.
// Kept out of the component so the shape of the line and the 7-day delta are
// unit-testable without rendering anything.
import type { HistoryPoint } from "../../shared/types";

// Internal coordinate space of the sparkline. The chart stretches to its
// container via viewBox + preserveAspectRatio="none", so only the ratio between
// these units matters.
export const SPARK_VIEW_W = 100;
// Inset so the stroke and the end marker aren't clipped at the top/bottom edge.
const PAD = 2;

const DELTA_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

// Score -1..1 -> y, inverted so a positive score sits near the top.
export function scoreY(score: number, h: number): number {
  return PAD + ((1 - score) / 2) * (h - 2 * PAD);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Evenly spaced by index, not by date: the series is a sequence of scored days,
// and stretching gaps to real time would imply data I don't have.
export function buildPolyline(points: HistoryPoint[], w: number, h: number): string {
  // One point has no gap to divide by - it lands at x=0 and draws no line. The
  // panel gates the chart at three points, but the helper must never produce
  // NaN coordinates for a caller that doesn't.
  const step = points.length > 1 ? w / (points.length - 1) : 0;
  return points.map((p, i) => `${round2(i * step)},${round2(scoreY(p.score, h))}`).join(" ");
}

// Latest score minus the most recent point at least 7 calendar days older.
// Walks dates rather than counting array positions: only scored days write a
// point, so seven entries back is not necessarily seven days back.
export function computeDelta7d(points: HistoryPoint[]): number | null {
  if (points.length < 2) return null;
  const latest = points[points.length - 1];
  const cutoff = Date.parse(latest.date) - DELTA_WINDOW_DAYS * DAY_MS;
  for (let i = points.length - 2; i >= 0; i--) {
    if (Date.parse(points[i].date) <= cutoff) return latest.score - points[i].score;
  }
  return null;
}
