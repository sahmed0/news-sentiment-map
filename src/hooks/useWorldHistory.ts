// src/hooks/useWorldHistory.ts
import { useEffect, useMemo, useState } from "react";
import { parseWorldHistory, type WorldHistory } from "../../shared/types";
import { resolveWorldHistory, type ResolvedPoint } from "../lib/worldHistory";

const API_URL = "/api/world-history";

// Reused for the pre-load and every failure so `history` is never null and
// callers can index `days`/`scores` unconditionally.
const EMPTY: WorldHistory = { days: [], scores: {} };

export interface UseWorldHistory {
  history: WorldHistory;
  resolved: Record<string, ResolvedPoint[]>;
  loading: boolean;
  error: boolean;
}

// Fetches the bulk history once on mount, in parallel with useSentimentData -
// the payload is ~10 KB gzipped and both the scrubber and the summary stat need
// it as soon as the map is up. The timeline is not a core feature, so a failure
// is a console.warn and an empty result: the map still works without it.
export function useWorldHistory(): UseWorldHistory {
  const [history, setHistory] = useState<WorldHistory>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(API_URL, { signal: controller.signal });
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        const parsed = parseWorldHistory(await res.json());
        if (!parsed) throw new Error("malformed world-history payload");
        setHistory(parsed);
        setLoading(false);
      } catch (e) {
        // An abort is our own unmount cleanup, not a failure.
        if (controller.signal.aborted) return;
        console.warn(
          "[useWorldHistory] history unavailable:",
          e instanceof Error ? e.message : String(e),
        );
        setHistory(EMPTY);
        setError(true);
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  const resolved = useMemo(() => resolveWorldHistory(history), [history]);

  return { history, resolved, loading, error };
}
