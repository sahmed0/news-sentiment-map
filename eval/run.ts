// Eval CLI.
//
//   pnpm eval -- --task all --drift-batches 1  live smoke run: the full run's first batches
//   pnpm eval -- --task all                    live run (spends API credits, asks first)
//   pnpm eval -- --task all --dry-run          fixtures only, no network
//   pnpm eval -- --task all --offline          cache only; a miss throws
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FETCH_TIMEOUT_MS, HF_ENGLISH_MODEL } from "../api/_lib/sentiment-fetch.js";
import type { SentimentBucket } from "../shared/types.js";
import { DATA_DIR, cacheDirFor } from "./cache.js";
import {
  EVAL_SEED,
  MAX_TEXT_CHARS,
  NEWSMTSC_COMMIT,
  NEWSMTSC_SPLITS,
  NEWSMTSC_URLS,
  articleKey,
  loadPool,
  storyKey,
  stratifiedSample,
  type LabelledItem,
  type NewsmtscSplit,
  type Pool,
} from "./datasets.js";
import {
  AZURE_BATCH,
  AZURE_GAP_MS,
  HF_GAP_MS,
  azureCharsPerMinute,
  getSpend,
  planRoundTrip,
  planScore,
  preflightAzure,
  resetAzureRateLimit,
  resetSpend,
  scoreEnglish,
  setAzureCharCap,
  translateTo,
  translateToEnglish,
  type EvalSpend,
  type PipelineOptions,
  type ScorePlan,
} from "./pipeline.js";
import {
  BUCKETS,
  RESULT_FORMAT_VERSION,
  classificationReport,
  productionBucket,
  thresholdSweep,
  type AccuracyItemRecord,
  type AccuracyResult,
  type ClassificationReport,
  type DriftItemRecord,
  type DriftResult,
  type PoolSummary,
  type SpendSummary,
} from "./metrics.js";
import { BOOTSTRAP_B, accuracyIntervals, clusterIntervals, pairedMargin, sweepMargins } from "./stats.js";
import { afinnBucket, afinnReport, majorityClassReport, majorityLabel } from "./baselines.js";
import { languageDrift, pairwiseFlipDiffs } from "./drift.js";
import { renderAccuracyTables, renderDriftTables } from "./tables.js";
import { installFixtureFetch } from "./fixtures/http.js";

export const OUT_DIR = fileURLToPath(new URL("./out/", import.meta.url));
export const DRY_RUN_OUT_DIR = join(DATA_DIR, "dry-run-out");
export const SMOKE_OUT_DIR = join(DATA_DIR, "smoke-out");

export const DRIFT_LANGUAGES = ["fr", "de", "ar", "ja", "pt"] as const;
export type DriftLanguage = (typeof DRIFT_LANGUAGES)[number];
export const DRIFT_ITEMS = 600;
// Production shares the Azure key and its 2M/month quota, so a run is capped
// well inside it.
export const DEFAULT_MAX_AZURE_CHARS = 1_000_000;
// The neutral band the map ships with (src/lib/sentiment.ts).
const SHIPPED_BAND = 0.1;

const MIN_PAIR_RATE = 0.8;
const SWEEP_THRESHOLDS = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3];

export type Task = "accuracy" | "drift" | "all";

export interface Args {
  task: Task;
  dryRun: boolean;
  offline: boolean;
  limit: number | null;
  out: string | null;
  languages: DriftLanguage[];
  driftItems: number | null;
  yes: boolean;
  maxAzureChars: number;
  driftBatches: number | null;
}

const USAGE = `Usage: pnpm eval -- --task accuracy|drift|all [--dry-run] [--offline] [--limit N]
                    [--languages ${DRIFT_LANGUAGES.join(",")}] [--drift-items N] [--drift-batches N]
                    [--yes] [--max-azure-chars N] [--out DIR]`;

