// Vercel Serverless Function
// Serves one country's daily sentiment history from Upstash Redis. Like
// api/sentiment.ts it never touches a news provider - the rolling cron is the
// only writer. An empty series is a normal 200 error: history only starts
// accumulating once a country has been scored, and the panel handles that
// cold start itself.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { DAY_MS, HISTORY_KEY, NEWSDATA_DAY_OFFSET_MS } from "./_lib/refresh-core.js";
import { COUNTRIES } from "./_lib/sentiment-fetch.js";
import { parseHistoryPoint } from "../shared/types.js";
import type { HistoryPoint } from "../shared/types.js";
import { err } from "./_lib/logger.js";

// How many days the panel plots. The ZSET keeps a year (HISTORY_MAX_DAYS); this
// is the read window, so widening the chart never needs a storage change.
const WINDOW_DAYS = 30;

const KNOWN_CODES = new Set(COUNTRIES.map((c) => c.code));

// Day bucket -> calendar date. The bucket is the NewsData-shifted day (see
// NEWSDATA_DAY_OFFSET_MS), so adding the offset back lands inside that day.
const bucketToDate = (d: number): string =>
  new Date(d * DAY_MS + NEWSDATA_DAY_OFFSET_MS).toISOString().slice(0, 10);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const redisUrl = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;
  if (!redisUrl || !redisToken) {
    return res.status(500).json({ error: "Redis not configured" });
  }

  // Repeated query params arrive as an array; only a single value is meaningful.
  const raw = req.query?.code;
  const code = (typeof raw === "string" ? raw : "").toLowerCase();
  if (!/^[a-z]{2}$/.test(code) || !KNOWN_CODES.has(code)) {
    // Bounded to the known country set so an arbitrary param can never mint a
    // Redis key lookup we don't serve.
    res.setHeader("Cache-Control", "no-store");
    return res.status(400).json({ error: "Unknown country code" });
  }

  let members: (string | number)[];
  try {
    const { Redis } = await import("@upstash/redis");
    const redis = new Redis({ url: redisUrl, token: redisToken });
    // Members are self-describing (they carry their own day), so no withScores.
    members = await redis.zrange(HISTORY_KEY(code), -WINDOW_DAYS, -1);
  } catch (e) {
    err("History", "redis_unavailable", { message: e instanceof Error ? e.message : String(e) });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Retry-After", "30");
    return res.status(503).json({ error: "Data temporarily unavailable" });
  }

  const points: HistoryPoint[] = (members ?? [])
    .map(parseHistoryPoint)
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .map((p) => ({ date: bucketToDate(p.d), score: p.s, n: p.n }));

  // History gains at most one point a day, so an hour at the edge is cheap and
  // the long stale-while-revalidate window keeps it serving through an outage.
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
  return res.status(200).json({ code, points });
}
