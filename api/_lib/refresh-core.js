// Rolling-refresh core: timezone-aware selection, a hard credit ledger, and the
// per-country storage model that keeps the served map populated even when an
// upstream refresh fails. Used by api/cron/refresh.js (the rolling tick).
//
// Storage model (see plan):
//   sentiment:country:<code>  -> enriched country object, no TTL (durability)
//   sentiment:world           -> aggregate array rebuilt every tick (what the API serves)
//   sentiment:freshness       -> ZSET, score = last terminal-attempt epoch ms, member = code
//   sentiment:done:<dayId>    -> SET of codes attempted today (prevents double-spend)
//   sentiment:credits:nd:15m:<windowId> / :nd:day:<dayId> -> NewsData credit ledger
//   sentiment:credits:gn:day:<dayId>                      -> GNews credit ledger
//
// Headlines come from two providers with independent quotas, so the ledger is
// split: high-priority countries are fetched from GNews, the rest from NewsData
// (see fetchCountries' tier routing). Each provider has its own budget below so
// one API's usage can never throttle the other.

import { COUNTRIES, HIGH_PRIORITY_CODES } from "./sentiment-fetch.js";

export const AGG_KEY = "sentiment:world";
const COUNTRY_KEY = (code) => `sentiment:country:${code}`;
const FRESH_KEY = "sentiment:freshness";
const DONE_KEY = (dayId) => `sentiment:done:${dayId}`;
const ND_CREDIT_15M_KEY = (windowId) => `sentiment:credits:nd:15m:${windowId}`;
const ND_CREDIT_DAY_KEY = (dayId) => `sentiment:credits:nd:day:${dayId}`;
const GN_CREDIT_DAY_KEY = (dayId) => `sentiment:credits:gn:day:${dayId}`;

// NewsData free tier: 30 credits / 15 min, 200 / day. Stay a margin under both.
// MAX_PER_WINDOW also caps the NewsData work in a single cron tick (each country
// is fetched + scored sequentially); keep it small enough that a tick can't time
// out. Low-priority countries are still covered (every LOW_PRIORITY_DAYS) via the
// done-set + staleness backfill, well inside NEWSDATA_MAX_PER_DAY.
export const MAX_PER_WINDOW = 5;
const NEWSDATA_MAX_PER_DAY = 100;
// GNews free tier: ~100 requests / day (no documented sub-window limit). Stay a
// margin under the daily cap; GNEWS_MAX_PER_TICK bounds per-tick GNews work the
// way MAX_PER_WINDOW does for NewsData, so a big backfill can't overload one tick.
export const GNEWS_MAX_PER_DAY = 90;
export const GNEWS_MAX_PER_TICK = 5;
export const LOW_PRIORITY_DAYS = 2; // countries only in LOW_PRIORITY_COUNTRIES refresh at most every 3 days
const TARGET_LOCAL_HOUR = 6; // refresh each country near 6 am local time
const DONE_TTL = 26 * 60 * 60; // 26 h - outlives a NewsData day so the set is whole-day
const WINDOW_MS = 15 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
// NewsData resets its daily quota at 1am UTC, not midnight. Subtract 60 min so our
// day boundary changes a minute before theirs (epoch / DAY_MS flips at midnight of the shifted clock).
export const NEWSDATA_DAY_OFFSET_MS = 60 * 60 * 1000;

const dayId = (now) => Math.floor((now.getTime() - NEWSDATA_DAY_OFFSET_MS) / DAY_MS);
const windowId = (now) => Math.floor(now.getTime() / WINDOW_MS);

// UTC hour at which a country's local time is ~TARGET_LOCAL_HOUR.
const targetUtcHour = (utcOffset) =>
  ((TARGET_LOCAL_HOUR - utcOffset) % 24 + 24) % 24;

const toInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Choose which countries to refresh this tick:
//   1. countries whose local time is ~ 6 am now and aren't done today (timezone-due)
//   2. then the stalest remaining not-done countries (backfill - recovers prior
//      failures and fills empty/sparse hours without wasting budget)
// ...selected per provider against that provider's own remaining budget (GNews
// for high-priority, NewsData for the rest), so neither API throttles the other.
// A NEWSDATA_MAX_COUNTRIES env var hard-caps the TOTAL picked so `vercel dev`
// only ever touches a tiny subset.
export async function selectDueCountries(redis, now = new Date()) {
  const hour = now.getUTCHours();
  const day = dayId(now);
  const win = windowId(now);

  const [doneList, ndUsed15, ndUsedDay, gnUsedDay, freshPairs] = await Promise.all([
    redis.smembers(DONE_KEY(day)),
    redis.get(ND_CREDIT_15M_KEY(win)),
    redis.get(ND_CREDIT_DAY_KEY(day)),
    redis.get(GN_CREDIT_DAY_KEY(day)),
    redis.zrange(FRESH_KEY, 0, -1, { withScores: true }), // [code, epochMs, ...] oldest-attempt first
  ]);

  const done = new Set(doneList || []);
  // code -> last terminal-attempt epoch ms. Drives both the staleness ordering
  // (backfill) and the low-priority cadence gate below.
  const lastFetch = new Map();
  for (let i = 0; i + 1 < (freshPairs || []).length; i += 2) {
    lastFetch.set(freshPairs[i], Number(freshPairs[i + 1]));
  }

  // Per-provider remaining budget. NewsData is bounded by both its 15-min and
  // daily quotas; GNews by its daily quota and a per-tick cap.
  const ndBudget = Math.max(0, Math.min(
    MAX_PER_WINDOW - toInt(ndUsed15),
    NEWSDATA_MAX_PER_DAY - toInt(ndUsedDay)
  ));
  const gnBudget = Math.max(0, Math.min(
    GNEWS_MAX_PER_TICK,
    GNEWS_MAX_PER_DAY - toInt(gnUsedDay)
  ));

  const devLimit = Number(process.env.NEWSDATA_MAX_COUNTRIES);
  const hasDevCap = Number.isFinite(devLimit) && devLimit > 0;

  // Tier cadence gate: a country is eligible this tick if it's high priority
  // (daily), or low priority and its last refresh was >= LOW_PRIORITY_DAYS
  // day-buckets ago (never-fetched => eligible). Day-buckets (not wall-clock,
  // and aligned to the NewsData day via dayId) so within-day jitter can't drift
  // the 3-day cadence into a 4th day.
  const lastDay = (c) => {
    const last = lastFetch.get(c.code);
    return last === undefined ? -Infinity : dayId(new Date(last));
  };
  const isEligible = (c) =>
    HIGH_PRIORITY_CODES.has(c.code) || day - lastDay(c) >= LOW_PRIORITY_DAYS;

  // diag: lightweight breakdown of why this tick selected what it did - logged by
  // the handler and echoed in the cron's debug response.
  const pending = COUNTRIES.filter((c) => !done.has(c.code));
  const notDone = pending.filter(isEligible);
  const result = {
    subset: [],
    counts: { newsdata: 0, gnews: 0 }, // reserved per provider by the caller
    dayId: day,
    windowId: win,
    diag: {
      hour,
      budget: (hasDevCap ? Math.min(gnBudget, devLimit) : gnBudget) + (hasDevCap ? Math.min(ndBudget, devLimit) : ndBudget),
      gnBudget,
      ndBudget,
      gnUsedDay: toInt(gnUsedDay),
      ndUsed15: toInt(ndUsed15),
      ndUsedDay: toInt(ndUsedDay),
      done: done.size,
      notDone: notDone.length,
      lowDeferred: pending.length - notDone.length, // low-priority not yet due this tick
      tzDue: 0,
      backfill: 0,
    },
  };
  if (gnBudget + ndBudget <= 0) return result;

  // Staleness: lower = staler. Never-attempted countries (absent from the ZSET)
  // rank -1 so they sort ahead of everything and are tried first.
  const staleness = (c) => (lastFetch.has(c.code) ? lastFetch.get(c.code) : -1);

  // Order one provider's eligible countries: timezone-due first (stalest within
  // that), then the stalest of the rest as backfill.
  const orderDue = (list) => {
    const tz = list
      .filter((c) => targetUtcHour(c.utcOffset) === hour)
      .sort((a, b) => staleness(a) - staleness(b));
    const tzCodes = new Set(tz.map((c) => c.code));
    const back = list
      .filter((c) => !tzCodes.has(c.code))
      .sort((a, b) => staleness(a) - staleness(b));
    return { ordered: [...tz, ...back], tzCount: tz.length, backCount: back.length };
  };

  const gn = orderDue(notDone.filter((c) => HIGH_PRIORITY_CODES.has(c.code)));
  const nd = orderDue(notDone.filter((c) => !HIGH_PRIORITY_CODES.has(c.code)));

  // Apply the dev cap per-provider so both providers are always represented.
  // A single post-concat slice would silently drop all NewsData countries when
  // devLimit < gnBudget, since GNews countries come first in the array.
  const gnPart = gn.ordered.slice(0, hasDevCap ? Math.min(gnBudget, devLimit) : gnBudget);
  const ndPart = nd.ordered.slice(0, hasDevCap ? Math.min(ndBudget, devLimit) : ndBudget);
  const subset = [...gnPart, ...ndPart];

  // Counts and diag both reflect the FINAL subset (post dev-cap/budget slice).
  const gnews = gnPart.length;
  result.counts = { newsdata: ndPart.length, gnews };
  const tzDue =
    Math.min(gnPart.length, gn.tzCount) +
    Math.min(ndPart.length, nd.tzCount);
  result.diag.tzDue = tzDue;
  result.diag.backfill = subset.length - tzDue;
  result.subset = subset;
  return result;
}

