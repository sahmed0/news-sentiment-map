// Disk cache for every external call the eval makes (dataset download, Azure
// translations, HuggingFace scores). Keyed by sha256(task + payload), so a run
// that crashes half-way re-spends nothing on the next attempt: we pay
// for each distinct request exactly once, ever.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// eval/data/ is gitignored; eval/out/ (results) is not.
export const DATA_DIR = fileURLToPath(new URL("./data/", import.meta.url));

// Dry-run responses come from fixtures, not from the providers. They live in a
// SEPARATE directory so a fixture score can never be served to a later live run
// as if it were real model output.
export const CACHE_DIR = join(DATA_DIR, "cache");
export const DRY_RUN_CACHE_DIR = join(DATA_DIR, "cache-dryrun");

export function cacheDirFor(dryRun: boolean): string {
  return dryRun ? DRY_RUN_CACHE_DIR : CACHE_DIR;
}

// The payload is stringified rather than hashed field-by-field so that any
// change to a request (model URL, target language, the text itself) is a miss.
export function cacheKey(task: string, payload: unknown): string {
  return createHash("sha256").update(`${task}\0${JSON.stringify(payload)}`).digest("hex");
}

function entryPath(dir: string, key: string): string {
  return join(dir, `${key}.json`);
}

export function readCache<T>(dir: string, key: string): T | null {
  const file = entryPath(dir, key);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    // A truncated entry (killed mid-write) must degrade to a miss, not a crash.
    return null;
  }
}

export function writeCache(dir: string, key: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(entryPath(dir, key), JSON.stringify(value), "utf8");
}

// Wrap one external call. `fn` runs only on a miss.
//
// CONTRACT: whatever `fn` resolves with is written to disk and served forever.
// A caller that resolves with a *degraded* value therefore poisons the cache
// permanently and for free - no later run makes a request that could notice. The
// first live run did exactly this: a rate-limited Azure leg resolved with 150
// empty strings, which cached as a legitimate answer. So `fn` must THROW on
// failure, never resolve with a placeholder; a rejection skips writeCache and
// leaves the miss intact. See the wrappers in pipeline.ts.
export async function cached<T>(
  dir: string,
  task: string,
  payload: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const key = cacheKey(task, payload);
  const hit = readCache<T>(dir, key);
  if (hit !== null) return hit;
  const value = await fn();
  writeCache(dir, key, value);
  return value;
}
