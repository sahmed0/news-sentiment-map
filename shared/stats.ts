// The statistics behind one country's displayed score. A country score is the
// mean of its scored headlines, so it carries a sampling error.
export interface HeadlineStats {
  n: number; // scored headlines behind the mean
  mean: number;
  sd: number; // sample standard deviation (n-1), 0 when n < 2
  se: number; // sd / sqrt(n), 0 when n < 2
}

// Returns null when nothing was scored as there is no mean to report, which is a
// different thing from a mean of zero. `undefined` is accepted alongside `null`
// because persistCountries' PersistResult types `score` as optional, so the array
// it passes is (number | null | undefined)[]; the typeof guard below handles all
// three uniformly.
export function headlineStats(scores: readonly (number | null | undefined)[]): HeadlineStats | null {
  const valid = scores.filter((s): s is number => typeof s === "number");
  const n = valid.length;
  if (n === 0) return null;
  const mean = valid.reduce((a, b) => a + b, 0) / n;
  // Bessel's correction: these headlines are a sample of the day's news, not the
  // population of it. With n = 1 the spread is undefined; report 0 and let the
  // caller decide what to say about it.
  if (n < 2) return { n, mean, sd: 0, se: 0 };
  const variance = valid.reduce((acc, s) => acc + (s - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  return { n, mean, sd, se: sd / Math.sqrt(n) };
}
