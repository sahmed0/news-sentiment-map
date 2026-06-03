// In-memory Upstash-Redis double. Implements only the methods the app actually
// calls (get/set/del/incrby/expire/smembers/sadd/zadd/zrange/mget + pipeline),
// with just enough fidelity for the scheduling, credit-ledger, and handler tests:
//   - set({ nx, ex }) returns "OK" or null so lock semantics work
//   - zrange({ withScores }) returns a flat [member, score, ...] sorted by score
//   - pipeline() queues ops and applies them on exec()
// TTLs (ex / expire) are intentionally no-ops: tests inject `now`, they don't
// wait for real expiry.

export function createFakeRedis(seed = {}) {
  const store = new Map(); // key -> value (string | number | array | object)
  const sets = new Map(); // key -> Set<string>
  const zsets = new Map(); // key -> Map<member, score>

  const api = {
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
      return sets.has(key) ? [...sets.get(key)] : [];
    },
    async sadd(key, ...members) {
      const s = sets.get(key) ?? new Set();
      for (const m of members) s.add(m);
      sets.set(key, s);
      return members.length;
    },
    async zadd(key, ...entries) {
      const z = zsets.get(key) ?? new Map();
      for (const e of entries) z.set(e.member, e.score);
      zsets.set(key, z);
      return entries.length;
    },
    async zrange(key, start, stop, opts = {}) {
      const z = zsets.get(key) ?? new Map();
      const sorted = [...z.entries()].sort((a, b) => a[1] - b[1]); // score asc
      const end = stop === -1 ? sorted.length - 1 : stop;
      const slice = sorted.slice(start, end + 1);
      return opts.withScores ? slice.flatMap(([m, s]) => [m, s]) : slice.map(([m]) => m);
    },
    async mget(...keys) {
      return keys.map((k) => (store.has(k) ? store.get(k) : null));
    },
    pipeline() {
      const ops = [];
      const queued = {};
      for (const name of ["set", "del", "incrby", "expire", "sadd", "zadd", "get"]) {
        queued[name] = (...args) => {
          ops.push([name, args]);
          return queued; // chainable
        };
      }
      queued.exec = async () => {
        const results = [];
        for (const [name, args] of ops) results.push(await api[name](...args));
        return results;
      };
      return queued;
    },
    // Test-only handles for assertions.
    _store: store,
    _sets: sets,
    _zsets: zsets,
  };

  for (const [k, v] of Object.entries(seed.store ?? {})) store.set(k, v);
  for (const [k, v] of Object.entries(seed.sets ?? {})) sets.set(k, new Set(v));
  for (const [k, v] of Object.entries(seed.zsets ?? {})) {
    zsets.set(k, new Map(Object.entries(v).map(([m, s]) => [m, Number(s)])));
  }

  return api;
}
