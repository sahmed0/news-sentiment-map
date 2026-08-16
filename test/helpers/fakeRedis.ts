// In-memory Upstash-Redis double. Implements only the methods the app actually
// calls (get/set/del/incrby/expire/smembers/sadd/zadd/zrange/zremrangebyscore/
// zremrangebyrank/lpush/ltrim/lrange/mget + pipeline), with just enough fidelity
// for the scheduling, credit-ledger, history, tick-log, and handler tests:
//   - set({ nx, ex }) returns "OK" or null so lock semantics work
//   - zrange({ withScores }) returns a flat [member, score, ...] sorted by score
//   - zremrangeby* treat both bounds as inclusive and resolve negative ranks
//   - lpush prepends (so index 0 is the newest); lrange/ltrim treat both bounds as
//     inclusive, resolve negative indices from the end, and clamp out-of-range ones
//   - pipeline() queues ops and applies them on exec()
// TTLs (ex / expire) are intentionally no-ops: tests inject `now`, they don't
// wait for real expiry.

import type { RedisLike, RedisPipelineLike } from "../../shared/types.js";

// The fake satisfies RedisLike (so it can stand in for the real client) plus a few
// test-only handles for assertions.
export interface FakeRedis extends RedisLike {
  _store: Map<string, unknown>;
  _sets: Map<string, Set<string>>;
  _zsets: Map<string, Map<string, number>>;
  _lists: Map<string, string[]>;
}

interface Seed {
  store?: Record<string, unknown>;
  sets?: Record<string, string[]>;
  zsets?: Record<string, Record<string, number | string>>;
  lists?: Record<string, string[]>; // index 0 is the head, as Redis returns it
}

// Resolve a Redis list index pair to inclusive array bounds: negative indices
// count back from the end, out-of-range ones clamp. Callers treat from > to as
// the empty range.
const listRange = (len: number, start: number, stop: number): [number, number] => [
  Math.max(0, start < 0 ? len + start : start),
  Math.min(len - 1, stop < 0 ? len + stop : stop),
];

export function createFakeRedis(seed: Seed = {}): FakeRedis {
  const store = new Map<string, unknown>(); // key -> value (string | number | array | object)
  const sets = new Map<string, Set<string>>(); // key -> Set<string>
  const zsets = new Map<string, Map<string, number>>(); // key -> Map<member, score>
  const lists = new Map<string, string[]>(); // key -> head-first array

  const api: FakeRedis = {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value, opts = {}) {
      // nx: only set if absent (lock acquisition). Returns null on contention.
      if (opts.nx && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async del(...keys) {
      let n = 0;
      for (const k of keys) {
        if (store.delete(k)) n++;
        sets.delete(k);
        zsets.delete(k);
        lists.delete(k);
      }
      return n;
    },
    async incrby(key, by) {
      const next = Number(store.get(key) || 0) + by;
      store.set(key, next);
      return next;
    },
    async expire() {
      return 1; // TTLs are no-ops in tests
    },
    async smembers(key) {
      const s = sets.get(key);
      return s ? [...s] : [];
    },
    async sadd(key, ...members) {
      const s = sets.get(key) ?? new Set<string>();
      for (const m of members) s.add(m);
      sets.set(key, s);
      return members.length;
    },
    async zadd(key, ...entries) {
      const z = zsets.get(key) ?? new Map<string, number>();
      for (const e of entries) z.set(e.member, e.score);
      zsets.set(key, z);
      return entries.length;
    },
    async zrange(key, start, stop, opts = {}) {
      const z = zsets.get(key) ?? new Map<string, number>();
      const sorted = [...z.entries()].sort((a, b) => a[1] - b[1]); // score asc
      const end = stop === -1 ? sorted.length - 1 : stop;
      const slice = sorted.slice(start, end + 1);
      return opts.withScores ? slice.flatMap(([m, s]) => [m, s]) : slice.map(([m]) => m);
    },
    async zremrangebyscore(key, min, max) {
      const z = zsets.get(key);
      if (!z) return 0;
      let removed = 0;
      for (const [m, s] of [...z.entries()]) {
        if (s >= min && s <= max) { // both ends inclusive, as in Redis
          z.delete(m);
          removed++;
        }
      }
      return removed;
    },
    async zremrangebyrank(key, start, stop) {
      const z = zsets.get(key);
      if (!z) return 0;
      const sorted = [...z.entries()].sort((a, b) => a[1] - b[1]); // rank = score asc
      const len = sorted.length;
      // Negative ranks count back from the end, so -(N+1) as `stop` keeps the
      // last N members - the form the history cap relies on.
      const from = Math.max(0, start < 0 ? len + start : start);
      const to = Math.min(len - 1, stop < 0 ? len + stop : stop);
      let removed = 0;
      for (let i = from; i <= to; i++) {
        z.delete(sorted[i][0]);
        removed++;
      }
      return removed;
    },
    async lpush(key, ...values) {
      const l = lists.get(key) ?? [];
      // Redis pushes each value onto the head in turn, so a multi-value push ends
      // up reversed relative to the argument order.
      for (const v of values) l.unshift(v);
      lists.set(key, l);
      return l.length;
    },
    async lrange(key, start, stop) {
      const l = lists.get(key) ?? [];
      const [from, to] = listRange(l.length, start, stop);
      return from > to ? [] : l.slice(from, to + 1);
    },
    async ltrim(key, start, stop) {
      const l = lists.get(key);
      if (!l) return "OK";
      const [from, to] = listRange(l.length, start, stop);
      // An empty result deletes the key in Redis, not leaves an empty list.
      if (from > to) lists.delete(key);
      else lists.set(key, l.slice(from, to + 1));
      return "OK";
    },
    async mget(...keys) {
      return keys.map((k) => (store.has(k) ? store.get(k) : null));
    },
    pipeline(): RedisPipelineLike {
      const ops: [string, unknown[]][] = [];
      const push = (name: string) => (...args: unknown[]): RedisPipelineLike => {
        ops.push([name, args]);
        return queued; // chainable
      };
      const queued: RedisPipelineLike = {
        set: push("set"),
        del: push("del"),
        incrby: push("incrby"),
        expire: push("expire"),
        sadd: push("sadd"),
        zadd: push("zadd"),
        zremrangebyscore: push("zremrangebyscore"),
        zremrangebyrank: push("zremrangebyrank"),
        lpush: push("lpush"),
        ltrim: push("ltrim"),
        get: push("get"),
        exec: async () => {
          const results: unknown[] = [];
          const dispatch = api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
          for (const [name, args] of ops) results.push(await dispatch[name](...args));
          return results;
        },
      };
      return queued;
    },
    // Test-only handles for assertions.
    _store: store,
    _sets: sets,
    _zsets: zsets,
    _lists: lists,
  };

  for (const [k, v] of Object.entries(seed.store ?? {})) store.set(k, v);
  for (const [k, v] of Object.entries(seed.sets ?? {})) sets.set(k, new Set(v));
  for (const [k, v] of Object.entries(seed.zsets ?? {})) {
    zsets.set(k, new Map(Object.entries(v).map(([m, s]) => [m, Number(s)])));
  }
  for (const [k, v] of Object.entries(seed.lists ?? {})) lists.set(k, [...v]);

  return api;
}
