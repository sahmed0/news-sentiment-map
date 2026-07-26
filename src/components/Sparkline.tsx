// src/components/Sparkline.tsx
import { bucketColor, BUCKET_COLOR } from "../lib/sentiment";
import { SPARK_VIEW_W, buildPolyline, scoreY } from "../lib/history";
import type { HistoryPoint } from "../../shared/types";

interface SparklineProps {
  points: HistoryPoint[];
  height?: number;
}

export function Sparkline({ points, height = 36 }: SparklineProps) {
  if (!points.length) return null;

  const last = points[points.length - 1];
  const lastX = points.length > 1 ? SPARK_VIEW_W : 0;
  // Stored points always carry a numeric score, so bucketColor never returns
  // null here; the fallback only keeps the type a plain string.
  const dotColor = bucketColor(last.score) ?? BUCKET_COLOR.neutral;
  const midY = scoreY(0, height);

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${SPARK_VIEW_W} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Sentiment trend over the last ${points.length} scored days`}
    >
      {/* Neutral baseline, so how far the line sits from zero stays readable. */}
      <line
        x1={0}
        y1={midY}
        x2={SPARK_VIEW_W}
        y2={midY}
        stroke="rgb(var(--fg-rgb) / 0.15)"
        strokeWidth={1}
        strokeDasharray="2 2"
        vectorEffect="non-scaling-stroke"
      />
      <polyline
        points={buildPolyline(points, SPARK_VIEW_W, height)}
        fill="none"
        stroke="rgb(var(--fg-rgb) / 0.6)"
        strokeWidth={1.5}
        // Without this the non-uniform viewBox scaling stretches the stroke
        // horizontally along with the geometry.
        vectorEffect="non-scaling-stroke"
      />
      {/* End marker as a round-capped zero-length line, not a <circle>: under
          preserveAspectRatio="none" a circle's fill scales with the container
          and renders as a wide ellipse, while a non-scaling stroke stays round. */}
      <line
        x1={lastX}
        y1={scoreY(last.score, height)}
        x2={lastX}
        y2={scoreY(last.score, height)}
        stroke={dotColor}
        strokeWidth={5}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
