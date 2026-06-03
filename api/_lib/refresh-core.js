// Rolling-refresh core: timezone-aware selection, a hard credit ledger, and the
// per-country storage model that keeps the served map populated even when an
// upstream refresh fails. Used by api/cron/refresh.js (the rolling tick).
//
// Storage model (see plan):
//   sentiment:country:<code>  -> enriched country object, no TTL (durability)
//   sentiment:world           -> aggregate array rebuilt every tick (what the API serves)
//   sentiment:freshness       -> ZSET, score = last terminal-attempt epoch ms, member = code
//   sentiment:done:<dayId>    -> SET of codes attempted today (prevents double-spend)
//   sentiment:credits:15m:<windowId> / :day:<dayId> -> credit ledger counters

import { COUNTRIES, HIGH_PRIORITY_CODES } from "./sentiment-fetch.js";

export const AGG_KEY = "sentiment:world";
const COUNTRY_KEY = (code) => `sentiment:country:${code}`;
const FRESH_KEY = "sentiment:freshness";
const DONE_KEY = (dayId) => `sentiment:done:${dayId}`;
const CREDIT_15M_KEY = (windowId) => `sentiment:credits:15m:${windowId}`;
const CREDIT_DAY_KEY = (dayId) => `sentiment:credits:day:${dayId}`;

// NewsData free tier: 30 credits / 15 min, 200 / day. Stay a margin under both.
// This also caps the work done in a single cron tick (each country is fetched +
// scored sequentially); keep it small enough that a tick can never time out. The
// ~105 supported countries are still covered daily via the done-set + staleness
// backfill, well inside MAX_PER_DAY.
const MAX_PER_WINDOW = 12;
const MAX_PER_DAY = 133;
const LOW_PRIORITY_DAYS = 3; // countries only in LOW_PRIORITY_COUNTRIES refresh at most every 3 days
const TARGET_LOCAL_HOUR = 22; // refresh each country near 10 pm local time
const DONE_TTL = 26 * 60 * 60; // 26 h - outlives a NewsData day so the set is whole-day
const WINDOW_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// NewsData resets its daily quota at 1am UTC, not midnight. Subtract 59 min so our
// day boundary changes a minute before theirs (epoch / DAY_MS flips at midnight of the shifted clock).
const NEWSDATA_DAY_OFFSET_MS = 59 * 60 * 1000;

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
//   1. countries whose local time is ~ 10 pm now and aren't done today (timezone-due)
//   2. then the stalest remaining not-done countries (backfill - recovers prior
//      failures and fills empty/sparse hours without wasting budget)
// ...all capped by the remaining 15-min and daily credit budget. A NEWSDATA_MAX_COUNTRIES
// env var hard-caps the count so `vercel dev` only ever touches a tiny subset.
export async function selectDueCountries(redis, now = new Date()) {
  const hour = now.getUTCHours();
  const day = dayId(now);
  const win = windowId(now);

  const [doneList, used15, usedDay, freshPairs] = await Promise.all([
    redis.smembers(DONE_KEY(day)),
    redis.get(CREDIT_15M_KEY(win)),
    redis.get(CREDIT_DAY_KEY(day)),
    redis.zrange(FRESH_KEY, 0, -1, { withScores: true }), // [code, epochMs, ...] oldest-attempt first
  ]);

  const done = new Set(doneList || []);
  // code -> last terminal-attempt epoch ms. Drives both the staleness ordering
  // (backfill) and the low-priority cadence gate below.
  const lastFetch = new Map();
  for (let i = 0; i + 1 < (freshPairs || []).length; i += 2) {
    lastFetch.set(freshPairs[i], Number(freshPairs[i + 1]));
  }

  let budget = Math.min(
    MAX_PER_WINDOW - toInt(used15),
    MAX_PER_DAY - toInt(usedDay)
  );

  const devLimit = Number(process.env.NEWSDATA_MAX_COUNTRIES);
  if (Number.isFinite(devLimit) && devLimit > 0) budget = Math.min(budget, devLimit);

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
    dayId: day,
    windowId: win,
    diag: {
      hour,
      budget,
      used15: toInt(used15),
      usedDay: toInt(usedDay),
      done: done.size,
      notDone: notDone.length,
      lowDeferred: pending.length - notDone.length, // low-priority not yet due this tick
      tzDue: 0,
      backfill: 0,
    },
  };
  if (budget <= 0) return result;

  // Staleness: lower = staler. Never-attempted countries (absent from the ZSET)
  // rank -1 so they sort ahead of everything and are tried first.
  const staleness = (c) => (lastFetch.has(c.code) ? lastFetch.get(c.code) : -1);

  const tzDue = notDone
    .filter((c) => targetUtcHour(c.utcOffset) === hour)
    .sort((a, b) => staleness(a) - staleness(b));
  const tzCodes = new Set(tzDue.map((c) => c.code));
  const backfill = notDone
    .filter((c) => !tzCodes.has(c.code))
    .sort((a, b) => staleness(a) - staleness(b));

  result.diag.tzDue = tzDue.length;
  result.diag.backfill = backfill.length;
  result.subset = [...tzDue, ...backfill].slice(0, budget);
  return result;
}

// Reserve credits BEFORE fetching so a crash mid-tick can't under-count. The
// count equals the number of HTTP requests we're about to make (one per country).
export async function reserveCredits(redis, n, { dayId: day, windowId: win }) {
  if (n <= 0) return;
  const p = redis.pipeline();
  p.incrby(CREDIT_15M_KEY(win), n);
  p.expire(CREDIT_15M_KEY(win), Math.ceil(WINDOW_MS / 1000));
  p.incrby(CREDIT_DAY_KEY(day), n);
  p.expire(CREDIT_DAY_KEY(day), Math.ceil(DAY_MS / 1000));
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
  const data = values.filter(Boolean);
  await redis.set(AGG_KEY, data);
  return data.length;
}
