// src/components/CountryPanel.tsx
import { useState } from "react";
import { motion, AnimatePresence, useDragControls, type MotionProps, type PanInfo } from "framer-motion";
import { sentimentBucket, bucketColor, BUCKET_COLOR } from "../lib/sentiment";
import { safeHttpUrl } from "../lib/url";
import { SentimentFilter } from "./SentimentFilter";
import { Sparkline } from "./Sparkline";
import { computeDelta7d } from "../lib/history";
import { useIsMobile } from "../hooks/useMediaQuery";
import { useCountryHistory } from "../hooks/useCountryHistory";
import { X } from 'lucide-react';
import type { Article, CountryResult, FilterKey } from "../../shared/types";

// Below MIN_HISTORY_POINTS there are not enough data points
// to justify showing a trend chart, so the chart stays hidden
// and the panel explains why.
const MIN_HISTORY_POINTS = 3;

// Show the English translation only when it exists and actually differs from
// the original (Azure echoes English text back unchanged for English headlines).
function showTranslation(article: Article) {
  const t = article.translatedTitle;
  if (!t || !t.trim()) return false;
  return t.trim().toLowerCase() !== (article.title ?? "").trim().toLowerCase();
}

// Small colored sentiment chip for an individual headline score.
function ArticleScore({ score }: { score: number | null }) {
  const bucket = sentimentBucket(score);
  // sentimentBucket's null check doesn't narrow `score` itself, so re-check the
  // type before .toFixed - both are true together (bucket is null iff not a number).
  if (!bucket || typeof score !== "number") return null;
  return (
    <span
      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold tabular-nums"
      style={{
        background: `rgb(var(--c-${bucket}-rgb)/0.1)`,
        color: `rgb(var(--c-${bucket}-rgb))`,
      }}
      title="Headline sentiment"
    >
      {score >= 0 ? "+" : ""}
      {score.toFixed(2)}
    </span>
  );
}

// Headlines list with a sentiment filter. Lives under the key={country.code}
// element, so its filter state resets automatically when the country changes.
function Headlines({ articles }: { articles: Article[] }) {
  const [filter, setFilter] = useState<FilterKey>("all");

  const counts = articles.reduce<Record<FilterKey, number>>(
    (acc, a) => {
      const bucket = sentimentBucket(a.score);
      if (bucket) acc[bucket] += 1;
      acc.all += 1;
      return acc;
    },
    { all: 0, positive: 0, neutral: 0, negative: 0 }
  );

  const visible =
    filter === "all"
      ? articles
      : articles.filter((a) => sentimentBucket(a.score) === filter);

  return (
    <div className="flex-1 overflow-y-auto px-5 pb-5">
      <p className="text-xs uppercase tracking-widest opacity-40 light:opacity-65 mb-2">Headlines</p>

      {/* Sentiment filter */}
      <SentimentFilter value={filter} onChange={setFilter} counts={counts} className="mb-3" />

      {visible.length ? (
        <ul className="space-y-5">
          {visible.map((article, i) => {
            const href = safeHttpUrl(article.url);
            return (
            <motion.li
              key={article.url ?? i}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.06 }}
            >
              <div className="flex items-start gap-2">
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-sm leading-snug text-fg/95 light:text-black hover:text-fg transition-colors"
                  >
                    {article.translatedTitle || article.title}
                  </a>
                ) : (
                  <span className="block text-sm leading-snug text-fg/95 light:text-black">
                    {article.translatedTitle || article.title}
                  </span>
                )}
                <ArticleScore score={article.score} />
              </div>
              {showTranslation(article) && (
                <p className="text-xs leading-snug text-fg/65 light:text-black/90 italic mt-0.5">
                  Original: {article.title}
                </p>
              )}
              <p className="text-xs text-fg/50 light:text-black/70 mt-0.5">
              Published {" "}
                {article.publishedAt
                  ? new Date(article.publishedAt).toLocaleDateString("en-GB", {
                    weekday: "long",
                    day: "numeric",
                    month: "long",
                    year: "numeric"
                    })
                  : ""}
              </p>
            </motion.li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-fg/50">
          {articles.length ? "No headlines match this filter." : "No headlines available."}
        </p>
      )}
    </div>
  );
}

function SentimentBar({ score }: { score: number }) {
  // score in [-1, 1]
  const pct = ((score + 1) / 2) * 100; // map to [0, 100]
  // score is always numeric here, so bucketColor never returns null - the
  // fallback only keeps the type a plain string.
  const color = bucketColor(score) ?? BUCKET_COLOR.neutral;

  const label =
    score > 0.5
      ? "Very Positive"
      : score > 0.1
      ? "Positive"
      : score > -0.1
      ? "Neutral"
      : score > -0.5
      ? "Negative"
      : "Very Negative";

  return (
    <div className="mb-5">
      <div className="flex justify-between items-center mb-1">
        <span className="text-xs uppercase tracking-widest font-semibold opacity-50 light:opacity-70">
          Sentiment
        </span>
        <span
          className="text-sm font-bold"
          style={{ color }}
        >
          {label} ({score >= 0 ? "+" : ""}{score.toFixed(2)})
        </span>
      </div>
      <div className="h-2 rounded-full bg-fg/10 overflow-hidden">
        <motion.div
          className="h-full rounded-full"
          style={{ background: color }}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.6, ease: "easeOut" }}
        />
      </div>
    </div>
  );
}