const positiveInt = (raw: string | undefined, flag: string): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer\n${USAGE}`);
  return value;
};

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    task: "all",
    dryRun: false,
    offline: false,
    limit: null,
    out: null,
    languages: [...DRIFT_LANGUAGES],
    driftItems: null,
    yes: false,
    maxAzureChars: DEFAULT_MAX_AZURE_CHARS,
    driftBatches: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--task": {
        const value = argv[++i];
        if (value !== "accuracy" && value !== "drift" && value !== "all") {
          throw new Error(`--task must be accuracy|drift|all\n${USAGE}`);
        }
        args.task = value;
        break;
      }
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--offline":
        args.offline = true;
        break;
      // pnpm passes the `--` in `pnpm eval -- --task all` through to the
      // script, so ignore it.
      case "--":
        break;
      case "--limit":
        args.limit = positiveInt(argv[++i], "--limit");
        break;
      case "--out": {
        const value = argv[++i];
        if (!value) throw new Error(`--out needs a directory\n${USAGE}`);
        args.out = value;
        break;
      }
      // Lets a rate-limited run be drip-fed a language or two at a time. Each
      // completed language is cached, so the eventual full run re-spends nothing.
      case "--languages": {
        const value = argv[++i];
        if (!value) throw new Error(`--languages needs a comma-separated list\n${USAGE}`);
        // Split on whitespace as well as commas: PowerShell reads an unquoted
        // `fr,de` as an array literal and hands the process "fr de", so the
        // obvious invocation would otherwise fail with a confusing error.
        const requested = value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
        if (!requested.length) throw new Error(`--languages needs a comma-separated list\n${USAGE}`);
        const unknown = requested.filter(
          (lang): boolean => !(DRIFT_LANGUAGES as readonly string[]).includes(lang),
        );
        if (unknown.length) {
          throw new Error(
            `--languages: unknown language(s) ${unknown.join(", ")}; supported: ${DRIFT_LANGUAGES.join(", ")}\n${USAGE}`,
          );
        }
        args.languages = requested as DriftLanguage[];
        break;
      }
      case "--drift-items":
        args.driftItems = positiveInt(argv[++i], "--drift-items");
        break;
      case "--drift-batches":
        args.driftBatches = positiveInt(argv[++i], "--drift-batches");
        break;
      case "--yes":
        args.yes = true;
        break;
      case "--max-azure-chars":
        args.maxAzureChars = positiveInt(argv[++i], "--max-azure-chars");
        break;
      case "--help":
      case "-h":
        throw new Error(USAGE);
      default:
        throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
    }
  }
  // Either flag changes the drift sample, and then the smoke run's cache keys
  // would no longer be the full run's. --languages is fine: each language's
  // batches are keyed separately.
  if (args.driftBatches !== null && (args.limit !== null || args.driftItems !== null)) {
    throw new Error(
      `--drift-batches runs the full run's own first batches, so it cannot be combined with --limit or --drift-items\n${USAGE}`,
    );
  }
  return args;
}

// A smoke run's drift numbers come from one batch of one class, do not write
// to eval/out.
export function resolveOutDir(args: Args): string {
  const outDir = args.out ?? (args.dryRun ? DRY_RUN_OUT_DIR : args.driftBatches ? SMOKE_OUT_DIR : OUT_DIR);
  // path.relative rather than string equality, so a trailing slash or (on
  // Windows) a case difference cannot slip past.
  if (args.driftBatches !== null && relative(resolve(OUT_DIR), resolve(outDir)) === "") {
    throw new Error(
      "--drift-batches is a smoke run; its drift numbers are not results and must not be written to eval/out/. " +
        "Drop --out or point it elsewhere.",
    );
  }
  return outDir;
}

// A live run without credentials would burn wall-clock and produce all-null
// scores, so fail before the first request instead.
function requireEnv(): void {
  const missing = ["HUGGINGFACE_API_KEY", "AZURE_TRANSLATOR_KEY"].filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(
      `Missing env var(s): ${missing.join(", ")}. Set them (see eval/README.md) or pass --dry-run.`,
    );
  }
}

