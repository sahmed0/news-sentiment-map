// Rolling-refresh core: timezone-aware selection, a hard credit ledger, and the
// per-country storage model that keeps the served map populated even when an
// upstream refresh fails. Used by api/cron/refresh.js (the rolling tick).
//
// Storage model (see plan):
//   sentiment:country:<code>  -> enriched country object, no TTL (durability)
//   sentiment:world           -> aggregate array rebuilt every tick (what the API serves)
//   sentiment:freshness       -> ZSET, score = last terminal-attempt epoch ms, member = code
//   sentiment:done:<dayId>    -> SET of codes attempted today (prevents double-spend)
//   sentiment:credits:nd:day:<dayId>    -> NewsData credit ledger (day shifted to NewsData's 1am reset)
//   sentiment:credits:gn:day:<gnDayId>  -> GNews credit ledger (plain midnight-UTC day)
//
// Headlines come from two providers with independent quotas, so the ledger is
// split: high-priority countries are fetched from GNews, the rest from NewsData
// (see fetchCountries' tier routing). Each provider has its own budget below so
// one API's usage can never throttle the other.

import { COUNTRIES, HIGH_PRIORITY_CODES, LOW_PRIORITY_COUNTRIES } from "./sentiment-fetch.js";

export const AGG_KEY = "sentiment:world";
const COUNTRY_KEY = (code) => `sentiment:country:${code}`;
const FRESH_KEY = "sentiment:freshness";
const DONE_KEY = (dayId) => `sentiment:done:${dayId}`;
const ND_CREDIT_DAY_KEY = (dayId) => `sentiment:credits:nd:day:${dayId}`;
const GN_CREDIT_DAY_KEY = (dayId) => `sentiment:credits:gn:day:${dayId}`;

// NewsData free tier: 200 credits / day. Stay a margin under it. NEWSDATA_MAX_PER_TICK
// bounds the NewsData work in a single cron tick (each country is fetched + scored
// sequentially); keep it small enough that a tick can't time out - the same role
// GNEWS_MAX_PER_TICK plays below. Low-priority countries are still covered (every
// LOW_PRIORITY_DAYS) via the done-set + staleness backfill, well inside
// NEWSDATA_MAX_PER_DAY. (The hourly cron means each tick is its own window, so a
// separate sub-hourly rolling cap would never accumulate - a per-tick cap suffices.)
export const NEWSDATA_MAX_PER_TICK = 20;
export const NEWSDATA_MAX_PER_DAY = 100;
// GNews free tier: ~100 requests / day (no documented sub-window limit). Stay a
// margin under the daily cap; GNEWS_MAX_PER_TICK bounds per-tick GNews work the
// way MAX_PER_WINDOW does for NewsData, so a big backfill can't overload one tick.
export const GNEWS_MAX_PER_DAY = 90;
export const GNEWS_MAX_PER_TICK = 20;
export const LOW_PRIORITY_DAYS = 2; // countries only in LOW_PRIORITY_COUNTRIES refresh at most every LOW_PRIORITY_DAYS days
const TARGET_LOCAL_HOUR = 6; // refresh each country near 6 am local time
// A not-yet-due country (its 6 am-local target hasn't arrived yet today) is only
// pulled forward by backfill once it's this stale - i.e. it already missed a full
// daily cycle. Steady-state staleness peaks at ~24 h (one fetch per target), so
// 30 h leaves a margin: normal timing is driven by the target hour, and backfill
// only steps in to recover a country that genuinely fell behind. Without this gate
// backfill fetches every not-done country all day in staleness order, eroding the
// 6 am-local schedule into "refresh everyone, earliest-due-be-damned" (see plan).
const STALE_BACKFILL_MS = 30 * 60 * 60 * 1000;
const DONE_TTL = 26 * 60 * 60; // 26 h - outlives a NewsData day so the set is whole-day
export const DAY_MS = 24 * 60 * 60 * 1000;
// NewsData resets its daily quota at 1am UTC, not midnight. Subtract 60 min so our
// day boundary changes a minute before theirs (epoch / DAY_MS flips at midnight of the shifted clock).
export const NEWSDATA_DAY_OFFSET_MS = 60 * 60 * 1000;

