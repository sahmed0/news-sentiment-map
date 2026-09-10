// src/App.tsx
import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { WorldMap, type WorldMapHandle } from "./components/WorldMap";
import { CountryPanel } from "./components/CountryPanel";
import { Legend, LegendContent } from "./components/Legend";
import { SentimentFilter } from "./components/SentimentFilter";
import { FirstVisitHint } from "./components/FirstVisitHint";
import { BrandBlock } from "./components/BrandBlock";
import { WorldSummary } from "./components/WorldSummary";
import { Sheet } from "./components/Sheet";
import { MobileToolbar, type MobileToolbarItem } from "./components/MobileToolbar";
import { TimeScrubber } from "./components/TimeScrubber";
import { sentimentBucket } from "./lib/sentiment";
import { computeWorldSummary } from "./lib/summary";
import { scoresForDay, MIN_HISTORY_DAYS } from "./lib/worldHistory";
import { useSentimentData } from "./hooks/useSentimentData";
import { useWorldHistory } from "./hooks/useWorldHistory";
import { useTheme } from "./hooks/useTheme";
import { Sun, Moon, Info, Funnel, List, Clock } from 'lucide-react';
import { InfoPanel } from "./components/InfoPanel";
import type { CountryResult, FilterKey } from "../shared/types";

// Once dismissed (closed, a country picked, or left to time out), the
// first-visit hint never shows again on this device.
const HINT_SEEN_KEY = "nsm-hint-seen";
const HINT_AUTO_DISMISS_MS = 7000;

