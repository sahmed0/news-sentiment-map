// src/components/WorldSummary.tsx
import { BUCKET_COLOR } from "../lib/sentiment";
import { IN_LINE_HEADLINE, type WorldSummary as WorldSummaryResult } from "../lib/summary";

// Sentiment coloured only when the day actually leans one way,
// neutral uses the brand block's own colour.
export function WorldSummary({ summary }: { summary: WorldSummaryResult | null }) {
  if (!summary) return null;

  const tint =
    summary.headline === IN_LINE_HEADLINE
      ? undefined
      : summary.delta < 0
        ? BUCKET_COLOR.negative
        : BUCKET_COLOR.positive;

  return (
    <div className="mt-1">
      <p className="text-xs font-semibold" style={tint ? { color: tint } : undefined}>
        {summary.headline}
      </p>
      <p className="text-[10px] opacity-60 tabular-nums">{summary.detail}</p>
    </div>
  );
}
