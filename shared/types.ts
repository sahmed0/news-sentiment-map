// Canonical data shapes shared by the serverless API (api/) and the
// frontend (src/). Keeping the contract in one module means CountryResult / Article
// are the SAME type on both sides of the wire - a change here surfaces everywhere.

// One country-table entry (see api/_lib/sentiment-fetch.ts). `lang` is the primary
// news language: a single ISO 639-1 code for high-priority countries, a comma-joined
// list for low-priority ones.
export interface CountryDef {
  code: string;
  name: string;
  utcOffset: number;
  lang: string;
}

// A news article as normalized straight off a provider, before enrichment.
// Fields mirror what the NewsData / GNews normalisers keep.
export interface RawArticle {
  title: string | null;
  url: string | null;
  publishedAt: string | null; // ISO string or null (see toIsoOrNull)
  language: string | null; // NewsData vocabulary, e.g. "english", "german"
}

// The enriched, served article: a RawArticle plus the sentiment score and the
// English translation used for display + scoring (null when not needed).
export interface Article extends RawArticle {
  score: number | null; // per-headline sentiment, null if unscored
  translatedTitle: string | null;
}

// One country's stored/served result (sentiment:country:<code> and the items of
// sentiment:world). `highPriority` is added only by rebuildAggregate.
export interface CountryResult {
  code: string; // lowercase alpha-2
  name: string;
  score: number | null; // average of scored headlines
  status: string | undefined; // fetch outcome, e.g. "ok" | "timeout" | "http_500"
  articles: Article[];
  fetchedAt: string; // ISO
  highPriority?: boolean;
}

// Payload of GET /api/sentiment.
export interface SentimentResponse {
  data: CountryResult[];
  cached: boolean;
}

// One point of GET /api/history.
export interface HistoryPoint {
  date: string; // "YYYY-MM-DD"
  score: number;
  n: number;
}
export interface HistoryResponse {
  code: string;
  points: HistoryPoint[];
}

// Tick summary pushed to sentiment:ticks.
export interface TickSummary {
  ts: string; // ISO
  ok: number;
  attempted: number;
  aggregate: number;
  tzDue: number;
  backfill: number;
  gnUsedDay: number;
  ndUsedDay: number;
  refunded: number;
  ms: number;
  error?: string; // present only for failed ticks
}

// Narrow unions the code has implicitly.
export type SentimentBucket = "positive" | "neutral" | "negative";
export type Provider = "gnews" | "newsdata";
export type FilterKey = SentimentBucket | "all";

// Per-provider request counts, charged to each provider's own credit ledger.
export interface ProviderCounts {
  newsdata: number;
  gnews: number;
}

// selectDueCountries' diagnostic breakdown (all counters). Logged by the cron
// handler and echoed in its debug response.
export interface SelectionDiag {
  hour: number;
  budget: number;
  gnBudget: number;
  ndBudget: number;
  gnUsedDay: number;
  ndUsedDay: number;
  done: number;
  notDone: number;
  lowDeferred: number;
  tzDue: number;
  backfill: number;
}

// selectDueCountries' return: which countries to fetch this tick and why.
export interface Selection {
  subset: CountryDef[];
  counts: ProviderCounts;
  dayId: number;
  gnDayId: number;
  diag: SelectionDiag;
}

// Structural subset of @upstash/redis's client covering exactly the methods the
// backend calls. Both the real Redis and test/helpers/fakeRedis satisfy it, so
// refresh-core can accept an injected client (real or fake) without importing the
// concrete class. Values read back from Redis are `unknown` - narrow them with
// parseCountryResult rather than casting.
export interface RedisPipelineLike {
  set(key: string, value: unknown, opts?: { nx?: boolean; ex?: number }): RedisPipelineLike;
  del(...keys: string[]): RedisPipelineLike;
  incrby(key: string, by: number): RedisPipelineLike;
  expire(key: string, seconds: number): RedisPipelineLike;
  sadd(key: string, ...members: string[]): RedisPipelineLike;
  zadd(key: string, entry: { score: number; member: string }, ...entries: { score: number; member: string }[]): RedisPipelineLike;
  zremrangebyscore(key: string, min: number, max: number): RedisPipelineLike;
  zremrangebyrank(key: string, start: number, stop: number): RedisPipelineLike;
  lpush(key: string, ...values: string[]): RedisPipelineLike;
  ltrim(key: string, start: number, stop: number): RedisPipelineLike;
  get(key: string): RedisPipelineLike;
  exec(): Promise<unknown[]>;
}
export interface RedisLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, opts?: { nx?: boolean; ex?: number }): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  incrby(key: string, by: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  smembers(key: string): Promise<string[]>;
  sadd(key: string, ...members: string[]): Promise<number>;
  zadd(key: string, entry: { score: number; member: string }, ...entries: { score: number; member: string }[]): Promise<number | null>;
  zrange(key: string, start: number, stop: number, opts?: { withScores?: boolean }): Promise<(string | number)[]>;
  zremrangebyscore(key: string, min: number, max: number): Promise<number>;
  zremrangebyrank(key: string, start: number, stop: number): Promise<number>;
  lpush(key: string, ...values: string[]): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<string>;
  lrange(key: string, start: number, stop: number): Promise<unknown[]>;
  mget(...keys: string[]): Promise<unknown[]>;
  pipeline(): RedisPipelineLike;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

// Narrow an untyped Redis value (mget/get returns `unknown`) into a CountryResult,
// or null when the value can't be a stored country. The one hard requirement is a
// string `code` - the field the aggregate is keyed and tiered by; the rest of the
// shape is guaranteed by persistCountries, the only writer. A missing/garbage entry
// is dropped rather than served.
export function parseCountryResult(v: unknown): CountryResult | null {
  if (!isRecord(v) || typeof v.code !== "string") return null;
  // Validated above; the double-assert is the guard narrowing its own input.
  return v as unknown as CountryResult;
}

// A history ZSET member as written by persistCountries: the day bucket, the
// day's score and how many headlines it averaged. Compact keys because every
// scored country writes one of these per day, forever (capped at HISTORY_MAX_DAYS).
export interface StoredHistoryPoint {
  d: number; // day bucket (the NewsData-shifted dayId), also the zset score
  s: number; // score, rounded to 3 dp
  n: number; // number of scored headlines behind `s`
}

// Narrow one raw ZSET member into a StoredHistoryPoint. The value arrives either
// as the JSON string persistCountries wrote or as an already-parsed object (the
// Upstash client's automatic deserialization JSON-parses every string in a
// command's response, including ZSET members). A truncated write or a hand-edited key must not crash a
// read, so a malformed point is dropped so the rest of the series still serves.
export function parseHistoryPoint(v: unknown): StoredHistoryPoint | null {
  let parsed: unknown = v;
  if (typeof v === "string") {
    try {
      parsed = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!isRecord(parsed)) return null;
  const { d, s, n } = parsed;
  if (!Number.isFinite(d) || !Number.isFinite(s) || !Number.isFinite(n)) return null;
  return { d: Number(d), s: Number(s), n: Number(n) };
}
