// api/sentiment.ts - Vercel Serverless Function (read-only)
// Serves the pre-aggregated world sentiment from Upstash Redis. It NEVER fetches
// from NewsData.io - the rolling cron (api/cron/refresh.ts) is the only writer, so
// user traffic can never spend NewsData credits or trip the rate limit. On a cold
// cache it returns 503 "warming"; the client retries 503 automatically.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AGG_KEY } from "./_lib/refresh-core.js";
import { err } from "./_lib/logger.js";

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const redisUrl = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;
  if (!redisUrl || !redisToken) {
    return res.status(500).json({ error: "Redis not configured" });
  }

  let data: unknown;
  try {
    const { Redis } = await import("@upstash/redis");
    const redis = new Redis({ url: redisUrl, token: redisToken });
    data = await redis.get(AGG_KEY);
  } catch (e) {
    // An Upstash outage degrades to a retryable 503 instead of an unhandled
    // rejection; no-store so the edge never pins the failure for the whole
    // s-maxage window once Redis comes back.
    err("Sentiment", "redis_unavailable", { message: e instanceof Error ? e.message : String(e) });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Retry-After", "30");
    return res.status(503).json({ error: "Data temporarily unavailable" });
  }

  if (!Array.isArray(data) || data.length === 0) {
    // The warming state is transient - caching it at the edge
    // would keep serving "no data" long after the first tick has populated it.
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Retry-After", "15");
    return res.status(503).json({ error: "Data warming up, retry shortly" });
  }

  // The aggregate only changes once an hour, so a 5-minute edge TTL absorbs virtually all traffic, and the long
  // stale-while-revalidate window keeps the map populated through a Redis outage.
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
  return res.status(200).json({ data, cached: true });
}
