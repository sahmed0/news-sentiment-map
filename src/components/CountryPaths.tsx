// src/components/CountryPaths.tsx
// The map's country paths, split out of WorldMap and memoized: zooming
// updates WorldMap's `zoomK` on every d3-zoom frame, and only the label layer
// actually depends on it. Behind React.memo the paths render once and are
// skipped for the rest of the gesture.
//
// Every prop here must be referentially stable or the memo is worthless:
// `features` is module-scope static data, `paths` changes identity only on
// reprojection, `byCode` is memoized in useSentimentData, the handlers are
// useCallback'd, and the selection arrives as a primitive code rather than the
// country object.
import { memo } from "react";
import type { Feature } from "geojson";
import { sentimentBucket, scoreColor } from "../lib/sentiment";
import { numericToAlpha2 } from "../lib/geo";
import type { CountryResult, FilterKey } from "../../shared/types";

interface CountryPathsProps {
  features: Feature[];
  paths: Record<string, string | null>; // { numericId: svgPathString }
  byCode: Record<string, CountryResult>;
  selectedCode: string | null;          // UPPERCASE alpha-2, or null
  sentimentFilter: FilterKey;
  onSelectCountry: (country: CountryResult) => void;
  onHover: (e: React.MouseEvent, name: string, score: number | null | undefined) => void;
  onHoverEnd: () => void;
}

export const CountryPaths = memo(function CountryPaths({
  features,
  paths,
  byCode,
  selectedCode,
  sentimentFilter,
  onSelectCountry,
  onHover,
  onHoverEnd,
}: CountryPathsProps) {
  return (
    <>
      {features.map((f, i) => {
        if (f.id == null) return null;
        const numId = String(f.id).padStart(3, "0");
        const alpha2 = numericToAlpha2(numId);
        const countryData = alpha2 ? byCode[alpha2] : null;
        const score = countryData?.score;
        const numericScore = typeof score === "number" ? score : null;
        const hasData = numericScore !== null;
        const isSelected = alpha2 != null && alpha2 === selectedCode;
        // Dim countries that don't match the active sentiment filter so the
        // matching ones stand out. Unscored countries are dimmed too while filtering.
        const dimmed =
          sentimentFilter !== "all" &&
          (!hasData || sentimentBucket(score) !== sentimentFilter);
        const d = paths[numId];
        if (!d) return null;

        return (
          <path
            key={`${numId}-${i}`}
            d={d}
            strokeWidth={isSelected ? 1.1 : 0.4}
            style={{
              fill: numericScore !== null ? scoreColor(numericScore) : "var(--map-empty)",
              stroke: isSelected ? "rgb(var(--fg-rgb))" : "rgb(var(--bg-rgb))",
              opacity: dimmed ? "var(--map-dimmed-opacity)" : isSelected ? 1 : 0.88,
              cursor: hasData ? "pointer" : "default",
              filter: isSelected
                ? "brightness(1.3) drop-shadow(0 0 5px rgb(var(--fg-rgb)/0.5))"
                : undefined,
              // `fill` gets a slower transition than opacity/filter so a fresh
              // fetch reads as the map "lighting up" from its empty color to a
              // scored one, rather than an abrupt color swap.
              transition: "opacity 0.15s, filter 0.15s, fill 0.6s ease-out",
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (hasData && countryData) onSelectCountry(countryData);
            }}
            onMouseMove={(e) => onHover(e, countryData?.name ?? numId, score)}
            onMouseEnter={(e) => onHover(e, countryData?.name ?? numId, score)}
            onMouseLeave={onHoverEnd}
          />
        );
      })}
    </>
  );
});
