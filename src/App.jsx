// src/App.jsx
import { useState, useMemo } from "react";
import { WorldMap } from "./components/WorldMap";
import { CountryPanel } from "./components/CountryPanel";
import { Legend } from "./components/Legend";
import { SentimentFilter } from "./components/SentimentFilter";
import { sentimentBucket } from "./lib/sentiment";
import { useSentimentData } from "./hooks/useSentimentData";
import { useTheme } from "./hooks/useTheme";
import { useIsCompact } from "./hooks/useMediaQuery";
import { Sun, Moon, Info } from 'lucide-react';
import { InfoPanel } from "./components/InfoPanel";

// Collapsible toggle pill used by the compact (mobile/tablet) top stack.
function Toggle({ open, onClick, label, style }) {
  return (
    <button
      onClick={onClick}
      aria-expanded={open}
      className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold"
      style={style}
    >
      <span style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.2s" }}>
        ▸
      </span>
      {label}
    </button>
  );
}

export default function App() {
  const { byCode, data, loading, error, lastUpdated, fromCache } =
    useSentimentData();
  const { theme, toggle: toggleTheme } = useTheme();
  const isCompact = useIsCompact();
  const [selectedCountry, setSelectedCountry] = useState(null);
  const [sentimentFilter, setSentimentFilter] = useState("all");
  const [showInfo, setShowInfo] = useState(false);
  // Mobile/tablet only: each piece of floating chrome is independently shown/hidden.
  const [showTitle, setShowTitle] = useState(false);
  const [showFilter, setShowFilter] = useState(true);

  // Country counts per sentiment bucket for the map filter ("all" = all scored).
  const sentimentCounts = useMemo(() => {
    const counts = { all: 0, positive: 0, neutral: 0, negative: 0 };
    for (const country of data) {
      const bucket = sentimentBucket(country.score);
      if (bucket) {
        counts[bucket] += 1;
        counts.all += 1;
      }
    }
    return counts;
  }, [data]);

  const btnStyle = {
    background: "rgb(var(--fg-rgb) / 0.08)",
    border: "1px solid rgb(var(--fg-rgb) / 0.12)",
    color: "rgb(var(--fg-rgb) / 0.7)",
  };

  // Frosted-glass surface shared by the floating panels and the compact toggles.
  const panelStyle = {
    background: "rgb(var(--panel-rgb) / 0.85)",
    backdropFilter: "blur(12px)",
    border: "1px solid rgb(var(--fg-rgb) / 0.08)",
  };
  const pillStyle = { ...panelStyle, color: "rgb(var(--fg-rgb) / 0.7)" };

  return (
    <div
      className={`relative w-full h-full overflow-hidden transition-colors duration-300 ${
        theme === "light" ? "theme-light" : ""
      }`}
      style={{ background: "rgb(var(--bg-rgb))", color: "rgb(var(--fg-rgb))" }}
    >
      {/* -- Title (desktop) --
          Centered hero title pinned to the bottom. On mobile/tablet the title
          lives in the compact top stack below instead. */}
      {!isCompact && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 mb-[env(safe-area-inset-bottom)] z-10 text-center pointer-events-none py-1 px-3 rounded-lg"
        style={{ ...panelStyle, color: "rgb(var(--fg-rgb))" }}
          >
          <h1
            className="text-2xl font-black tracking-tight truncate"
            style={{ fontFamily: "'DM Serif Display', serif", letterSpacing: "-0.02em" }}
          >
            World News Sentiment
          </h1>
          <p className="text-xs opacity-60 mt-0.5 tracking-wide uppercase">
            Emotional temperature of global headlines
          </p>
        </div>
      )}

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

      {/* -- Loading overlay -- */}
      {loading && (
        <div className="absolute inset-0 z-30 flex items-center justify-center px-6"
          style={{ background: "rgb(var(--bg-rgb) / 0.85)", backdropFilter: "blur(8px)" }}>
          <div className="text-center space-y-2">
            <div className="w-8 h-8 rounded-full border-2 border-fg/20 border-t-fg/80 animate-spin mx-auto" />
            <p className="text-2xl text-bold tracking-widest opacity-75">Fetching headlines &amp; scoring sentiment…</p>
          </div>
        </div>
      )}

      {/* -- Error banner --
          Pinned below the header so it never collides with the controls. */}
      {error && (
        <div className="absolute top-28 left-3 right-3 sm:top-16 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 z-30 px-4 py-2 rounded-lg text-sm text-center"
          style={{ background: "#ff000022", border: "1px solid #ff000055", color: "#f87171" }}>
          Error: {error}
        </div>
      )}

      {/* -- Map sentiment filter (desktop) --
          Compact panel pinned top-left. On mobile/tablet it lives in the
          toggle-able top stack below. */}
      {!isCompact && !loading && data.length > 0 && (
        <div
          className="absolute top-3 left-3 z-10 rounded-xl p-2"
          style={panelStyle}
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

      {/* -- Compact (mobile/tablet) top stack --
          Title, sentiment filter, and legend collapse into independently
          toggle-able panels stacked at the top of the screen. */}
      {isCompact && !loading && (
        <div className="absolute top-2 left-3 z-10 flex flex-col items-start gap-2 max-w-[min(18rem,calc(100vw-5.5rem))]">
          {/* Title */}
          <Toggle open={showTitle} onClick={() => setShowTitle((v) => !v)} label="Title" style={pillStyle} />
          {showTitle && (
            <div className="rounded-lg py-1.5 px-3" style={{ ...panelStyle, color: "rgb(var(--fg-rgb))" }}>
              <h1
                className="text-lg font-black tracking-tight"
                style={{ fontFamily: "'DM Serif Display', serif", letterSpacing: "-0.02em" }}
              >
                World News Sentiment
              </h1>
              <p className="text-[11px] opacity-60 mt-0.5 tracking-wide uppercase">
                Emotional temperature of global headlines
              </p>
            </div>
          )}

          {/* Sentiment filter */}
          {data.length > 0 && (
            <>
              <Toggle open={showFilter} onClick={() => setShowFilter((v) => !v)} label="Filter by sentiment" style={pillStyle} />
              {showFilter && (
                <div className="rounded-xl p-2 w-full" style={panelStyle}>
                  <SentimentFilter
                    value={sentimentFilter}
                    onChange={setSentimentFilter}
                    counts={sentimentCounts}
                  />
                </div>
              )}

              {/* Legend & rankings (self-toggling) */}
              <Legend
                data={data}
                lastUpdated={lastUpdated}
                fromCache={fromCache}
                compact
              />
            </>
          )}
        </div>
      )}

      {/* -- Map -- */}
      <div className="w-full h-full" onClick={() => { setSelectedCountry(null); setShowInfo(false); }}>
        <WorldMap
          byCode={byCode}
          selectedCountry={selectedCountry}
          sentimentFilter={sentimentFilter}
          onSelectCountry={(country) => {
            setSelectedCountry(country);
            setShowInfo(false);
          }}
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

      {/* -- Legend + leaderboard (desktop; compact version lives in the top stack) -- */}
      {!isCompact && !loading && data.length > 0 && (
        <Legend
          data={data}
          lastUpdated={lastUpdated}
          fromCache={fromCache}
        />
      )}

      {/* Google Font for the title */}
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&display=swap"
      />
    </div>
  );
}
