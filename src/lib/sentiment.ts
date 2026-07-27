// Shared sentiment thresholds/colors used by the map AND the country panel,
// so bucket logic, colors, and filter options never drift apart.
// NOTE: Always spell 'colors' in code and comments to avoid confusion!
import { scaleLinear } from "d3-scale";
import type { SentimentBucket, FilterKey } from "../../shared/types";

// Maps a score to a bucket. Returns null for unscored items (number check),
// so they're excluded from sentiment filters but still countable as "all".
export function sentimentBucket(score: unknown): SentimentBucket | null {
  if (typeof score !== "number") return null;
  if (score > 0.1) return "positive";
  if (score < -0.1) return "negative";
  return "neutral";
}

export const BUCKET_COLOR: Record<SentimentBucket, string> = {
  positive: "rgb(var(--c-positive-rgb))",
  neutral: "rgb(var(--c-neutral-rgb))",
  negative: "rgb(var(--c-negative-rgb))",
};

// Anchors of the diverging map ramp. ColorBrewer RdYlBu-5 reversed: colorblind-safe
// (hue+lightness separate the poles for deuteranopes, unlike the old #f00→#0f0 ramp).
// The narrow ±0.1 neutral band matches sentimentBucket so map color and bucket
// labels can never disagree.
export const SENTIMENT_STOPS = [
  { score: -1.0, color: "#d7191c" }, // strong negative - red
  { score: -0.1, color: "#fdae61" }, // weak negative   - orange
  { score:  0.0, color: "#ffffbf" }, // neutral         - pale yellow
  { score:  0.1, color: "#abd9e9" }, // weak positive   - light blue
  { score:  1.0, color: "#2c7bb6" }, // strong positive - blue
] as const;

// Range is typed string (color hex codes) so the scale interpolates colors.
const colorScale = scaleLinear<string>()
  .domain(SENTIMENT_STOPS.map((s) => s.score))
  .range(SENTIMENT_STOPS.map((s) => s.color))
  .clamp(true);

// Continuous map fill for a country's average score.
export function scoreColor(score: number): string {
  return colorScale(score);
}

// The legend ramp as a CSS value. Stop positions are the domain scores mapped
// linearly onto 0-100%, derived from the same anchors the map uses, so the
// legend can never advertise a ramp the map doesn't paint.
export function legendGradientCss(): string {
  const stops = SENTIMENT_STOPS.map((s) => {
    const pct = Number((((s.score + 1) / 2) * 100).toFixed(2));
    return `${s.color} ${pct}%`;
  });
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

// Discrete bucket color for text/chips/bars - the theme-tuned token, not the
// map ramp, so it stays readable on panel backgrounds in both themes.
export function bucketColor(score: number | null | undefined): string | null {
  const bucket = sentimentBucket(score);
  return bucket ? BUCKET_COLOR[bucket] : null;
}

// "all" accent for filter controls - the theme foreground, not a sentiment
// color. Resolves per theme via the --fg-rgb token.
export const ALL_ACCENT = "rgb(var(--fg-rgb))";

export const SENTIMENT_FILTERS: readonly { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "positive", label: "Positive" },
  { key: "neutral", label: "Neutral" },
  { key: "negative", label: "Negative" },
];