// NewsData-aligned day (shifted to its 1am reset) - drives the done-set, the
// NewsData credit ledger, and the low-priority cadence.
const dayId = (now) => Math.floor((now.getTime() - NEWSDATA_DAY_OFFSET_MS) / DAY_MS);
// GNews resets on the plain UTC calendar day (midnight), so its ledger uses an
// unshifted day. Keying it off dayId would mis-book ~one tick of usage in the
// 00:00-01:00 UTC gap into the previous ledger day.
const gnDayId = (now) => Math.floor(now.getTime() / DAY_MS);

// Fixed cadence phase per low-priority country: its position in the list modulo
// LOW_PRIORITY_DAYS. Round-robin assignment partitions the low-priority countries
// into LOW_PRIORITY_DAYS near-equal cohorts (sizes differ by at most one), so each
// day only ~1/LOW_PRIORITY_DAYS of them are due. Without this, a cold start (where
// every country is never-fetched and the daily NewsData budget exceeds the list
// size) fetches them all on the same day, bunching the whole list into one cohort
// that then refreshes together every LOW_PRIORITY_DAYS - a lopsided ~100/0 split.
const LOW_PRIORITY_PHASE = new Map(
  LOW_PRIORITY_COUNTRIES.map((c, i) => [c.code, i % LOW_PRIORITY_DAYS])
);

