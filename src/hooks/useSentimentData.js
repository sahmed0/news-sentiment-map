// src/hooks/useSentimentData.js
import { useState, useEffect, useCallback } from "react";

const API_URL = "/api/sentiment";

export function useSentimentData() {
  const [data, setData] = useState([]); // array of { code, name, score, articles }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
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
      const json = await res.json();
      setData(json.data || []);
      setFromCache(json.cached ?? false);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err.message);
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
  const byCode = data.reduce((acc, country) => {
    acc[country.code.toUpperCase()] = country;
    return acc;
  }, {});

  return { data, byCode, loading, error, lastUpdated, fromCache, refetch: fetchData };
}