// Reserve credits BEFORE fetching so a crash mid-tick can't under-count. `counts`
// is { newsdata, gnews } - the number of HTTP requests about to be made to each
// provider (one per country) - charged to that provider's own ledger.
export async function reserveCredits(redis, counts, { dayId: day, windowId: win }) {
  const nd = toInt(counts?.newsdata);
  const gn = toInt(counts?.gnews);
  if (nd <= 0 && gn <= 0) return;
  const p = redis.pipeline();
  if (nd > 0) {
    p.incrby(ND_CREDIT_15M_KEY(win), nd);
    p.expire(ND_CREDIT_15M_KEY(win), Math.ceil(WINDOW_MS / 1000));
    p.incrby(ND_CREDIT_DAY_KEY(day), nd);
    p.expire(ND_CREDIT_DAY_KEY(day), Math.ceil(DAY_MS / 1000));
  }
  if (gn > 0) {
    p.incrby(GN_CREDIT_DAY_KEY(day), gn);
    p.expire(GN_CREDIT_DAY_KEY(day), Math.ceil(DAY_MS / 1000));
  }
  await p.exec();
}

// Persist results. A country counts as refreshed only when it actually produced
// a sentiment score: that overwrites its stored value, bumps its freshness, and
// marks it done (so it isn't retried until tomorrow). A country that fetched
// articles but failed to score them (a transient HuggingFace blip) is left
// entirely alone - not persisted (keeps its prior, still-served value), not
// freshened, and crucially NOT marked done - so the next tick re-attempts it
// rather than serving a null score uncoloured on the map for a whole day.
// Countries with nothing scorable (empty / unsupported / fetch failure / no
// headline text) are marked done AND freshened (it's a terminal attempt) so a
// low-priority quiet country waits out its cadence instead of retrying daily.
// Returns the codes that got real data.
export async function persistCountries(redis, results, day) {
  const now = Date.now();
  const p = redis.pipeline();
  const refreshed = [];

  for (const c of results) {
    const scored = c.articles?.length > 0 && typeof c.score === "number";
    const scorable = c.articles?.length > 0 && c.articles.some((a) => a.title);
    if (scored) {
      p.set(COUNTRY_KEY(c.code), c);
      p.zadd(FRESH_KEY, { score: now, member: c.code });
      p.sadd(DONE_KEY(day), c.code);
      refreshed.push(c.code);
    } else if (!scorable) {
      // Nothing to score (and nothing will improve on retry) - mark done so we
      // don't waste tomorrow's budget re-fetching a quiet/unsupported country.
      // Also bump freshness: this is a terminal attempt, so a low-priority quiet
      // country must wait out its LOW_PRIORITY_DAYS cadence instead of being
      // re-attempted every day (it would otherwise stay absent from the ZSET and
      // read as never-fetched => always eligible).
      p.zadd(FRESH_KEY, { score: now, member: c.code });
      p.sadd(DONE_KEY(day), c.code);
    }
    // else: had headlines but scoring failed - leave untouched so it's re-attempted.
  }
  p.expire(DONE_KEY(day), DONE_TTL);
  await p.exec();
  return refreshed;
}

// Rebuild the served aggregate from the durable per-country keys. Idempotent and
// race-free (reads all keys, writes one). Countries never fetched are simply
// absent. No TTL - the map keeps serving last-good data through any outage.
export async function rebuildAggregate(redis) {
  const codes = COUNTRIES.map((c) => c.code);
  const values = await redis.mget(...codes.map(COUNTRY_KEY));
  const data = values.filter(Boolean).map((c) => ({
    ...c,
    highPriority: HIGH_PRIORITY_CODES.has(c.code),
  }));
  await redis.set(AGG_KEY, data);
  return data.length;
}