// Whether a low-priority country is in the cohort due on the given day-bucket.
// (`%` is sign-safe here since real day-buckets are positive, but normalise anyway
// so negative test/day values can't flip a cohort.) Exported for tests/diagnostics.
export const lowPriorityDueOn = (code, day) =>
  ((day % LOW_PRIORITY_DAYS) + LOW_PRIORITY_DAYS) % LOW_PRIORITY_DAYS ===
  LOW_PRIORITY_PHASE.get(code);

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
//      failures and fills empty/sparse hours without wasting budget), EXCEPT
//      countries still early for their 6 am-local target unless badly overdue
//      (> STALE_BACKFILL_MS). This keeps backfill from fetching every country
//      hours before its target and eroding the per-country 6 am-local schedule.
// ...selected per provider against that provider's own remaining budget (GNews
// for high-priority, NewsData for the rest), so neither API throttles the other.
// A NEWSDATA_MAX_COUNTRIES env var hard-caps the TOTAL picked so `vercel dev`
// only ever touches a tiny subset.
export async function selectDueCountries(redis, now = new Date()) {
  const hour = now.getUTCHours();
  const day = dayId(now);
  const gnDay = gnDayId(now);

  const [doneList, ndUsedDay, gnUsedDay, freshPairs] = await Promise.all([
    redis.smembers(DONE_KEY(day)),
    redis.get(ND_CREDIT_DAY_KEY(day)),
    redis.get(GN_CREDIT_DAY_KEY(gnDay)),
    redis.zrange(FRESH_KEY, 0, -1, { withScores: true }), // [code, epochMs, ...] oldest-attempt first
  ]);

  const done = new Set(doneList || []);
  // code -> last terminal-attempt epoch ms. Drives both the staleness ordering
  // (backfill) and the low-priority cadence gate below.
  const lastFetch = new Map();
  for (let i = 0; i + 1 < (freshPairs || []).length; i += 2) {
    lastFetch.set(freshPairs[i], Number(freshPairs[i + 1]));
  }

  // Per-provider remaining budget. Each provider is bounded by its daily quota and
  // a per-tick cap that keeps a single tick from timing out.
  const ndBudget = Math.max(0, Math.min(
    NEWSDATA_MAX_PER_TICK,
    NEWSDATA_MAX_PER_DAY - toInt(ndUsedDay)
  ));
  const gnBudget = Math.max(0, Math.min(
    GNEWS_MAX_PER_TICK,
    GNEWS_MAX_PER_DAY - toInt(gnUsedDay)
  ));

  const devLimit = Number(process.env.NEWSDATA_MAX_COUNTRIES);
  const hasDevCap = Number.isFinite(devLimit) && devLimit > 0;

  // Tier cadence gate: a country is eligible this tick if it's high priority
  // (daily), or low priority AND today is its cohort's phase day AND its last
  // refresh was >= LOW_PRIORITY_DAYS day-buckets ago (never-fetched => eligible
  // on its next phase day). Day-buckets (not wall-clock, and aligned to the
  // NewsData day via dayId) so within-day jitter can't drift the cadence into an
  // extra day. The phase gate (lowPriorityDueOn) is what keeps the per-day load
  // even - it stops more than one cohort being eligible on the same day.
  const lastDay = (c) => {
    const last = lastFetch.get(c.code);
    return last === undefined ? -Infinity : dayId(new Date(last));
  };
  const isEligible = (c) => {
    if (HIGH_PRIORITY_CODES.has(c.code)) return true;
    if (!lowPriorityDueOn(c.code, day)) return false;
    return day - lastDay(c) >= LOW_PRIORITY_DAYS;
  };

  // diag: lightweight breakdown of why this tick selected what it did - logged by
  // the handler and echoed in the cron's debug response.
  const pending = COUNTRIES.filter((c) => !done.has(c.code));
  const notDone = pending.filter(isEligible);
  const result = {
    subset: [],
    counts: { newsdata: 0, gnews: 0 }, // reserved per provider by the caller
    dayId: day,
    gnDayId: gnDay,
    diag: {
      hour,
      budget: (hasDevCap ? Math.min(gnBudget, devLimit) : gnBudget) + (hasDevCap ? Math.min(ndBudget, devLimit) : ndBudget),
      gnBudget,
      ndBudget,
      gnUsedDay: toInt(gnUsedDay),
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

  // Hours elapsed since the NewsData day began (01:00 UTC, per NEWSDATA_DAY_OFFSET_MS).
  // The done-set resets at that boundary, so this is the natural clock for "has a
  // country's target hour arrived yet in the current day".
  const dayStartHour = NEWSDATA_DAY_OFFSET_MS / (60 * 60 * 1000);
  const hoursIntoDay = ((hour - dayStartHour) % 24 + 24) % 24;
  // A country is "early" when its 6 am-local target falls later in the current day
  // than now - i.e. fetching it this tick would be ahead of schedule.
  const isEarly = (c) => {
    const target = ((targetUtcHour(c.utcOffset) - dayStartHour) % 24 + 24) % 24;
    return hoursIntoDay < target;
  };
  // Badly overdue: last terminal attempt was > STALE_BACKFILL_MS ago, or never
  // (the -1 sentinel sorts below any epoch). Such a country jumped a full cycle, so
  // backfill may pull it forward even before its target hour to recover it.
  const veryStale = (c) => staleness(c) < now.getTime() - STALE_BACKFILL_MS;

  // Order one provider's eligible countries: timezone-due first (stalest within
  // that), then the stalest of the rest as backfill - but a backfill country that
  // is still early for its target hour is held back unless it's badly overdue, so
  // spare budget recovers genuine misses instead of fetching everyone hours early.
  const orderDue = (list) => {
    const tz = list
      .filter((c) => targetUtcHour(c.utcOffset) === hour)
      .sort((a, b) => staleness(a) - staleness(b));
    const tzCodes = new Set(tz.map((c) => c.code));
    const back = list
      .filter((c) => !tzCodes.has(c.code) && (!isEarly(c) || veryStale(c)))
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
// provider (one per country) - charged to that provider's own ledger. NewsData uses
// the shifted `dayId`; GNews uses its own midnight-UTC `gnDayId` (see selectDueCountries).
export async function reserveCredits(redis, counts, { dayId: day, gnDayId: gnDay }) {
  const nd = toInt(counts?.newsdata);
  const gn = toInt(counts?.gnews);
  if (nd <= 0 && gn <= 0) return;
  const p = redis.pipeline();
  if (nd > 0) {
    p.incrby(ND_CREDIT_DAY_KEY(day), nd);
    p.expire(ND_CREDIT_DAY_KEY(day), Math.ceil(DAY_MS / 1000));
  }
  if (gn > 0) {
    p.incrby(GN_CREDIT_DAY_KEY(gnDay), gn);
    p.expire(GN_CREDIT_DAY_KEY(gnDay), Math.ceil(DAY_MS / 1000));
  }
  await p.exec();
}

// Refund credits reserved for fetches that failed transiently. Such a fetch is
// retried next tick by persistCountries AND typically never consumed the provider's
// real daily quota (a timeout/5xx/rate-limit/connection blip), so the up-front
// reservation should be released - otherwise the daily slack is spent on failures
// instead of recovery. Mirrors reserveCredits but only touches the daily ledgers
// (the keys already carry a TTL from the reservation). Terminal outcomes
// (empty/unsupported/4xx) and scorable-but-unscored fetches DID hit the provider,
// so they keep their charge - see refundCounts.
export async function releaseCredits(redis, counts, { dayId: day, gnDayId: gnDay }) {
  const nd = toInt(counts?.newsdata);
  const gn = toInt(counts?.gnews);
  if (nd <= 0 && gn <= 0) return;
  const p = redis.pipeline();
  if (nd > 0) p.incrby(ND_CREDIT_DAY_KEY(day), -nd);
  if (gn > 0) p.incrby(GN_CREDIT_DAY_KEY(gnDay), -gn);
  await p.exec();
}

// Per-provider count of fetches worth refunding: those whose status is transient
// (the same set that drives the retry decision in persistCountries, so refund and
// retry stay in lockstep). Split by tier since each provider owns its own ledger.
export function refundCounts(results) {
  let newsdata = 0, gnews = 0;
  for (const c of results || []) {
    if (!isTransientStatus(c.status)) continue;
    if (HIGH_PRIORITY_CODES.has(c.code)) gnews++;
    else newsdata++;
  }
  return { newsdata, gnews };
}

// Fetch outcomes worth retrying later the same day - a provider-side blip the
// daily budget slack is sized to absorb - vs terminal outcomes (empty /
// unsupported / 4xx) that won't improve on a retry. The status strings come
// from fetchHeadlines / fetchHeadlinesGNews (see sentiment-fetch.js).
const TRANSIENT_STATUSES = new Set([
  "timeout", "network_error", "rate_limited", "api_error", "invalid_json", "error",
]);
export function isTransientStatus(status) {
  if (!status) return false;
  if (TRANSIENT_STATUSES.has(status)) return true;
  const m = /^http_(\d+)$/.exec(status);
  return m ? Number(m[1]) >= 500 : false;
}

// Persist results. A country counts as refreshed only when it actually produced
// a sentiment score: that overwrites its stored value, bumps its freshness, and
// marks it done (so it isn't retried until tomorrow). Two cases are left
// entirely alone - not persisted (keep their prior, still-served value), not
// freshened, and crucially NOT marked done - so the next tick re-attempts them,
// spending the daily slack the limits were sized to provide:
//   - had headline text but scoring failed (a transient HuggingFace blip)
//   - a transient fetch failure (rate limit / timeout / 5xx / api_error) that
//     returned no articles but will likely succeed on retry.
// Genuinely terminal outcomes (empty / unsupported / 4xx / unknown) are marked
// done AND freshened (it's a terminal attempt) so a low-priority quiet country
// waits out its cadence instead of retrying daily.
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
    } else if (scorable || isTransientStatus(c.status)) {
      // Leave untouched -> retried next tick. `scorable` = had headline text but
      // HF scoring failed; transient = a provider blip that returned no articles.
      // Not freshened + not done => stays eligible. (Transient statuses always
      // return empty articles, so these two cases never overlap in practice.)
    } else {
      // Terminal (empty / unsupported / 4xx) - nothing will improve on retry, so
      // mark done so we don't waste budget re-fetching a quiet/unsupported
      // country. Also bump freshness: this is a terminal attempt, so a
      // low-priority quiet country must wait out its LOW_PRIORITY_DAYS cadence
      // instead of being re-attempted every day (it would otherwise stay absent
      // from the ZSET and read as never-fetched => always eligible).
      p.zadd(FRESH_KEY, { score: now, member: c.code });
      p.sadd(DONE_KEY(day), c.code);
    }
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