export default function App() {
  const { byCode, data, loading, warming, error, lastUpdated, fromCache, refetch } =
    useSentimentData();
  const { history, resolved } = useWorldHistory();
  const { theme, toggle: toggleTheme } = useTheme();
  const [selectedCountry, setSelectedCountry] = useState<CountryResult | null>(null);
  const [sentimentFilter, setSentimentFilter] = useState<FilterKey>("all");
  const [showInfo, setShowInfo] = useState(false);
  // Selecting a country closes whichever sheet is open.
  const [openSheet, setOpenSheet] = useState<null | "filter" | "legend" | "time">(null);
  // The scrubber's day, or null for live/today. The map handle is driven
  // imperatively during a drag (see handlePreview) to skip 155 React diffs/frame.
  const [dayIndex, setDayIndex] = useState<number | null>(null);
  const mapRef = useRef<WorldMapHandle | null>(null);
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

  // The timeline only shows once there's a week of history to
  // scrub; below that no scrubber renders.
  const hasScrubber = !loading && data.length > 0 && history.days.length >= MIN_HISTORY_DAYS;
  const isLive = dayIndex === null;
  const activeDayIndex = dayIndex ?? Math.max(0, history.days.length - 1);

  // The scrubbed day's scores, keyed UPPERCASE. Used to override the map fills,
  // the filter counts and the legend leaderboard so they all agree with what
  // the map is showing.
  const dayScores = useMemo(
    () => scoresForDay(resolved, activeDayIndex),
    [resolved, activeDayIndex],
  );

  // Passed to the map: undefined on the live day (CountryPaths falls back to
  // byCode), the day's override otherwise.
  const activeScores = isLive ? undefined : dayScores;

  // `data` with each score swapped for the scrubbed day's, so counts and
  // rankings follow the timeline. Identical to `data` on the live day.
  const activeData = useMemo(
    () =>
      isLive
        ? data
        : data.map((c) => ({ ...c, score: dayScores[c.code.toUpperCase()] ?? null })),
    [isLive, data, dayScores],
  );

  // The world summary stat. Follows the scrubber onto past days.
  const worldSummary = useMemo(
    () => computeWorldSummary(resolved, history.days, activeDayIndex, isLive),
    [resolved, history.days, activeDayIndex, isLive],
  );

  // Country counts per sentiment bucket for the map filter ("all" = all scored).
  const sentimentCounts = useMemo<Record<FilterKey, number>>(() => {
    const counts: Record<FilterKey, number> = { all: 0, positive: 0, neutral: 0, negative: 0 };
    for (const country of activeData) {
      const bucket = sentimentBucket(country.score);
      if (bucket) {
        counts[bucket] += 1;
        counts.all += 1;
      }
    }
    return counts;
  }, [activeData]);

  // Drag frames: paint straight to the DOM, no React state.
  const handleScrubPreview = useCallback(
    (i: number) => {
      mapRef.current?.paintScores(scoresForDay(resolved, i));
    },
    [resolved],
  );

  // Release / keyboard commit / autoplay step: hand the day back to React, which
  // repaints the map from `activeScores`.
  const handleScrubCommit = useCallback(
    (i: number) => {
      mapRef.current?.releaseScores();
      setDayIndex(i >= history.days.length - 1 ? null : i);
    },
    [history.days.length],
  );

  // Stable identity: WorldMap forwards this to a memoized path layer, which a
  // fresh arrow on every render would defeat.
  const handleSelectCountry = useCallback((country: CountryResult) => {
    setSelectedCountry(country);
    setShowInfo(false);
    setOpenSheet(null);
    dismissHint();
  }, [dismissHint]);

  const btnStyle = {
    background: "rgb(var(--fg-rgb) / 0.08)",
    border: "1px solid rgb(var(--fg-rgb) / 0.12)",
    color: "rgb(var(--fg-rgb) / 0.7)",
  };

  const mobileToolbarItems: MobileToolbarItem[] = [
    {
      key: "filter",
      label: "Filter",
      icon: <Funnel size={20} />,
      active: openSheet === "filter",
      badge: sentimentFilter !== "all",
      onPress: () => setOpenSheet((s) => (s === "filter" ? null : "filter")),
    },
    ...(hasScrubber
      ? [{
          key: "time",
          label: "Time",
          icon: <Clock size={20} />,
          active: openSheet === "time",
          onPress: () => setOpenSheet((s) => (s === "time" ? null : "time")),
        } satisfies MobileToolbarItem]
      : []),
    {
      key: "legend",
      label: "Legend",
      icon: <List size={20} />,
      active: openSheet === "legend",
      onPress: () => setOpenSheet((s) => (s === "legend" ? null : "legend")),
    },
  ];

  return (
    <div
      className={`relative w-full h-full overflow-hidden transition-colors duration-300 ${
        theme === "light" ? "theme-light" : ""
      }`}
      style={{ background: "rgb(var(--bg-rgb))", color: "rgb(var(--fg-rgb))" }}
    >
      {/* -- Brand: title + tagline, top-left at every breakpoint so the
          bottom edge stays clear for the scrubber. right-24 on mobile keeps
          it clear of the top-right icon buttons. */}
      <div className="absolute top-3 left-3 right-24 sm:right-auto z-10">
        <BrandBlock>
          <WorldSummary summary={worldSummary} />
        </BrandBlock>
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
          onClick={() => { setShowInfo((v) => !v); setOpenSheet(null); }}
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

      {/* -- Map sentiment filter (desktop only; mobile gets this via the
          toolbar's Filter sheet) -- */}
      {!loading && data.length > 0 && (
        <div
          className="hidden md:block absolute top-24 left-3 z-10 rounded-xl p-2"
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
          scores={activeScores}
          handleRef={mapRef}
          onSelectCountry={handleSelectCountry}
        />
      </div>

      {/* -- Country detail panel -- */}
      <div onClick={(e) => e.stopPropagation()}>
        <CountryPanel
          country={selectedCountry}
          onClose={() => setSelectedCountry(null)}
          historical={
            !isLive && selectedCountry
              ? {
                  date: history.days[activeDayIndex],
                  score: dayScores[selectedCountry.code.toUpperCase()] ?? null,
                }
              : undefined
          }
        />
      </div>

      {/* -- Info panel -- */}
      <div onClick={(e) => e.stopPropagation()}>
        <InfoPanel open={showInfo} onClose={() => setShowInfo(false)} />
      </div>

      {/* -- Legend + leaderboard (desktop) -- */}
      {!loading && data.length > 0 && (
        <Legend
          data={activeData}
          lastUpdated={lastUpdated}
          fromCache={fromCache}
        />
      )}

      {/* -- Time scrubber (desktop, always visible).
          Mobile has it in the toolbar's Time sheet.
          Visibility lives on the wrapper so `hidden` never fights the control's
          own `flex`. -- */}
      {hasScrubber && (
        <div className="hidden sm:block absolute bottom-3 inset-x-3 md:inset-x-auto md:left-1/2 md:-translate-x-1/2 md:w-[min(46rem,60vw)] z-10">
          <TimeScrubber
            days={history.days}
            value={activeDayIndex}
            onPreview={handleScrubPreview}
            onCommit={handleScrubCommit}
          />
        </div>
      )}

      {/* -- Mobile toolbar + sheets: hidden while CountryPanel/InfoPanel is
          open. All three share the bottom edge at the same z-index, so left
          unconditional they'd paint over (and stay tappable through) the
          last ~60px of an open panel; gating them here also means an open
          sheet is already gone by the time a panel starts sliding in. -- */}
      {!loading && data.length > 0 && !selectedCountry && !showInfo && (
        <>
          <MobileToolbar items={mobileToolbarItems} />
          <Sheet
            open={openSheet === "filter"}
            onClose={() => setOpenSheet(null)}
            title="Filter by sentiment"
          >
            <SentimentFilter
              value={sentimentFilter}
              onChange={setSentimentFilter}
              counts={sentimentCounts}
            />
          </Sheet>
          <Sheet
            open={openSheet === "legend"}
            onClose={() => setOpenSheet(null)}
            title="Legend & rankings"
          >
            <LegendContent data={activeData} lastUpdated={lastUpdated} fromCache={fromCache} />
          </Sheet>
          {hasScrubber && (
            <Sheet
              open={openSheet === "time"}
              onClose={() => setOpenSheet(null)}
              title="Timeline"
            >
              <TimeScrubber
                days={history.days}
                value={activeDayIndex}
                onPreview={handleScrubPreview}
                onCommit={handleScrubCommit}
              />
            </Sheet>
          )}
        </>
      )}
    </div>
  );
}
