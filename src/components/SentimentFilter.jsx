// src/components/SentimentFilter.jsx
// Reusable sentiment segmented control, shared by the map and the country panel.
import { SENTIMENT_FILTERS, BUCKET_COLOR, ALL_ACCENT } from "../lib/sentiment";

export function SentimentFilter({ value, onChange, counts, className = "" }) {
  return (
    <div className={`flex gap-1 ${className}`}>
      {SENTIMENT_FILTERS.map(({ key, label }) => {
        const active = value === key;
        const isAll = key === "all";
        const accent = isAll ? ALL_ACCENT : BUCKET_COLOR[key];
        // The "all" accent is an rgb(var()) color, so its translucent active
        // tints use the var-with-alpha form; bucket colors are hex (#rrggbb)
        // and take a hex alpha suffix.
        const activeBg = isAll ? "rgb(var(--fg-rgb) / 0.13)" : `rgb(var(--c-${key}-rgb) / 0.13)`;
        const activeBorder = isAll ? "rgb(var(--fg-rgb) / 0.33)" : `rgb(var(--c-${key}-rgb) / 0.33)`;
        return (
          <button
            key={key}
            onClick={() => onChange(key)}
            className="flex-1 sm:flex-none max-h-7 rounded-md px-1 py-1 text-[13px] sm:text-[14px] font-semibold transition-colors whitespace-nowrap"
            style={{
              background: active ? activeBg : "rgb(var(--fg-rgb) / 0.05)",
              color: active ? accent : "rgb(var(--fg-rgb) / 0.65)",
              border: `1px solid ${active ? activeBorder : "transparent"}`,
            }}
          >
            {label}
            {counts ? <span className="opacity-60"> {counts[key]}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