// Direction chip for 7-day change. A move smaller than 0.005 rounds to 0.00
// at two decimals, so it gets a neutral dot rather than an arrow
// that would claim a direction the number doesn't show.
function DeltaChip({ delta }: { delta: number }) {
  const flat = Math.abs(delta) < 0.005;
  const arrow = flat ? "·" : delta > 0 ? "▲" : "▼";
  const sign = flat ? "" : delta > 0 ? "+" : "−";
  const color = flat
    ? "rgb(var(--fg-rgb) / 0.5)"
    : delta > 0
    ? BUCKET_COLOR.positive
    : BUCKET_COLOR.negative;

  return (
    <span
      className="text-[10px] font-bold tabular-nums"
      style={{ color }}
      title="Change since a week ago"
    >
      7d {arrow} {sign}
      {Math.abs(delta).toFixed(2)}
    </span>
  );
}

// Daily history for one country. It arrives after the panel is already on
// screen, so nothing renders until it resolves.
function HistorySection({ code }: { code: string }) {
  const { points, loading } = useCountryHistory(code);
  if (loading) return null;

  const enough = points.length >= MIN_HISTORY_POINTS;
  const delta = enough ? computeDelta7d(points) : null;

  return (
    <div className="px-5 pb-4 shrink-0">
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-xs uppercase tracking-widest opacity-40 light:opacity-65">
          30-day trend
        </p>
        {delta !== null && <DeltaChip delta={delta} />}
      </div>
      {enough ? (
        <Sparkline points={points} />
      ) : (
        <p className="text-xs text-fg/40 light:text-black/50">
          History accumulates daily — check back soon.
        </p>
      )}
    </div>
  );
}

interface CountryPanelProps {
  country: CountryResult | null;
  onClose: () => void;
}

export function CountryPanel({ country, onClose }: CountryPanelProps) {
  const isMobile = useIsMobile();
  const dragControls = useDragControls();

  // Mobile: a bottom sheet that slides up and can be flicked down to dismiss.
  // Drag is initiated only from the grab handle (see below) so the headlines
  // list scrolls normally. ≥md: a side panel that slides in from the right.
  const motionProps: MotionProps = isMobile
    ? {
        initial: { y: "100%", opacity: 0 },
        animate: { y: 0, opacity: 1 },
        exit: { y: "100%", opacity: 0 },
        drag: "y",
        dragListener: false,
        dragControls,
        dragConstraints: { top: 0, bottom: 0 },
        dragElastic: { top: 0, bottom: 0.6 },
        onDragEnd: (_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
          if (info.offset.y > 120 || info.velocity.y > 500) onClose();
        },
      }
    : {
        initial: { x: "100%", opacity: 0 },
        animate: { x: 0, opacity: 1 },
        exit: { x: "100%", opacity: 0 },
      };

  return (
    <AnimatePresence>
      {country && (
        <motion.div
          key={country.code}
          {...motionProps}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className={`absolute z-20 flex flex-col ${
            isMobile
              ? "inset-x-0 bottom-0 h-[85dvh] max-h-[85dvh] rounded-t-2xl pb-[env(safe-area-inset-bottom)]"
              : "top-0 right-0 h-full w-80"
          }`}
          style={{
            background: "rgb(var(--panel-rgb) / 0.85)",
            backdropFilter: "blur(16px)",
            border: "1px solid rgb(var(--fg-rgb) / 0.08)",
            ...(isMobile ? {} : { borderWidth: "0 0 0 1px" }),
          }}
        >
          {/* Mobile grab handle - drag target for swipe-to-dismiss */}
          <div
            className="md:hidden flex justify-center pt-3 pb-2 shrink-0 cursor-grab active:cursor-grabbing touch-none"
            onPointerDown={(e) => dragControls.start(e)}
          >
            <div className="h-1 w-10 rounded-full bg-fg/25" />
          </div>

          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-3 sm:pt-5 pb-3 border-b border-fg/8 shrink-0">
            <div>
              <div className="flex items-center gap-2 mb-0.5">
                <p className="text-xs uppercase tracking-widest opacity-60 light:opacity-65">
                  Country
                </p>
                <span
                  className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                    country.highPriority
                      ? "bg-blue-500/15 text-blue-400 light:bg-blue-500/20 light:text-blue-600"
                      : "bg-fg/8 text-fg/40 light:text-black/40"
                  }`}
                >
                  {country.highPriority ? "High Priority" : "Low Priority"}
                </span>
              </div>
              <h2 className="text-lg font-bold tracking-tight">
                {country.name}
              </h2>
            </div>
            <button
              onClick={onClose}
              className="w-9 h-9 shrink-0 -mr-1.5 rounded-full flex items-center justify-center text-gray-400 transition-colors text-xl leading-none"
              aria-label="Close panel"
            >
              <X />
            </button>
          </div>

          {/* Sentiment score - only shown for scored countries (the map only
              opens the panel when a country has a numeric score). */}
          {typeof country.score === "number" && (
            <div className="px-5 pt-4">
              <SentimentBar score={country.score} />
            </div>
          )}

          {/* Daily sentiment history - absent until the country has been
              scored on enough days (see HistorySection). */}
          <HistorySection code={country.code} />

          {/* Headlines + sentiment filter */}
          <Headlines articles={country.articles ?? []} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}