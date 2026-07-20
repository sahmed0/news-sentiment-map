// Tiny structured-logging + timing helper shared across the cron pipeline.
// Keeps every log line in a consistent `[Tag] message key=value key=value` shape
// so Vercel function logs are easy to scan/grep. Timing helpers are millisecond
// wall-clock deltas. Per-article (noisiest) logging is gated behind DEBUG_PIPELINE.

type Fields = Record<string, unknown> | null | undefined;

export const now = (): number => Date.now();
export const since = (start: number): number => Date.now() - start;

// Render an object as space-separated `key=value` pairs, skipping undefined/null
// values so optional fields don't clutter the line.
export function kv(fields: Fields): string {
  if (!fields) return "";
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
}

const line = (tag: string, msg: string, fields?: Fields): string => {
  const tail = kv(fields);
  return `[${tag}] ${msg}${tail ? ` ${tail}` : ""}`;
};

export const log = (tag: string, msg: string, fields?: Fields): void =>
  console.log(line(tag, msg, fields));
export const warn = (tag: string, msg: string, fields?: Fields): void =>
  console.warn(line(tag, msg, fields));
export const err = (tag: string, msg: string, fields?: Fields): void =>
  console.error(line(tag, msg, fields));

// Verbose per-article logging - off unless DEBUG_PIPELINE=1 so normal ticks stay quiet.
export const DEBUG = process.env.DEBUG_PIPELINE === "1";
export const debug = (tag: string, msg: string, fields?: Fields): void => {
  if (DEBUG) console.log(line(tag, msg, fields));
};
