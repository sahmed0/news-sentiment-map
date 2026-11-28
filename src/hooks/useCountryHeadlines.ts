// src/hooks/useCountryHeadlines.ts
import { useCallback, useEffect, useState } from "react";
import type { Article } from "../../shared/types";

const API_URL = "/api/headlines";

// Makes re-opening a panel or scrubbing back free, without holding an old archive
// for the endpoint's whole s-maxage (same as useCountryHistory).
const CACHE_TTL_MS = 5 * 60_000;

// One shared instance so idle/loading/error results keep a stable identity.
const EMPTY_MAP: ReadonlyMap<string, Article[]> = new Map();

const cache = new Map<string, { byDate: ReadonlyMap<string, Article[]>; fetchedAt: number }>();

function readCache(key: string): ReadonlyMap<string, Article[]> | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.fetchedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.byDate;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

// Null when the body isn't a HeadlinesResponse; malformed day entries are dropped.
function toByDate(json: unknown): Map<string, Article[]> | null {
  if (!isRecord(json) || !Array.isArray(json.days)) return null;
  const byDate = new Map<string, Article[]>();
  for (const day of json.days) {
    if (isRecord(day) && typeof day.date === "string" && Array.isArray(day.articles)) {
      byDate.set(day.date, day.articles.filter(isRecord) as unknown as Article[]);
    }
  }
  return byDate;
}

export interface UseCountryHeadlines {
  status: "idle" | "loading" | "ready" | "error";
  byDate: ReadonlyMap<string, Article[]>;
  retry: () => void;
}

interface Outcome {
  key: string;
  attempt: number;
  status: "ready" | "error";
  byDate: ReadonlyMap<string, Article[]>;
}

export function useCountryHeadlines(code: string | null, enabled: boolean): UseCountryHeadlines {
  const key = code ? code.toLowerCase() : null;

  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  // A new key or re-enable starts a new attempt. Doing this during render, not in
  // an effect, means the old error never shows while the refetch runs.
  const [seen, setSeen] = useState({ key, enabled });
  if (seen.key !== key || seen.enabled !== enabled) {
    setSeen({ key, enabled });
    setAttempt((a) => a + 1);
  }

  // Record a cache hit as this attempt's outcome, so the view stays ready after
  // the entry expires.
  const cached = key && enabled ? readCache(key) : null;
  if (cached && key && (outcome?.key !== key || outcome.attempt !== attempt || outcome.status !== "ready")) {
    setOutcome({ key, attempt, status: "ready", byDate: cached });
  }

  useEffect(() => {
    if (!key || !enabled || readCache(key)) return;

    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${API_URL}?code=${key}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        const byDate = toByDate(await res.json());
        if (!byDate) throw new Error("invalid response");
        if (controller.signal.aborted) return;
        cache.set(key, { byDate, fetchedAt: Date.now() });
        setOutcome({ key, attempt, status: "ready", byDate });
      } catch (e) {
        // An abort is a country switch, Live, or an unmount; the next run owns the state.
        if (controller.signal.aborted) return;
        console.warn(
          "[useCountryHeadlines] headlines unavailable:",
          e instanceof Error ? e.message : String(e)
        );
        setOutcome({ key, attempt, status: "error", byDate: EMPTY_MAP });
      }
    })();

    return () => controller.abort();
  }, [key, enabled, attempt]);

  if (!key || !enabled) return { status: "idle", byDate: EMPTY_MAP, retry };
  if (cached) return { status: "ready", byDate: cached, retry };
  // Matching the attempt too is what shows "loading" again after a retry.
  if (outcome && outcome.key === key && outcome.attempt === attempt) {
    return { status: outcome.status, byDate: outcome.byDate, retry };
  }
  return { status: "loading", byDate: EMPTY_MAP, retry };
}
