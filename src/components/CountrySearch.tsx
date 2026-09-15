// src/components/CountrySearch.tsx
// The keyboard route to a country: ⌘K from anywhere, a full combobox, and a
// camera move on select. Desktop renders a centred overlay; mobile
// renders into a bottom Sheet so the on-screen keyboard pushes up under the
// results instead of covering them.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search, X } from "lucide-react";
import { buildSearchIndex, searchCountries, type SearchResult } from "../lib/search";
import { flagEmoji } from "../lib/geo";
import { sentimentBucket } from "../lib/sentiment";
import { useIsMobile } from "../hooks/useMediaQuery";
import { Sheet } from "./Sheet";
import type { CountryResult } from "../../shared/types";

const MAX_RESULTS = 8;

interface CountrySearchProps {
  byCode: Record<string, CountryResult>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (country: CountryResult) => void;
}

// Keep the announcement off-screen but readable to a screen reader.
const VISUALLY_HIDDEN: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};

// Bucket-tinted score chip, matching the headline chips in CountryPanel.
function ScoreChip({ score }: { score: number | null }) {
  const bucket = sentimentBucket(score);
  if (!bucket || typeof score !== "number") return null;
  return (
    <span
      className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold tabular-nums"
      style={{
        background: `rgb(var(--c-${bucket}-rgb)/0.12)`,
        color: `rgb(var(--c-${bucket}-rgb))`,
      }}
    >
      {score < 0 ? "−" : "+"}
      {Math.abs(score).toFixed(2)}
    </span>
  );
}

export function CountrySearch({ byCode, open, onOpenChange, onSelect }: CountrySearchProps) {
  const isMobile = useIsMobile();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const index = useMemo(() => buildSearchIndex(byCode), [byCode]);
  const results = useMemo(
    () => (query.trim() ? searchCountries(query, index, MAX_RESULTS) : []),
    [query, index],
  );

  // ⌘K / Ctrl-K from anywhere. `/` is deliberately not a shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        onOpenChange(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenChange]);

  // Open: remember what had focus, then focus the input. Close: hand focus back
  // to the element that opened the search and blank the query so the next open
  // starts clean.
  useEffect(() => {
    if (!open) {
      restoreRef.current?.focus();
      const id = setTimeout(() => {
        setQuery("");
        setActiveIndex(0);
      }, 0);
      return () => clearTimeout(id);
    }
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const id = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [open]);

  const choose = (r: SearchResult | undefined) => {
    if (!r || !r.hasData) return; // uncovered rows are not selectable
    const country = byCode[r.code.toUpperCase()];
    if (!country) return;
    onOpenChange(false);
    onSelect(country);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        onOpenChange(false);
        break;
      case "ArrowDown":
        e.preventDefault();
        if (results.length) setActiveIndex((i) => (i + 1) % results.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (results.length) setActiveIndex((i) => (i - 1 + results.length) % results.length);
        break;
      case "Enter":
        e.preventDefault();
        choose(results[activeIndex]);
        break;
      case "Tab": {
        // Trap Tab / Shift-Tab inside the panel while it is open.
        const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])',
        );
        if (!focusables || focusables.length === 0) break;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
        break;
      }
    }
  };

  const announce = query.trim()
    ? results.length
      ? `${results.length} result${results.length === 1 ? "" : "s"}`
      : "No countries found"
    : "";

  const inner = (
    <>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={results.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={results[activeIndex] ? optionId(activeIndex) : undefined}
        aria-label="Search for a country"
        placeholder="Search for a country…"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIndex(0); // a change event, highlight the top row
        }}
        className="w-full rounded-lg px-3 py-2.5 text-base sm:text-sm outline-none"
        style={{
          background: "rgb(var(--fg-rgb) / 0.06)",
          border: "1px solid rgb(var(--fg-rgb) / 0.14)",
          color: "rgb(var(--fg-rgb))",
        }}
      />

      <ul
        id={listId}
        role="listbox"
        aria-label="Countries"
        className="mt-2 max-h-[min(50vh,22rem)] overflow-y-auto"
      >
        {results.map((r, i) => {
          const country = r.hasData ? byCode[r.code.toUpperCase()] : undefined;
          const active = i === activeIndex;
          return (
            <li
              key={r.code}
              id={optionId(i)}
              role="option"
              aria-selected={active}
              aria-disabled={r.hasData ? undefined : true}
              onClick={r.hasData ? () => choose(r) : undefined}
              onMouseMove={() => setActiveIndex(i)}
              className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm"
              style={{
                cursor: r.hasData ? "pointer" : "default",
                opacity: r.hasData ? 1 : 0.45,
                background: active ? "rgb(var(--fg-rgb) / 0.08)" : undefined,
              }}
            >
              <span aria-hidden="true" className="text-base leading-none">
                {flagEmoji(r.code)}
              </span>
              <span className="truncate">{r.name}</span>
              {r.hasData ? (
                <ScoreChip score={country?.score ?? null} />
              ) : (
                <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide opacity-70">
                  No data
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <div aria-live="polite" role="status" style={VISUALLY_HIDDEN}>
        {announce}
      </div>
    </>
  );

  if (isMobile) {
    return (
      <Sheet open={open} onClose={() => onOpenChange(false)} title="Find a country">
        <div ref={panelRef} onKeyDown={onKeyDown}>
          {inner}
        </div>
      </Sheet>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="country-search"
          className="absolute inset-0 z-40 flex items-start justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div
            className="absolute inset-0"
            style={{ background: "rgb(0 0 0 / 0.4)" }}
            onClick={() => onOpenChange(false)}
          />
          <motion.div
            ref={panelRef}
            onKeyDown={onKeyDown}
            role="dialog"
            aria-modal="true"
            aria-label="Find a country"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="relative mt-[20vh] w-[min(28rem,calc(100vw-2rem))] rounded-2xl p-4"
            style={{
              background: "rgb(var(--panel-rgb) / 0.92)",
              backdropFilter: "blur(16px)",
              border: "1px solid rgb(var(--fg-rgb) / 0.1)",
            }}
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest opacity-70">
                <Search size={13} /> Find a country
              </span>
              <button
                onClick={() => onOpenChange(false)}
                className="-mr-1 flex h-7 w-7 items-center justify-center rounded-full text-gray-400"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            {inner}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
