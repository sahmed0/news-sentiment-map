// src/hooks/useCountryHistory.ts
import { useEffect, useState } from "react";
import type { HistoryPoint, HistoryResponse } from "../../shared/types";

const API_URL = "/api/history";

// A country's series changes at most once a day, so re-opening a panel the user
// just closed should cost nothing. Deliberately shorter than the endpoint's own
// s-maxage=3600 (api/history.ts): this cache exists to make panel toggling free,
// not to pin a stale series for a full hour.
const CACHE_TTL_MS = 5 * 60_000;

const cache = new Map<string, { points: HistoryPoint[]; fetchedAt: number }>();

function readCache(code: string): HistoryPoint[] | null {
  const hit = cache.get(code);
  if (!hit) return null;
  if (Date.now() - hit.fetchedAt > CACHE_TTL_MS) {
    cache.delete(code);
    return null;
  }
  return hit.points;
}

export interface UseCountryHistory {
  points: HistoryPoint[];
  loading: boolean;
}

export function useCountryHistory(code: string | null): UseCountryHistory {
  // The API keys countries in lowercase; the map hands selections around in
  // uppercase, so normalise once here rather than at every call site.
  const key = code ? code.toLowerCase() : null;

  // The only state is the outcome of a completed request, tagged with the
  // country it belongs to. Everything the caller sees is derived below, so
  // switching countries needs no state reset - a late response for the previous
  // country simply stops matching.
  const [result, setResult] = useState<{ key: string; points: HistoryPoint[] } | null>(null);

  useEffect(() => {
    // Nothing selected, or a warm cache entry already answers the question.
    if (!key || readCache(key)) return;

    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${API_URL}?code=${key}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        const json: HistoryResponse = await res.json();
        const points = Array.isArray(json?.points) ? json.points : [];
        cache.set(key, { points, fetchedAt: Date.now() });
        setResult({ key, points });
      } catch (e) {
        // An abort is a country switch or an unmount - the next effect run owns
        // the state from here, so touching it would be a stale write.
        if (controller.signal.aborted) return;
        // History is not a core feature so a failure hides the section,
        // it never becomes an error the user is asked to do something about.
        console.warn(
          "[useCountryHistory] history unavailable:",
          e instanceof Error ? e.message : String(e)
        );
        setResult({ key, points: [] });
      }
    })();

    return () => controller.abort();
  }, [key]);

  if (!key) return { points: [], loading: false };

  // Cache first so a re-open paints on the first render. `result` then covers
  // the case where the entry expires while the panel is still open.
  const cached = readCache(key);
  if (cached) return { points: cached, loading: false };
  if (result && result.key === key) return { points: result.points, loading: false };
  return { points: [], loading: true };
}
