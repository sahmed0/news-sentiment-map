// src/components/WorldSummary.tsx
import { BUCKET_COLOR } from "../lib/sentiment";
import { IN_LINE_HEADLINE, type WorldSummary as WorldSummaryResult } from "../lib/summary";

// Sentiment coloured only when the day actually leans one way,
// neutral uses the brand block's own colour. The "World news" lead-in gives
// the headline its subject now that no app title sits above it.
export function WorldSummary({ summary }: { summary: WorldSummaryResult | null }) {
  if (!summary) return null;

  const tint =
    summary.headline === IN_LINE_HEADLINE
      ? undefined
      : summary.delta < 0
        ? BUCKET_COLOR.negative
        : BUCKET_COLOR.positive;

  return (
    <div>
      <p className="text-xs sm:text-sm font-semibold">
        <span className="font-bold">World news · </span>
        <span style={tint ? { color: tint } : undefined}>{summary.headline}</span>
      </p>
      <p className="text-[10px] sm:text-xs opacity-60 tabular-nums">{summary.detail}</p>
    </div>
  );
}