function writeOutputs(outDir: string, name: string, json: unknown, markdown: string): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(json, null, 2)}\n`, "utf8");
  writeFileSync(join(outDir, `${name}-tables.md`), markdown, "utf8");
}

// One record per line. Scores are written unrounded: a 4-dp score of exactly
// +/-0.1 would land in a different bucket when the results are recomputed
// from this file.
function writeItems(outDir: string, name: string, records: readonly unknown[]): void {
  mkdirSync(outDir, { recursive: true });
  const body = records.map((record) => JSON.stringify(record)).join(",\n");
  writeFileSync(join(outDir, `${name}.json`), `[\n${body}\n]\n`, "utf8");
}

// The model repo's current commit on the Hub, recorded as provenance. The
// inference router does not promise to serve that revision, so it is not proof
// of the weights that scored the run. Never fails the run.
export async function fetchModelRevision(
  modelUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const repo = /\/models\/(.+)$/.exec(modelUrl)?.[1];
    if (!repo) throw new Error(`cannot find a model repo in ${modelUrl}`);
    const res = await fetchImpl(`https://huggingface.co/api/models/${repo}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: unknown = await res.json();
    const sha = typeof body === "object" && body !== null ? (body as { sha?: unknown }).sha : undefined;
    if (typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha)) return sha;
    throw new Error("response has no 40-hex sha");
  } catch (err) {
    console.warn(
      `[eval] model revision lookup failed (${err instanceof Error ? err.message : String(err)}); recording null`,
    );
    return null;
  }
}

