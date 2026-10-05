// src/components/TimeScrubber.tsx
// A 30-day timeline that replays sentiment across the whole map.
import { useEffect, useState } from "react";
import { Play, Pause } from "lucide-react";
import { formatShortDate, formatLongDate } from "../lib/history";

// Autoplay advances one day at this cadence: ~9s to sweep a 30-day window,
// slow enough to read each frame and fast enough to hold attention.
const PLAY_STEP_MS = 300;

interface TimeScrubberProps {
  days: string[];
  value: number;
  // Fired continuously while dragging: paint the map imperatively, no state.
  onPreview: (i: number) => void;
  // Fired on release / keyboard commit / autoplay step: hand the day to React.
  onCommit: (i: number) => void;
  className?: string;
}

export function TimeScrubber({ days, value, onPreview, onCommit, className }: TimeScrubberProps) {
  const last = days.length - 1;
  const [pos, setPos] = useState(value);
  const [syncedValue, setSyncedValue] = useState(value);
  if (value !== syncedValue) {
    setSyncedValue(value);
    setPos(value);
  }

  // Playback halts (without clearing the request) once it reaches the end, so a
  // single Play press from there rewinds and starts over.
  const [playRequested, setPlayRequested] = useState(false);
  const atEnd = pos >= last;
  const playing = playRequested && !atEnd;

  useEffect(() => {
    if (!playing) return;
    const id = setTimeout(() => onCommit(pos + 1), PLAY_STEP_MS);
    // Clear on every step, on pause and on unmount - a leaked timer here would
    // repaint the map forever.
    return () => clearTimeout(id);
  }, [playing, pos, onCommit]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const i = Number(e.target.value);
    setPos(i);
    onPreview(i);
  };

  const commit = () => onCommit(pos);

  const togglePlay = () => {
    if (playing) {
      setPlayRequested(false);
      return;
    }
    if (atEnd) onCommit(0); // rewind; the parent pushes value=0 back down
    setPlayRequested(true);
  };

  const dateKey = days[pos] ?? "";

  return (
    <div
      className={`flex items-center gap-3 rounded-full px-3 py-2 ${className ?? ""}`}
      style={{
        background: "rgb(var(--panel-rgb) / 0.85)",
        backdropFilter: "blur(12px)",
        border: "1px solid rgb(var(--fg-rgb) / 0.08)",
      }}
    >
      <button
        type="button"
        onClick={togglePlay}
        className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center transition-colors"
        style={{ background: "rgb(var(--fg-rgb) / 0.08)", color: "rgb(var(--fg-rgb) / 0.8)" }}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>

      <input
        type="range"
        min={0}
        max={last}
        step={1}
        value={pos}
        onChange={handleChange}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        aria-label="Day"
        aria-valuetext={dateKey ? formatLongDate(dateKey) : undefined}
        className="flex-1 min-w-0 cursor-pointer"
        style={{ accentColor: "rgb(var(--fg-rgb))" }}
      />

      <span className="shrink-0 text-xs tabular-nums opacity-70 w-14 text-right">
        {dateKey ? formatShortDate(dateKey) : ""}
      </span>

      <button
        type="button"
        onClick={() => onCommit(last)}
        disabled={pos === last}
        className="shrink-0 text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-1 transition-opacity disabled:opacity-40"
        style={{ background: "rgb(var(--fg-rgb) / 0.08)", color: "rgb(var(--fg-rgb) / 0.8)" }}
      >
        Live
      </button>
    </div>
  );
}
