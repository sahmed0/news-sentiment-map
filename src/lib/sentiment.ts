// Shared sentiment thresholds/colors used by the map AND the country panel,
// so bucket logic, colors, and filter options never drift apart.
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

// "all" accent for filter controls - the theme foreground, not a sentiment
// color. Resolves per theme via the --fg-rgb token.
export const ALL_ACCENT = "rgb(var(--fg-rgb))";

export const SENTIMENT_FILTERS: readonly { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "positive", label: "Positive" },
  { key: "neutral", label: "Neutral" },
  { key: "negative", label: "Negative" },
];
