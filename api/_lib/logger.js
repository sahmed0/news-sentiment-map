// Tiny structured-logging + timing helper shared across the cron pipeline.
// Keeps every log line in a consistent `[Tag] message key=value key=value` shape
// so Vercel function logs are easy to scan/grep. Timing helpers are millisecond
// wall-clock deltas. Per-article (noisiest) logging is gated behind DEBUG_PIPELINE.

export const now = () => Date.now();
export const since = (start) => Date.now() - start;

// Render an object as space-separated `key=value` pairs, skipping undefined/null
// values so optional fields don't clutter the line.
export function kv(fields) {
  if (!fields) return "";
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

const line = (tag, msg, fields) => {
  const tail = kv(fields);
  return `[${tag}] ${msg}${tail ? ` ${tail}` : ""}`;
};

export const log = (tag, msg, fields) => console.log(line(tag, msg, fields));
export const warn = (tag, msg, fields) => console.warn(line(tag, msg, fields));
export const err = (tag, msg, fields) => console.error(line(tag, msg, fields));

// Verbose per-article logging - off unless DEBUG_PIPELINE=1 so normal ticks stay quiet.
export const DEBUG = process.env.DEBUG_PIPELINE === "1";
export const debug = (tag, msg, fields) => {
  if (DEBUG) console.log(line(tag, msg, fields));
};
