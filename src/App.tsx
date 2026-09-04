// src/App.tsx
import { useState, useMemo, useCallback, useEffect } from "react";
import { WorldMap } from "./components/WorldMap";
import { CountryPanel } from "./components/CountryPanel";
import { Legend } from "./components/Legend";
import { SentimentFilter } from "./components/SentimentFilter";
import { FirstVisitHint } from "./components/FirstVisitHint";
import { sentimentBucket } from "./lib/sentiment";
import { useSentimentData } from "./hooks/useSentimentData";
import { useTheme } from "./hooks/useTheme";
import { Sun, Moon, Info } from 'lucide-react';
import { InfoPanel } from "./components/InfoPanel";
import type { CountryResult, FilterKey } from "../shared/types";

// Once dismissed (closed, a country picked, or left to time out), the
// first-visit hint never shows again on this device.
const HINT_SEEN_KEY = "nsm-hint-seen";
const HINT_AUTO_DISMISS_MS = 7000;

export default function App() {
  const { byCode, data, loading, warming, error, lastUpdated, fromCache, refetch } =
    useSentimentData();
  const { theme, toggle: toggleTheme } = useTheme();
  const [selectedCountry, setSelectedCountry] = useState<CountryResult | null>(null);
  const [sentimentFilter, setSentimentFilter] = useState<FilterKey>("all");
  const [showInfo, setShowInfo] = useState(false);
  // Lazy-read once per mount: whether this device has already dismissed the
  // first-visit hint. A ref (not state) would need the same "read once"
  // guard; a lazy initializer is the idiomatic way to do a one-time read.
  const [hintSeen, setHintSeen] = useState(() => {
    try {
      return localStorage.getItem(HINT_SEEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  // Shown once real data is on screen and nothing else is competing for the
  // same banner slot, unless this device has already dismissed it.
  const showHint = !loading && !warming && !error && data.length > 0 && !hintSeen;

  const dismissHint = useCallback(() => {
    setHintSeen(true);
    try {
      localStorage.setItem(HINT_SEEN_KEY, "1");
    } catch {
      // Private browsing / storage disabled - the hint just reappears next visit.
    }
  }, []);

  // Auto-dismiss so the hint never overstays its welcome. The effect only
  // schedules a timer; the actual setState happens in its callback.
  useEffect(() => {
    if (!showHint) return;
    const timer = setTimeout(dismissHint, HINT_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [showHint, dismissHint]);

  // Country counts per sentiment bucket for the map filter ("all" = all scored).
  const sentimentCounts = useMemo<Record<FilterKey, number>>(() => {
    const counts: Record<FilterKey, number> = { all: 0, positive: 0, neutral: 0, negative: 0 };
    for (const country of data) {
      const bucket = sentimentBucket(country.score);
      if (bucket) {
        counts[bucket] += 1;
        counts.all += 1;
      }
    }
    return counts;
  }, [data]);

  // Stable identity: WorldMap forwards this to a memoized path layer, which a
  // fresh arrow on every render would defeat.
  const handleSelectCountry = useCallback((country: CountryResult) => {
    setSelectedCountry(country);
    setShowInfo(false);
    dismissHint();
  }, [dismissHint]);

  const btnStyle = {
    background: "rgb(var(--fg-rgb) / 0.08)",
    border: "1px solid rgb(var(--fg-rgb) / 0.12)",
    color: "rgb(var(--fg-rgb) / 0.7)",
  };

  return (
    <div
      className={`relative w-full h-full overflow-hidden transition-colors duration-300 ${
        theme === "light" ? "theme-light" : ""
      }`}
      style={{ background: "rgb(var(--bg-rgb))", color: "rgb(var(--fg-rgb))" }}
    >
      {/* -- Title --
          Mobile: left-aligned in a top bar, leaving room for the buttons.
          ≥sm: centered hero title as before. */}
      <div className="hidden sm:block absolute top-3 left-4 right-24 sm:top-auto md:bottom-2 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 mb-[env(safe-area-inset-bottom)] z-10 text-left sm:text-center pointer-events-none sm:py-1 sm:px-3 rounded-lg"
      style={{
          background: "rgb(var(--panel-rgb) / 0.85)",
          backdropFilter: "blur(12px)",
          border: "1px solid rgb(var(--fg-rgb) / 0.08)",
          color: "rgb(var(--fg-rgb))",
        }}
        >
        <h1
          className="text-lg sm:text-2xl font-black tracking-tight truncate"
          style={{ fontFamily: "'DM Serif Display', serif", letterSpacing: "-0.02em" }}
        >
          World News Sentiment
        </h1>
        <p className="hidden sm:block text-xs opacity-60 mt-0.5 tracking-wide uppercase">
          Emotional temperature of global headlines
        </p>
      </div>

      {/* -- Top-right controls: theme toggle + info -- */}
      <div className="absolute top-3 right-3 z-20 flex items-center gap-2">
        <button
          onClick={toggleTheme}
          className="w-9 h-9 rounded-lg transition-all flex items-center justify-center"
          style={btnStyle}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {theme === "dark" ? <Sun size={25} /> : <Moon size={25} />}
        </button>
        <button
          onClick={() => setShowInfo((v) => !v)}
          className="w-9 h-9 rounded-lg transition-all flex items-center justify-center"
          style={showInfo ? { ...btnStyle, background: "rgb(var(--fg-rgb) / 0.18)" } : btnStyle}
          aria-label="About this project"
          title="About this project"
        >
          <Info size={25} />
        </button>
      </div>

      {/* -- Status banners: loading / warming / error, stacked in one column so no
          combination overlaps. Non-blocking (the map stays visible and
          interactive underneath) - a cold start reads as the map "waking up"
          and materialising rather than the app being broken. -- */}
      <div className="absolute top-16 left-3 right-3 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 z-30 flex flex-col items-center gap-2 pointer-events-none">
        {loading && (
          <div
            className="flex items-center gap-2 px-4 py-2 rounded-full text-xs sm:text-sm font-medium"
            style={{
              background: "rgb(var(--panel-rgb) / 0.85)",
              backdropFilter: "blur(12px)",
              border: "1px solid rgb(var(--fg-rgb) / 0.1)",
              color: "rgb(var(--fg-rgb) / 0.85)",
            }}
          >
            <span className="w-3.5 h-3.5 rounded-full border-2 border-fg/20 border-t-fg/70 animate-spin shrink-0" />
            Fetching headlines &amp; scoring sentiment…
          </div>
        )}

        {warming && (
          <div className="pointer-events-auto px-4 py-2 rounded-lg text-sm text-center"
            style={{
              background: "rgb(var(--fg-rgb) / 0.08)",
              border: "1px solid rgb(var(--fg-rgb) / 0.15)",
              color: "rgb(var(--fg-rgb))",
            }}>
            Waking the data service… retrying in ~{warming.delaySeconds}s (attempt {warming.attempt}/{warming.maxAttempts})
          </div>
        )}

        {error && (
          <div className="pointer-events-auto px-4 py-2 rounded-lg text-sm flex items-center justify-center gap-3"
            style={{ background: "#ff000022", border: "1px solid #ff000055", color: "#f87171" }}>
            <span className="text-center">Error: {error}</span>
            <button
              onClick={refetch}
              className="shrink-0 px-2 py-1 rounded-md text-xs transition-all"
              style={btnStyle}
            >
              Retry
            </button>
          </div>
        )}

        <FirstVisitHint show={showHint} onDismiss={dismissHint} />
      </div>

      {/* -- Map sentiment filter --
          Mobile: full-width bar docked at the bottom. ≥sm: compact panel top-left. */}
      {!loading && data.length > 0 && (
        <div
          className="absolute bottom-3 left-3 right-3 sm:left-1/3 sm:right-auto md:bottom-auto md:top-3 md:left-3 md:right-auto md:w-auto mb-[env(safe-area-inset-bottom)] z-10 rounded-xl p-2"
          style={{
            background: "rgb(var(--panel-rgb) / 0.85)",
            backdropFilter: "blur(12px)",
            border: "1px solid rgb(var(--fg-rgb) / 0.08)",
          }}
        >
          <p className="text-[10px] uppercase tracking-widest opacity-40 light:opacity-65 mb-1.5 px-1">
            Filter by sentiment
          </p>
          <SentimentFilter
            value={sentimentFilter}
            onChange={setSentimentFilter}
            counts={sentimentCounts}
          />
        </div>
      )}

      {/* -- Map -- */}
      <div className="w-full h-full" onClick={() => { setSelectedCountry(null); setShowInfo(false); }}>
        <WorldMap
          byCode={byCode}
          selectedCode={selectedCountry?.code?.toUpperCase() ?? null}
          sentimentFilter={sentimentFilter}
          onSelectCountry={handleSelectCountry}
        />
      </div>

      {/* -- Country detail panel -- */}
      <div onClick={(e) => e.stopPropagation()}>
        <CountryPanel
          country={selectedCountry}
          onClose={() => setSelectedCountry(null)}
        />
      </div>

      {/* -- Info panel -- */}
      <div onClick={(e) => e.stopPropagation()}>
        <InfoPanel open={showInfo} onClose={() => setShowInfo(false)} />
      </div>

      {/* -- Legend + leaderboard -- */}
      {!loading && data.length > 0 && (
        <Legend
          data={data}
          lastUpdated={lastUpdated}
          fromCache={fromCache}
        />
      )}
    </div>
  );
}
