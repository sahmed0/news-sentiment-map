// api/sentiment.js - Vercel Serverless Function (read-only)
// Serves the pre-aggregated world sentiment from Upstash Redis. It NEVER fetches
// from NewsData.io - the rolling cron (api/cron/refresh.js) is the only writer, so
// user traffic can never spend NewsData credits or trip the rate limit. On a cold
// cache it returns 503 "warming"; the client retries 503 automatically.

import { AGG_KEY } from "./_lib/refresh-core.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const redisUrl = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;
  if (!redisUrl || !redisToken) {
    return res.status(500).json({ error: "Redis not configured" });
  }

  const { Redis } = await import("@upstash/redis");
  const redis = new Redis({ url: redisUrl, token: redisToken });

  const data = await redis.get(AGG_KEY);
  if (!data || data.length === 0) {
    res.setHeader("Retry-After", "15");
    return res.status(503).json({ error: "Data warming up, retry shortly" });
  }

  // Under staggered refresh each country carries its own fetchedAt; surface the
  // oldest so the UI can show the true age of the map's data.
  let oldestFetchedAt = null;
  for (const c of data) {
    if (c.fetchedAt && (!oldestFetchedAt || c.fetchedAt < oldestFetchedAt)) {
      oldestFetchedAt = c.fetchedAt;
    }
  }

  return res.status(200).json({ data, cached: true, oldestFetchedAt });
}
