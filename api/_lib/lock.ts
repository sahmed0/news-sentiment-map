// api/_lib/lock.ts - The refresh tick's mutual-exclusion lock.
// Kept in its own import-free module so every importer gets the real strings:
// cron-refresh.test.ts mocks the whole of refresh-core (any export its factory
// doesn't list throws on read, even from a helper like fakeRedis.ts), and the
// handler module would drag the whole fetch pipeline into every backend test.

export const LOCK_KEY = "sentiment:refresh:lock";

// Compare-and-delete: only the invocation that still owns the lock may release
// it. Without this, a tick that outlived LOCK_TTL would delete the lock its
// successor had already acquired, letting a third tick start alongside it.
export const LOCK_RELEASE_LUA =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
