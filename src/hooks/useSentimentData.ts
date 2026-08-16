// src/hooks/useSentimentData.ts
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { CountryResult, SentimentResponse } from "../../shared/types";

const API_URL = "/api/sentiment";

// The API answers 503 while the serverless function and Upstash are cold. We
// retry a bounded number of times rather than showing an error the user can do
// nothing about - the data is usually there by the second or third attempt.
const MAX_RETRIES = 3;
const DEFAULT_RETRY_SECONDS = 5;
const MIN_RETRY_SECONDS = 1;
const MAX_RETRY_SECONDS = 30;

// A visible tab whose data is older than this refetches in the background. The
// threshold deliberately matches the `s-maxage=300` edge TTL on /api/sentiment
// (api/sentiment.ts) - a shorter one would only ever hit the same cached body.
// If one changes, change both.
const STALE_AFTER_MS = 5 * 60_000;

// Progress of the cold-start retry loop, surfaced so the UI can explain the
// wait instead of leaving the user on a blank map.
export interface WarmingState {
  attempt: number;
  maxAttempts: number;
  delaySeconds: number;
}

// Shape returned by the hook.
export interface UseSentimentData {
  data: CountryResult[];
  byCode: Record<string, CountryResult>;
  loading: boolean;
  warming: WarmingState | null;
  error: string | null;
  lastUpdated: Date | null;
  fromCache: boolean;
  refetch: () => void;
}

// Retry-After is provider-controlled, so treat it as untrusted: fall back when
// it is missing or unparseable and clamp so a bogus value can't strand the UI.
function retryDelaySeconds(header: string | null): number {
  const parsed = parseInt(header ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_RETRY_SECONDS;
  return Math.min(Math.max(parsed, MIN_RETRY_SECONDS), MAX_RETRY_SECONDS);
}

export function useSentimentData(): UseSentimentData {
  const [data, setData] = useState<CountryResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [warming, setWarming] = useState<WarmingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [fromCache, setFromCache] = useState(false);

  // Refs, not state: these must survive re-renders without causing them, and
  // the cleanup path needs to reach the *current* controller/timer.
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFetchedAtRef = useRef(0);

  // Named function expression so the 503 retry can recurse via its own internal
  // name (`attempt`) instead of the outer `fetchData` binding, which isn't yet
  // initialized while the useCallback factory runs.
  const fetchData = useCallback(async function attempt(retryCount = 0, background = false) {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // A background refresh must never blank the map or clear a visible error:
    // the user keeps looking at the previous data until new data arrives.
    if (!background) {
      setLoading(true);
      setError(null);
    }

    try {
      const res = await fetch(API_URL, { signal: controller.signal });

      if (res.status === 503 && retryCount < MAX_RETRIES) {
        const delaySeconds = retryDelaySeconds(res.headers.get("Retry-After"));
        setWarming({ attempt: retryCount + 1, maxAttempts: MAX_RETRIES, delaySeconds });
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          void attempt(retryCount + 1, background);
        }, delaySeconds * 1000);
        // Deliberately leaves `loading` true: clearing it between retries is
        // what used to flash an empty grey map during cold starts.
        return;
      }

      if (res.status === 503) {
        setWarming(null);
        if (!background) {
          setError("The data service is still warming up — try again shortly.");
          setLoading(false);
        }
        return;
      }

      if (!res.ok) throw new Error(`API error: ${res.status}`);

      const json: SentimentResponse = await res.json();
      setData(json.data || []);
      setFromCache(json.cached ?? false);
      setLastUpdated(new Date());
      setWarming(null);
      setLoading(false);
      lastFetchedAtRef.current = Date.now();
    } catch (err) {
      // An abort is our own cleanup or a superseding fetch - not a failure.
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      if (background) {
        console.warn("[useSentimentData] background refresh failed:", message);
        return;
      }
      setError(message);
      setWarming(null);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
    return () => {
      abortRef.current?.abort();
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [fetchData]);

  // A tab can sit in the background for hours. Refresh on the way back in
  // rather than polling, which would keep hitting the API for nobody's benefit.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastFetchedAtRef.current <= STALE_AFTER_MS) return;
      void fetchData(0, true);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [fetchData]);

  // Returns a lookup map keyed by UPPERCASE alpha-2 to match the map's
  // NUMERIC_TO_ALPHA2 table: { "US": { score, articles, name }, ... }.
  // API codes are lowercase ("us"), so normalize here or the map lookup misses.
  // Memoized because WorldMap's memoized path layer re-renders on any new
  // object identity here.
  const byCode = useMemo(
    () =>
      data.reduce<Record<string, CountryResult>>((acc, country) => {
        acc[country.code.toUpperCase()] = country;
        return acc;
      }, {}),
    [data]
  );

  // Wrapped rather than exposing fetchData directly: as an onClick handler it
  // would otherwise receive the click event as `retryCount`.
  const refetch = useCallback(() => {
    void fetchData(0, false);
  }, [fetchData]);

  return { data, byCode, loading, warming, error, lastUpdated, fromCache, refetch };
}
