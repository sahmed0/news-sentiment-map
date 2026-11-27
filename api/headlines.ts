// Vercel Serverless Function
// Serves one country's archived headlines, every stored day in one response so
// scrubbing needs no further requests. Read-only like api/history.ts; zero stored
// days is a normal 200.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { HEADLINES_KEY, HEADLINES_READ_DAYS, bucketToDate, dayId } from "./_lib/refresh-core.js";
import { COUNTRIES } from "./_lib/sentiment-fetch.js";
import { parseStoredHeadlineDay } from "../shared/types.js";
import type { HeadlineDay } from "../shared/types.js";
import { err } from "./_lib/logger.js";

const KNOWN_CODES = new Set(COUNTRIES.map((c) => c.code));

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
    res.setHeader("Cache-Control", "no-store");
    return res.status(400).json({ error: "Unknown country code" });
  }

  const today = dayId(new Date());
  const dayIds = Array.from({ length: HEADLINES_READ_DAYS }, (_, i) => today - (HEADLINES_READ_DAYS - 1) + i);

  let values: unknown[];
  try {
    const { Redis } = await import("@upstash/redis");
    const redis = new Redis({ url: redisUrl, token: redisToken });
    values = await redis.mget(...dayIds.map((d) => HEADLINES_KEY(code, d)));
  } catch (e) {
    err("Headlines", "redis_unavailable", { message: e instanceof Error ? e.message : String(e) });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Retry-After", "30");
    return res.status(503).json({ error: "Data temporarily unavailable" });
  }

  const days: HeadlineDay[] = [];
  dayIds.forEach((d, i) => {
    const parsed = parseStoredHeadlineDay(values?.[i]);
    // A `d` that disagrees with its key is a misfiled value, not that day's headlines.
    if (!parsed || parsed.d !== d || parsed.articles.length === 0) return;
    days.push({ date: bucketToDate(d), articles: parsed.articles });
  });

  // Past days never change, so the only cost of caching is that a day written in
  // the last 1.5 h (s-maxage + SWR) may be missing for a while.
  res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=3600");
  return res.status(200).json({ code, days });
}
