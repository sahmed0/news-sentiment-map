// src/components/Legend.tsx
import { useState } from "react";
import { motion } from "framer-motion";
import { useIsMobile } from "../hooks/useMediaQuery";
import { legendGradientCss, BUCKET_COLOR } from "../lib/sentiment";
import { deriveRankings, type ScoredCountry } from "../lib/rankings";
import { flagEmoji } from "../lib/geo";
import type { CountryResult } from "../../shared/types";

// One leaderboard row: flag, name, score, and a bar sized to |score| (max
// magnitude 1) so the ranking has a visual read, not just three numbers.
function RankRow({ country, color, sign, delay }: {
  country: ScoredCountry;
  color: string;
  sign: "+" | "";
  delay: number;
}) {
  const pct = Math.min(Math.abs(country.score) * 100, 100);
  return (
    <div className="flex items-center gap-1.5 mb-1.5 last:mb-0">
      <span className="text-xs leading-none shrink-0" aria-hidden="true">
        {flagEmoji(country.code)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex justify-between gap-1">
          <span className="opacity-70 truncate">{country.name}</span>
          <span style={{ color }} className="font-bold shrink-0 tabular-nums">
            {sign}
            {country.score.toFixed(2)}
          </span>
        </div>
        <div className="h-1 rounded-full bg-fg/10 overflow-hidden mt-0.5">
          <motion.div
            className="h-full rounded-full"
            style={{ background: color }}
            initial={{ width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.5, delay, ease: "easeOut" }}
          />
        </div>
      </div>
    </div>
  );
}

interface LegendProps {
  data: CountryResult[];
  lastUpdated: Date | null;
  fromCache: boolean;
}

export function Legend({ data, lastUpdated, fromCache }: LegendProps) {
  const isMobile = useIsMobile();
  // Collapsed by default on phones; expanded by default on desktop (toggleable everywhere).
  const [open, setOpen] = useState(() => !isMobile);

  const { scored, top3, bottom3, newestFetchedAt } = deriveRankings(data);

  return (
    <div className="absolute top-2 left-3 sm:top-auto sm:bottom-2 sm:left-2 mb-[env(safe-area-inset-bottom)] z-10">
      {/* Mobile toggle */}
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
            style={{ background: legendGradientCss() }}
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
              {top3.map((c, i) => (
                <RankRow key={c.code} country={c} color={BUCKET_COLOR.positive} sign="+" delay={i * 0.05} />
              ))}
            </div>
            <div>
              <p className="uppercase tracking-widest opacity-60 mb-1.5">Most negative</p>
              {bottom3.map((c, i) => (
                <RankRow key={c.code} country={c} color={BUCKET_COLOR.negative} sign="" delay={i * 0.05} />
              ))}
            </div>
          </div>
        )}

        {/* Data freshness - derived from the most recently fetched country in data. */}
        {newestFetchedAt ? (
          <p className="opacity-60 text-[11px]">
            Updated on {newestFetchedAt.toLocaleString("en-GB", { timeStyle: "short", dateStyle: "long", timeZone: "UTC" })} UTC
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