async function promptConfirm(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Proceed and spend this? [y/N] ");
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

const fmt = (v: number): string => v.toLocaleString("en-GB");

const classCountsOf = (items: readonly { label: SentimentBucket }[]): Record<SentimentBucket, number> => {
  const counts = {} as Record<SentimentBucket, number>;
  for (const label of BUCKETS) counts[label] = items.filter((it) => it.label === label).length;
  return counts;
};

const spendSince = (before: EvalSpend): SpendSummary => {
  const now = getSpend();
  return {
    hfRequests: now.hfRequests - before.hfRequests,
    hfRows: now.hfRows - before.hfRows,
    azureRequests: now.azureRequests - before.azureRequests,
    azureChars: now.azureChars - before.azureChars,
  };
};

interface AccuracyContext {
  pool: Pool;
  items: LabelledItem[];
  sample: AccuracyResult["sample"];
  modelRevision: string | null;
  live: boolean;
  spendBefore: EvalSpend;
}

function poolSummary(pool: Pool): PoolSummary {
  const splits = {} as PoolSummary["splits"];
  for (const split of NEWSMTSC_SPLITS) {
    splits[split] = {
      url: NEWSMTSC_URLS[split],
      rows: pool.rows[split],
      items: pool.items.filter((it) => it.split === split).length,
    };
  }
  return {
    name: "NewsMTSC (rw: test + dev + train)",
    commit: NEWSMTSC_COMMIT,
    filter:
      "sentence-level labels from targets that all share one polarity; cross-split duplicates folded together; " +
      `items over ${MAX_TEXT_CHARS} characters dropped`,
    splits,
    crossSplitDuplicates: pool.crossSplit,
    overlong: { maxChars: MAX_TEXT_CHARS, dropped: pool.overlong },
    size: pool.items.length,
    classCounts: classCountsOf(pool.items),
  };
}

// Study 1: how well the production path classifies labelled news sentences.
// Returns each item's direct English score so --task all can hand them to the
// drift study instead of paying to compute them twice.
export async function runAccuracy(
  opts: PipelineOptions,
  outDir: string,
  ctx: AccuracyContext,
): Promise<Map<string, number | null>> {
  const { items } = ctx;
  console.log(`[accuracy] scoring ${items.length} sentences`);
  const scores = await scoreEnglish(items.map((it) => it.text), opts, "accuracy");

  const byId = new Map<string, number | null>();
  const records: AccuracyItemRecord[] = [];
  const scored: { id: string; split: NewsmtscSplit; text: string; label: SentimentBucket; score: number }[] = [];
  items.forEach((item, i) => {
    const score = scores[i] ?? null;
    byId.set(item.id, score);
    records.push({ id: item.id, split: item.split, label: item.label, score });
    if (score !== null) scored.push({ id: item.id, split: item.split, text: item.text, label: item.label, score });
  });

  const seed = EVAL_SEED;
  const pairsOf = (list: typeof scored) =>
    list.map((it) => ({ actual: it.label, predicted: productionBucket(it.score) }));
  const production = classificationReport(pairsOf(scored));

  const clusterItems = (key: (id: string) => string) =>
    scored.map((it) => ({ cluster: key(it.id), actual: it.label, predicted: productionBucket(it.score) }));

  const perSplit = {} as AccuracyResult["perSplit"];
  for (const split of NEWSMTSC_SPLITS) {
    const report: ClassificationReport = classificationReport(pairsOf(scored.filter((it) => it.split === split)));
    perSplit[split] = { report, intervals: accuracyIntervals(report, { seed }) };
  }

  // Baselines use only the items the model scored, so both are judged on the
  // same set.
  const afinn = afinnReport(scored);
  const majority = majorityClassReport(scored);
  const sweepRows = thresholdSweep(scored, SWEEP_THRESHOLDS);
  const sweepVsShipped = sweepMargins(scored, SWEEP_THRESHOLDS, SHIPPED_BAND, { seed });

  const result: AccuracyResult = {
    formatVersion: RESULT_FORMAT_VERSION,
    generatedAt: new Date().toISOString(),
    model: HF_ENGLISH_MODEL,
    modelRevision: ctx.modelRevision,
    dataset: poolSummary(ctx.pool),
    sample: ctx.sample,
    n: scored.length,
    unscored: items.length - scored.length,
    production,
    intervals: accuracyIntervals(production, { seed }),
    clusterCheck: {
      article: clusterIntervals(clusterItems(articleKey), { seed }),
      story: clusterIntervals(clusterItems(storyKey), { seed }),
    },
    perSplit,
    baselines: {
      majorityClass: {
        label: majorityLabel(scored),
        accuracy: majority.accuracy,
        balancedAccuracy: majority.balancedAccuracy,
        macroF1: majority.macroF1,
      },
      afinn,
      afinnIntervals: accuracyIntervals(afinn, { seed }),
      modelOverAfinn: pairedMargin(
        scored.map((it) => ({
          actual: it.label,
          model: productionBucket(it.score),
          baseline: afinnBucket(it.text),
        })),
        { seed },
      ),
    },
    bootstrap: {
      b: BOOTSTRAP_B,
      seed,
      method: "percentile",
      sweepAdjustedAlpha: 0.05 / (SWEEP_THRESHOLDS.length - 1),
    },
    thresholdSweep: sweepRows.map((row, i) => ({ ...row, vsShipped: sweepVsShipped[i] })),
    spend: ctx.live ? spendSince(ctx.spendBefore) : null,
  };

  writeOutputs(outDir, "accuracy", result, renderAccuracyTables(result));
  writeItems(outDir, "accuracy-items", records);
  console.log(
    `[accuracy] balanced accuracy ${production.balancedAccuracy}, macro-F1 ${production.macroF1}`,
  );
  console.log(`[accuracy] accuracy ${production.accuracy} (reflects the sample's class mix)`);
  console.log(`[accuracy] AFINN-165 baseline: balanced accuracy ${afinn.balancedAccuracy}, macro-F1 ${afinn.macroF1}`);
  return byId;
}

interface DriftContext {
  pool: Pool;
  items: LabelledItem[];
  perClass: number;
  firstBatches: number | null;
  languages: readonly DriftLanguage[];
  baseScores: Map<string, number | null> | undefined;
  modelRevision: string | null;
  live: boolean;
  preflight: boolean;
  spendBefore: EvalSpend;
}

const clip = (text: string): string => (text.length > 120 ? `${text.slice(0, 117)}...` : text);

// Study 2: does routing a headline through the production translation pivot
// change its score? English -> lang -> English -> score, vs. scoring directly.
export async function runDrift(opts: PipelineOptions, outDir: string, ctx: DriftContext): Promise<DriftResult> {
  const { items, languages } = ctx;
  const texts = items.map((it) => it.text);

  if (opts.offline) console.log("[drift] --offline: every request must be a cache hit, so nothing is spent");
  // One tiny call before anything expensive: a rate-limited or mis-keyed Azure
  // resource should cost a second, not a language of round trips. Under
  // --dry-run this goes to the fixture router, so the check is exercised too.
  // Runs here rather than in main so its characters count in the drift study's
  // spend.
  if (ctx.preflight) await preflightAzure();

  let base: (number | null)[];
  const { baseScores } = ctx;
  if (baseScores && items.every((it) => baseScores.has(it.id))) {
    base = items.map((it) => baseScores.get(it.id) ?? null);
    console.log(`[drift] reusing ${items.length} English scores from the accuracy task`);
  } else {
    console.log(`[drift] scoring ${items.length} sentences in English`);
    base = await scoreEnglish(texts, opts, "drift base");
  }

  const variants = new Map<string, (number | null)[]>();
  for (const lang of languages) {
    console.log(`[drift] ${lang}: translating out, back, and rescoring`);
    const translated = await translateTo(texts, lang, opts);
    const returned = await translateToEnglish(translated, opts);
    // The only easy view of what Azure actually returned: cache files are
    // named by hash. Console only, never an output file.
    if (ctx.firstBatches !== null && ctx.live) {
      for (let i = 0; i < Math.min(2, texts.length); i++) {
        console.log(`[smoke] ${lang} #${i + 1}: ${clip(texts[i])} | ${clip(translated[i])} | ${clip(returned[i])}`);
      }
    }
    const variant = await scoreEnglish(returned, opts, `drift ${lang}`);
    const comparable = items.filter((_, i) => typeof base[i] === "number" && typeof variant[i] === "number").length;
    // driftStats over zero pairs returns flipRate 0 and meanAbsDelta 0, which is
    // indistinguishable from a language that survives the round trip perfectly.
    // The first live run printed exactly that for `fr` after Azure rate-limited
    // the return leg. A thin sample must abort the study, not quietly publish.
    if (comparable < Math.ceil(items.length * MIN_PAIR_RATE)) {
      throw new Error(
        `[drift] ${lang}: only ${comparable}/${items.length} items produced a comparable pair ` +
          `(need ${Math.ceil(items.length * MIN_PAIR_RATE)}). Refusing to write statistics from a ` +
          `sample this thin - check the Azure/HuggingFace errors above.`,
      );
    }
    variants.set(lang, variant);
  }

  // Drop an unscorable item on either leg as it provides no comparison; each
  // language's `n` shows how many survived.
  const records: DriftItemRecord[] = items.map((item, i) => ({
    id: item.id,
    split: item.split,
    label: item.label,
    base: base[i],
    variants: Object.fromEntries(languages.map((lang) => [lang, variants.get(lang)?.[i] ?? null])),
  }));

  const seed = EVAL_SEED;
  const poolSize = ctx.pool.items.length;
  const poolCounts = classCountsOf(ctx.pool.items);
  const poolShares = {} as Record<SentimentBucket, number>;
  for (const label of BUCKETS) poolShares[label] = poolSize ? Number((poolCounts[label] / poolSize).toFixed(4)) : 0;

  const perLanguage: DriftResult["languages"] = {};
  for (const lang of languages) {
    const stats = languageDrift(records, lang, { seed, poolShares });
    perLanguage[lang] = stats;
    console.log(
      `[drift] ${lang}: n ${stats.n}, flip rate ${stats.flipRate} (${stats.flips} flips), mean |delta| ${stats.meanAbsDelta}`,
    );
  }
  const pairwise = pairwiseFlipDiffs(records, languages, { seed });

  const result: DriftResult = {
    formatVersion: RESULT_FORMAT_VERSION,
    generatedAt: new Date().toISOString(),
    model: HF_ENGLISH_MODEL,
    modelRevision: ctx.modelRevision,
    sample: {
      seed,
      perClass: ctx.perClass,
      n: items.length,
      classCounts: classCountsOf(items),
      poolShares,
      firstBatches: ctx.firstBatches,
    },
    n: items.length,
    languages: perLanguage,
    pairwise: pairwise.pairs,
    bootstrap: { b: BOOTSTRAP_B, seed, method: "percentile", pairwiseAdjustedAlpha: pairwise.adjustedAlpha },
    spend: ctx.live ? spendSince(ctx.spendBefore) : null,
  };
  writeOutputs(outDir, "drift", result, renderDriftTables(result));
  writeItems(outDir, "drift-items", records);
  return result;
}

interface Plan {
  hfUncachedRequests: number;
  azureUncachedChars: number;
}

// What the run is about to spend, from the cache, before anything is sent. So
// the bill is shown first and a run over the cap stops here.
function planRun(
  args: Args,
  cacheDir: string,
  accuracyTexts: readonly string[] | null,
  drift: { texts: readonly string[]; perClass: number; fullCount: number } | null,
): Plan {
  let hf = 0;
  let azure = 0;
  if (accuracyTexts) {
    const p = planScore(accuracyTexts, cacheDir);
    hf += p.uncachedRequests;
    console.log(
      `[plan] accuracy: ${fmt(p.rows)} sentences -> ${fmt(p.requests)} HuggingFace requests (${fmt(p.uncachedRequests)} uncached)`,
    );
  }
  if (drift) {
    const langs = args.languages;
    const what =
      args.driftBatches !== null
        ? `${fmt(drift.texts.length)} of ${fmt(drift.fullCount)} sentences (--drift-batches ${args.driftBatches}: ` +
          `the full run's first ${args.driftBatches === 1 ? "batch" : `${args.driftBatches} batches`}, smoke run)`
        : `${fmt(drift.texts.length)} sentences (${fmt(drift.perClass)} per class)`;
    console.log(`[plan] drift: ${what} x ${langs.length} languages (${langs.join(", ")})`);
    // --task drift alone has no accuracy scores to reuse.
    if (!accuracyTexts) {
      const base: ScorePlan = planScore(drift.texts, cacheDir);
      hf += base.uncachedRequests;
      console.log(`[plan]   HuggingFace: ${fmt(base.uncachedRequests)} requests uncached for the direct English scores`);
    }
    let variantRequests = 0;
    for (const lang of langs) {
      const rt = planRoundTrip(drift.texts, lang, cacheDir);
      azure += rt.uncachedOutChars + rt.uncachedBackChars;
      variantRequests += rt.variant.uncachedRequests;
    }
    hf += variantRequests;
    console.log(
      `[plan]   Azure: ~${fmt(Math.round(azure / 1000) * 1000)} characters uncached ` +
        `(projected; cap ${fmt(args.maxAzureChars)}), ${fmt(drift.texts.length * langs.length * 2)} documents`,
    );
    console.log(`[plan]   HuggingFace: ${fmt(variantRequests)} requests uncached for the round-tripped text`);
  }
  // Azure meters characters per minute, so an uncached run waits between
  // batches. Saying so up front stops the wait looking like a hang. The
  // HuggingFace figure is rough: the courtesy gap plus a typical request time.
  const rate = azureCharsPerMinute();
  const azureMinutes = Math.ceil(azure / rate);
  const hfMinutes = Math.round((hf * (HF_GAP_MS + 2500)) / 60000);
  console.log(
    `[plan] wall clock: >= ~${azureMinutes} min of Azure pacing (${fmt(rate)} characters/min) + ~${hfMinutes} min of HuggingFace`,
  );
  if (args.dryRun) console.log("[plan] (dry run: fixture router, nothing is spent)");
  return { hfUncachedRequests: hf, azureUncachedChars: azure };
}

export interface MainDeps {
  confirm?: (plan: string) => Promise<boolean>; // default: a readline prompt
  cacheDir?: string; // tests only: overrides cacheDirFor()
  isTTY?: boolean; // tests only: overrides process.stdin.isTTY
}

// The order below is deliberate: the plan is printed, checked against the cap
// and confirmed before anything reaches a paid API, starting with the
// model-revision lookup.
export async function main(argv: readonly string[], deps: MainDeps = {}): Promise<void> {
  const args = parseArgs(argv);
  resetSpend();
  resetAzureRateLimit();
  setAzureCharCap(args.maxAzureChars);

  let restoreFetch: (() => void) | null = null;
  if (args.dryRun) restoreFetch = installFixtureFetch();
  // --offline makes no API calls, so it needs no API keys.
  else if (!args.offline) requireEnv();

  // Everything that can throw sits inside the try, so a dry run never leaves the
  // fixture fetch installed globally.
  try {
    const live = !args.dryRun && !args.offline;
    const opts: PipelineOptions = {
      cacheDir: deps.cacheDir ?? cacheDirFor(args.dryRun),
      gapMs: args.dryRun ? 0 : HF_GAP_MS,
      azureGapMs: args.dryRun ? 0 : AZURE_GAP_MS,
      offline: args.offline,
    };
    const outDir = resolveOutDir(args);
    console.log(
      `[eval] task=${args.task} dryRun=${args.dryRun} offline=${args.offline} seed=${EVAL_SEED}` +
        `${args.driftBatches !== null ? ` driftBatches=${args.driftBatches}` : ""} out=${outDir}`,
    );

    // The dataset download is free (GitHub raw).
    const pool = await loadPool(opts.cacheDir, opts.offline);
    const runAcc = args.task === "accuracy" || args.task === "all";
    const runDri = args.task === "drift" || args.task === "all";

    const accPerClass = args.limit ? Math.max(1, Math.floor(args.limit / 3)) : null;
    const accuracyItems = accPerClass ? stratifiedSample(pool.items, accPerClass, EVAL_SEED) : pool.items;
    const sample: AccuracyResult["sample"] = accPerClass
      ? { kind: "limit", perClass: accPerClass, seed: EVAL_SEED }
      : { kind: "full" };

    // --drift-items sets the drift sample directly; --limit caps both studies.
    // The same pool, seed and shuffle-then-slice mean a smaller per-class draw is
    // a subset of a larger one, so under --task all the drift sample always lies
    // inside the accuracy sample and its direct scores are reused.
    const driftCount = Math.min(args.driftItems ?? DRIFT_ITEMS, args.limit ?? Infinity);
    const driftPerClass = Math.max(1, Math.floor(driftCount / 3));
    const driftSample = stratifiedSample(pool.items, driftPerClass, EVAL_SEED);
    // A smoke run takes the first batches of the FULL sorted sample, never a
    // smaller draw. AZURE_BATCH is a multiple of HF_BATCH, so its first
    // N x AZURE_BATCH items are byte for byte the full run's first batches, and
    // their cache entries are reused. A smaller draw would batch differently.
    const driftItems =
      args.driftBatches !== null ? driftSample.slice(0, args.driftBatches * AZURE_BATCH) : driftSample;

    let plan: Plan | null = null;
    if (!args.offline) {
      plan = planRun(
        args,
        opts.cacheDir,
        runAcc ? accuracyItems.map((it) => it.text) : null,
        runDri
          ? { texts: driftItems.map((it) => it.text), perClass: driftPerClass, fullCount: driftSample.length }
          : null,
      );
      if (plan.azureUncachedChars > args.maxAzureChars) {
        throw new Error(
          `Projected Azure spend ~${fmt(plan.azureUncachedChars)} characters is over --max-azure-chars ` +
            `${fmt(args.maxAzureChars)}. Raise --max-azure-chars or run fewer --languages at a time.`,
        );
      }
    }

    if (live && plan) {
      if (plan.hfUncachedRequests === 0 && plan.azureUncachedChars === 0) {
        console.log("[eval] everything is cached; nothing will be spent");
      } else if (!args.yes) {
        const summary =
          `HuggingFace ${fmt(plan.hfUncachedRequests)} requests, ` +
          `Azure ~${fmt(plan.azureUncachedChars)} characters (projected)`;
        let ok: boolean;
        if (deps.confirm) ok = await deps.confirm(summary);
        else if (!(deps.isTTY ?? process.stdin.isTTY)) {
          throw new Error("Refusing to spend without confirmation: stdin is not a terminal. Re-run with --yes.");
        } else ok = await promptConfirm();
        if (!ok) throw new Error("Aborted: nothing was spent.");
      }
    }

    const modelRevision = live ? await fetchModelRevision(HF_ENGLISH_MODEL) : null;

    let baseScores: Map<string, number | null> | undefined;
    if (runAcc) {
      baseScores = await runAccuracy(opts, outDir, {
        pool,
        items: accuracyItems,
        sample,
        modelRevision,
        live,
        spendBefore: getSpend(),
      });
    }
    if (runDri) {
      await runDrift(opts, outDir, {
        pool,
        items: driftItems,
        perClass: driftPerClass,
        firstBatches: args.driftBatches,
        languages: args.languages,
        baseScores,
        modelRevision,
        live,
        // Never under --offline, which made no plan and must make no network calls.
        preflight: plan !== null && plan.azureUncachedChars > 0,
        spendBefore: getSpend(),
      });
    }

    if (live && plan) {
      const spent = getSpend();
      console.log(
        `[eval] spent: Azure ${fmt(spent.azureChars)} characters in ${fmt(spent.azureRequests)} requests ` +
          `(projected ${fmt(plan.azureUncachedChars)}), HuggingFace ${fmt(spent.hfRequests)} requests / ` +
          `${fmt(spent.hfRows)} rows (projected ${fmt(plan.hfUncachedRequests)})`,
      );
    }
    console.log(`[eval] done - outputs in ${outDir}`);
  } finally {
    restoreFetch?.();
  }
}

// Only run when invoked as a script; not as an imported module (eg. tests).
const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
