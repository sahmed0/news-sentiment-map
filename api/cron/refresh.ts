// api/cron/refresh.ts - Rolling refresh tick
// Fired hourly by an Upstash QStash schedule (cron `0 * * * *`), the sole trigger.
// Each tick refreshes the countries whose local time is ~6 am now (plus stale
// backfill), strictly within the NewsData.io free-tier credit budget. Auth is the
// Bearer CRON_SECRET that QStash forwards via Upstash-Forward-Authorization.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { timingSafeEqual } from "node:crypto";
import { fetchCountries } from "../_lib/sentiment-fetch.js";
import {
  selectDueCountries,
  reserveCredits,
  releaseCredits,
  refundCounts,
  persistCountries,
  rebuildAggregate,
  recordTick,
} from "../_lib/refresh-core.js";
import { log, warn, err, now, since } from "../_lib/logger.js";
import type { FetchStats } from "../_lib/sentiment-fetch.js";
import type { TickSummary } from "../../shared/types.js";

const LOCK_KEY = "sentiment:refresh:lock";
// Match maxDuration (300 s) so the lock can't expire mid-tick and let a second
// invocation start while this one is still fetching/scoring. The finally block
// releases it as soon as the tick finishes, so a healthy tick never holds it long.
const LOCK_TTL = 300; // seconds

// Fluid Compute is enabled, so Hobby allows up to 300 s. We use the full ceiling
// as a safety net; the per-tick batch (MAX_PER_WINDOW) and per-request fetch
// timeouts keep a normal tick far shorter than this.
export const config = { maxDuration: 300 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Fail closed if the secret is unset - otherwise the expected value would be
  // the guessable literal "Bearer undefined".
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(500).json({ error: "CRON_SECRET not configured" });
  const expected = Buffer.from(`Bearer ${secret}`);
  const provided = Buffer.from(req.headers.authorization ?? "");
  // timingSafeEqual throws on length mismatch - guard first (length is not secret here).
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const redisUrl = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;
  if (!redisUrl || !redisToken) {
    return res.status(500).json({ error: "Redis not configured" });
  }

  const { Redis } = await import("@upstash/redis");
  const redis = new Redis({ url: redisUrl, token: redisToken });

  const lockAcquired = await redis.set(LOCK_KEY, "1", { nx: true, ex: LOCK_TTL });
  if (!lockAcquired) {
    return res.status(200).json({ ok: false, reason: "tick already in progress" });
  }

  const t0 = now();
  // Every exit leaves a summary behind so /api/health can answer "did the pipeline
  // run, and did it work?" without the Vercel logs. A failed summary write must
  // never turn a healthy tick into a 500.
  const safeRecord = async (summary: TickSummary): Promise<void> => {
    try {
      await recordTick(redis, summary);
    } catch (e) {
      warn("Tick", "record_failed", { message: e instanceof Error ? e.message : String(e) });
    }
  };

  try {
    const selection = await selectDueCountries(redis);
    const { subset, diag } = selection;
    log("Tick", "selection", { ...diag, picked: subset.length });

    if (subset.length === 0) {
      // Nothing due and no budget/backfill - still rebuild so a freshly-warmed
      // country key is reflected, then exit cheaply.
      const count = await rebuildAggregate(redis);
      const reason = diag.budget <= 0 ? "budget_exhausted" : "all_done";
      log("Tick", "idle", { reason, aggregate: count, ms: since(t0) });
      // An idle tick attempted nothing, so every counter is zero - but it still
      // proves the cron fired, which is what the health status turns on.
      await safeRecord({
        ts: new Date().toISOString(),
        ok: 0,
        attempted: 0,
        aggregate: count,
        tzDue: 0,
        backfill: 0,
        gnUsedDay: 0,
        ndUsedDay: 0,
        refunded: 0,
        ms: since(t0),
      });
      return res.status(200).json({ ok: true, refreshed: [], aggregate: count, debug: { reason, selection: diag } });
    }

    // Reserve credits up front so a mid-tick crash can never under-count spend.
    // Each provider is charged its own count (see selection.counts).
    await reserveCredits(redis, selection.counts, selection);

    log("Tick", "refreshing", {
      n: subset.length,
      gnews: selection.counts.gnews,
      newsdata: selection.counts.newsdata,
      codes: subset.map((c) => c.code).join(","),
    });
    const stats: FetchStats = {};
    const results = await fetchCountries(subset, stats);
    // Refund credits reserved for transient failures: they're retried next tick and
    // typically never consumed the provider's real quota, so reclaim the slack.
    const refunded = refundCounts(results);
    await releaseCredits(redis, refunded, selection);
    const refreshed = await persistCountries(redis, results, selection.dayId);
    const aggregate = await rebuildAggregate(redis);

    log("Tick", "done", {
      ok: refreshed.length,
      attempted: subset.length,
      aggregate,
      ...stats.timings,
      ms: since(t0),
    });
    await safeRecord({
      ts: new Date().toISOString(),
      ok: refreshed.length,
      attempted: subset.length,
      aggregate,
      tzDue: diag.tzDue,
      backfill: diag.backfill,
      gnUsedDay: diag.gnUsedDay,
      ndUsedDay: diag.ndUsedDay,
      refunded: refunded.newsdata + refunded.gnews,
      ms: since(t0),
    });
    return res.status(200).json({
      ok: true,
      refreshed,
      attempted: subset.length,
      aggregate,
      debug: {
        timings: stats.timings,
        counts: stats.counts,
        refunded,
        selection: diag,
        countries: stats.countries,
      },
    });
  } catch (e) {
    // Surface the failure reason in the response body so it's visible in the
    // QStash dashboard, and log the full stack to Vercel function logs.
    const message = e instanceof Error ? e.message : String(e);
    err("Tick", "error", { message, ms: since(t0) });
    console.error(e instanceof Error ? e.stack : e);
    // A failed tick is the one the health endpoint most needs to see, so the
    // summary carries the reason rather than simply being absent.
    await safeRecord({
      ts: new Date().toISOString(),
      ok: 0,
      attempted: 0,
      aggregate: 0,
      tzDue: 0,
      backfill: 0,
      gnUsedDay: 0,
      ndUsedDay: 0,
      refunded: 0,
      ms: since(t0),
      error: message,
    });
    return res.status(500).json({ ok: false, error: message });
  } finally {
    await redis.del(LOCK_KEY);
  }
}
