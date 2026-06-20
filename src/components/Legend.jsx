// src/components/Legend.jsx
import { useState } from "react";

const GRADIENT_STOPS = [
  { pct: "0%", color: "#ff0000" },
  { pct: "50%", color: "#ffff00" },
  { pct: "100%", color: "#00ff00" },
];

// `compact` renders the legend inline (no absolute positioning) so it can sit in
// the mobile/tablet top stack; otherwise it floats at the desktop bottom-left.
export function Legend({ data, lastUpdated, fromCache, compact = false }) {
  // Collapsed by default on compact viewports; expanded on desktop (toggleable everywhere).
  const [open, setOpen] = useState(() => !compact);

  const scored = data.filter((c) => c.score !== null);
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const top3 = sorted.slice(0, 3);
  const bottom3 = sorted.slice(-3).reverse();

  const newestFetchedAt = data.reduce((best, c) => {
    if (!c.fetchedAt) return best;
    const d = new Date(c.fetchedAt);
    return !best || d > best ? d : best;
  }, null);

  return (
    <div className={compact ? "" : "absolute bottom-2 left-2 mb-[env(safe-area-inset-bottom)] z-10"}>
      {/* Toggle */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="mb-2 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold"
        style={{
          background: "rgb(var(--panel-rgb) / 0.85)",
          backdropFilter: "blur(12px)",
          border: "1px solid rgb(var(--fg-rgb) / 0.08)",
          color: "rgb(var(--fg-rgb) / 0.7)",
        }}
        aria-expanded={open}
      >
        <span style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.2s" }}>
          ▸
        </span>
        Legend &amp; rankings
      </button>

      <div
        className={`${open ? "block" : "hidden"} rounded-xl p-4 text-[11px] space-y-2 w-[min(16rem,calc(100vw-1.5rem))] sm:w-[min(15.5rem,calc(100vw-1.5rem))] md:w-[min(18rem,calc(100vw-1.5rem))]`}
        style={{
          background: "rgb(var(--panel-rgb) / 0.85)",
          backdropFilter: "blur(12px)",
          border: "1px solid rgb(var(--fg-rgb) / 0.08)",
        }}
      >
        {/* Color ramp */}
        <div>
          <p className="uppercase tracking-widest opacity-60 mb-2">Sentiment</p>
          <div
            className="h-2 rounded-full mb-1"
            style={{
              background: `linear-gradient(to right, ${GRADIENT_STOPS.map(
                (s) => `${s.color} ${s.pct}`
              ).join(", ")})`,
            }}
          />
          <div className="flex justify-between opacity-60">
            <span>Negative</span>
            <span>Neutral</span>
            <span>Positive</span>
          </div>
        </div>

        {/* Top/bottom countries */}
        {scored.length > 0 && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="uppercase tracking-tight opacity-60 mb-1.5">Most positive</p>
              {top3.map((c) => (
                <div key={c.code} className="flex justify-between gap-1 mb-1">
                  <span className="opacity-70 truncate">{c.name}</span>
                  <span style={{ color: "#00dd00" }} className="font-bold shrink-0">
                    +{c.score.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
            <div>
              <p className="uppercase tracking-widest opacity-60 mb-1.5">Most negative</p>
              {bottom3.map((c) => (
                <div key={c.code} className="flex justify-between gap-1 mb-1">
                  <span className="opacity-70 truncate">{c.name}</span>
                  <span style={{ color: "#ff0000" }} className="font-bold shrink-0">
                    {c.score.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Data freshness - derived from the most recently fetched country in data. */}
        {newestFetchedAt ? (
          <p className="opacity-60 text-[11px]">
            Updated on {newestFetchedAt.toLocaleString("en-GB", { timeStyle: "short", dateStyle: "long" })} UTC
          </p>
        ) : (
          lastUpdated && (
            <p className="opacity-60 text-[11px]">
              {fromCache ? "Cached · " : "Live · "}
              Updated {lastUpdated.toLocaleTimeString("en-GB")}
            </p>
          )
        )}
      </div>
    </div>
  );
}
