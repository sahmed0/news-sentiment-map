// api/world-history.ts - Vercel Serverless Function (read-only)
// Serves every country's last 30 daily sentiment scores in one payload, for the
// timeline scrubber. Like api/sentiment.ts it never touches a news provider - the
// rolling cron maintains sentiment:history:world and this endpoint only GETs it.
// A cold or re-warming key is a retryable 503, mirroring /api/sentiment so the
// client's existing retry logic works unchanged.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { WORLD_HISTORY_KEY } from "./_lib/refresh-core.js";
import { parseWorldHistory } from "../shared/types.js";
import { err } from "./_lib/logger.js";

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const redisUrl = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;
  if (!redisUrl || !redisToken) {
    return res.status(500).json({ error: "Redis not configured" });
  }

  let raw: unknown;
  try {
    const { Redis } = await import("@upstash/redis");
    const redis = new Redis({ url: redisUrl, token: redisToken });
    raw = await redis.get(WORLD_HISTORY_KEY);
  } catch (e) {
    // An Upstash outage degrades to a retryable 503 instead of an unhandled
    // rejection; no-store so the edge never pins the failure for the whole
    // s-maxage window once Redis comes back.
    err("WorldHistory", "redis_unavailable", { message: e instanceof Error ? e.message : String(e) });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Retry-After", "30");
    return res.status(503).json({ error: "Data temporarily unavailable" });
  }

  const history = parseWorldHistory(raw);
  if (!history) {
    // Warming (or a malformed key the next rebuild will heal). Transient, so it
    // must never be cached at the edge or "no timeline" outlives the fix.
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Retry-After", "15");
    return res.status(503).json({ error: "Data warming up, retry shortly" });
  }

  // Rebuilt or patched once an hour, so a 30-minute edge TTL absorbs virtually
  // all traffic, and the long stale-while-revalidate window keeps the scrubber
  // working through a Redis outage.
  res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=86400");
  return res.status(200).json(history);
}
