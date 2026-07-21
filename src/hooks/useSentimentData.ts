// src/hooks/useSentimentData.ts
import { useState, useEffect, useCallback } from "react";
import type { CountryResult, SentimentResponse } from "../../shared/types";

const API_URL = "/api/sentiment";

// Shape returned by the hook. Need to extend this (warming state, memoized byCode).
export interface UseSentimentData {
  data: CountryResult[];
  byCode: Record<string, CountryResult>;
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  fromCache: boolean;
  refetch: () => void;
}

export function useSentimentData(): UseSentimentData {
  const [data, setData] = useState<CountryResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [fromCache, setFromCache] = useState(false);

  // Named function expression so the 503 retry can recurse via its own internal
  // name (`attempt`) instead of the outer `fetchData` binding, which isn't yet
  // initialized while the useCallback factory runs.
  const fetchData = useCallback(async function attempt(retryCount = 0) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(API_URL);
      if (res.status === 503 && retryCount < 3) {
        const retryAfter = parseInt(res.headers.get("Retry-After") || "10", 10);
        setTimeout(() => attempt(retryCount + 1), retryAfter * 1000);
        return;
      }
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const json: SentimentResponse = await res.json();
      setData(json.data || []);
      setFromCache(json.cached ?? false);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Returns a lookup map keyed by UPPERCASE alpha-2 to match the map's
  // NUMERIC_TO_ALPHA2 table: { "US": { score, articles, name }, ... }.
  // API codes are lowercase ("us"), so normalize here or the map lookup misses.
  const byCode = data.reduce<Record<string, CountryResult>>((acc, country) => {
    acc[country.code.toUpperCase()] = country;
    return acc;
  }, {});

  return { data, byCode, loading, error, lastUpdated, fromCache, refetch: fetchData };
}