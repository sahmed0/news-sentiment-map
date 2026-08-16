// api/health.ts - Vercel Serverless Function (read-only)
// Answers "is the pipeline alive?" from what the rolling cron leaves in Redis:
// the last tick summary, each provider's credit usage today, and how many
// countries have fallen behind their refresh cadence. Public and unauthenticated
// on purpose - none of it is sensitive.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  FRESH_KEY,
  GN_CREDIT_DAY_KEY,
  GNEWS_MAX_PER_DAY,
  LOW_PRIORITY_DAYS,
  ND_CREDIT_DAY_KEY,
  NEWSDATA_MAX_PER_DAY,
  TICKS_KEY,
  dayId,
  gnDayId,
} from "./_lib/refresh-core.js";
import { COUNTRIES, HIGH_PRIORITY_CODES } from "./_lib/sentiment-fetch.js";
import { parseTickSummary } from "../shared/types.js";
import { err } from "./_lib/logger.js";

const HOUR_MS = 60 * 60 * 1000;
// The cron fires hourly, so a tick under two hours old means the schedule is
// running. Six hours is several missed ticks in a row - by then the map's oldest
// countries are visibly stale, so the endpoint says so out loud (503).
const OK_MAX_AGE_MS = 2 * HOUR_MS;
const DEGRADED_MAX_AGE_MS = 6 * HOUR_MS;
// A country is stale once it has missed a full extra cycle: twice its cadence.
// Both derive from the same constants the scheduler uses, so a cadence change
// can't leave this check measuring the old one.
const HIGH_PRIORITY_STALE_MS = 2 * 24 * HOUR_MS;
const LOW_PRIORITY_STALE_MS = 2 * LOW_PRIORITY_DAYS * 24 * HOUR_MS;

const toInt = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const redisUrl = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;
  if (!redisUrl || !redisToken) {
    return res.status(500).json({ error: "Redis not configured" });
  }

  const now = new Date();
  let ticks: unknown[];
  let freshPairs: unknown[];
  let ndUsed: unknown;
  let gnUsed: unknown;
  try {
    const { Redis } = await import("@upstash/redis");
    const redis = new Redis({ url: redisUrl, token: redisToken });
    [ticks, freshPairs, ndUsed, gnUsed] = await Promise.all([
      redis.lrange(TICKS_KEY, 0, 0), // newest tick only
      redis.zrange(FRESH_KEY, 0, -1, { withScores: true }),
      redis.get(ND_CREDIT_DAY_KEY(dayId(now))),
      redis.get(GN_CREDIT_DAY_KEY(gnDayId(now))),
    ]);
  } catch (e) {
    // If Redis is unreachable the pipeline is unobservable, which for a health
    // check is itself the answer - report down rather than 500ing silently.
    err("Health", "redis_unavailable", { message: e instanceof Error ? e.message : String(e) });
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({ status: "down", error: "Data temporarily unavailable" });
  }

  const lastTick = parseTickSummary(ticks?.[0]);
  const ageMs = lastTick ? now.getTime() - new Date(lastTick.ts).getTime() : null;
  const minutesSinceLastTick = ageMs === null ? null : Math.max(0, Math.floor(ageMs / 60000));

  // Absent from the freshness ZSET = never successfully attempted, which counts
  // as stale: on a cold deployment that is every country, and the count should
  // say so.
  const lastFetch = new Map<string, number>();
  for (let i = 0; i + 1 < (freshPairs?.length ?? 0); i += 2) {
    lastFetch.set(String(freshPairs[i]), Number(freshPairs[i + 1]));
  }
  const staleCount = COUNTRIES.filter((c) => {
    const last = lastFetch.get(c.code);
    if (last === undefined) return true;
    const limit = HIGH_PRIORITY_CODES.has(c.code) ? HIGH_PRIORITY_STALE_MS : LOW_PRIORITY_STALE_MS;
    return now.getTime() - last > limit;
  }).length;

  // A tick that ran but threw is as bad as a late one: the data didn't move.
  const status =
    ageMs === null || ageMs > DEGRADED_MAX_AGE_MS
      ? "down"
      : ageMs > OK_MAX_AGE_MS || (lastTick && lastTick.error)
        ? "degraded"
        : "ok";

  if (status === "down") {
    res.setHeader("Cache-Control", "no-store");
  } else {
    // A minute at the edge: fresh enough to watch a deploy, cheap enough that a
    // monitor polling every few seconds can't hammer Redis.
    res.setHeader("Cache-Control", "public, s-maxage=60");
  }
  return res.status(status === "down" ? 503 : 200).json({
    status,
    lastTick,
    minutesSinceLastTick,
    budgets: {
      gnews: { used: toInt(gnUsed), limit: GNEWS_MAX_PER_DAY },
      newsdata: { used: toInt(ndUsed), limit: NEWSDATA_MAX_PER_DAY },
    },
    staleCountries: { count: staleCount, of: COUNTRIES.length },
  });
}
