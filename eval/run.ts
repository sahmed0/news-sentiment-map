// Eval CLI.
//
//   pnpm eval -- --task all                 live run (spends API credits)
//   pnpm eval -- --task all --dry-run       fixtures only, no network
//   pnpm eval -- --task accuracy --limit 30 short live smoke test
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HF_ENGLISH_MODEL } from "../api/_lib/sentiment-fetch.js";
import { DATA_DIR, cacheDirFor } from "./cache.js";
import {
  DEFAULT_PER_CLASS,
  NEWSMTSC_URL,
  SAMPLE_SEED,
  loadAccuracySample,
  stratifiedSample,
  type LabelledItem,
} from "./datasets.js";
import {
  AZURE_DEFAULT_CHARS_PER_MINUTE,
  AZURE_GAP_MS,
  HF_BATCH,
  HF_GAP_MS,
  preflightAzure,
  scoreEnglish,
  translateTo,
  translateToEnglish,
  type PipelineOptions,
} from "./pipeline.js";
import {
  classificationReport,
  driftStats,
  productionBucket,
  thresholdSweep,
  type AccuracyResult,
  type DriftResult,
} from "./metrics.js";
import { renderAccuracyTables, renderDriftTables } from "./tables.js";
import { installFixtureFetch } from "./fixtures/http.js";

export const OUT_DIR = fileURLToPath(new URL("./out/", import.meta.url));
export const DRY_RUN_OUT_DIR = join(DATA_DIR, "dry-run-out");

export const DRIFT_LANGUAGES = ["fr", "de", "ar", "ja", "pt"] as const;
export type DriftLanguage = (typeof DRIFT_LANGUAGES)[number];
export const DRIFT_ITEMS = 100;

const MIN_PAIR_RATE = 0.8;
// Distinct from SAMPLE_SEED so the drift subset is not simply the first slice of
// the accuracy sample's own shuffle.
const DRIFT_SEED = SAMPLE_SEED + 1;
const SWEEP_THRESHOLDS = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3];

export type Task = "accuracy" | "drift" | "all";

export interface Args {
  task: Task;
  dryRun: boolean;
  limit: number | null;
  out: string | null;
  languages: DriftLanguage[];
  driftItems: number | null;
}

const USAGE = `Usage: pnpm eval -- --task accuracy|drift|all [--dry-run] [--limit N]
                    [--languages ${DRIFT_LANGUAGES.join(",")}] [--drift-items N] [--out DIR]`;

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    task: "all",
    dryRun: false,
    limit: null,
    out: null,
    languages: [...DRIFT_LANGUAGES],
    driftItems: null,
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
      case "--limit": {
        const value = Number(argv[++i]);
        if (!Number.isInteger(value) || value < 1) throw new Error(`--limit must be a positive integer\n${USAGE}`);
        args.limit = value;
        break;
      }
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
      case "--drift-items": {
        const value = Number(argv[++i]);
        if (!Number.isInteger(value) || value < 1) {
          throw new Error(`--drift-items must be a positive integer\n${USAGE}`);
        }
        args.driftItems = value;
        break;
      }
      case "--help":
      case "-h":
        throw new Error(USAGE);
      default:
        throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
    }
  }
  return args;
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

// Study 1: how well the production path classifies labelled news sentences.
// Returns each item's direct English score so --task all can hand them to the
// drift study instead of paying to compute them twice.
export async function runAccuracy(
  opts: PipelineOptions,
  outDir: string,
  perClass: number,
): Promise<Map<string, number | null>> {
  const items = await loadAccuracySample(opts.cacheDir, perClass);
  console.log(`[accuracy] scoring ${items.length} sentences`);
  const scores = await scoreEnglish(items.map((it) => it.text), opts);

  const byId = new Map<string, number | null>();
  const scored: { label: LabelledItem["label"]; score: number }[] = [];
  items.forEach((item, i) => {
    const score = scores[i] ?? null;
    byId.set(item.id, score);
    if (score !== null) scored.push({ label: item.label, score });
  });

  const result: AccuracyResult = {
    generatedAt: new Date().toISOString(),
    model: HF_ENGLISH_MODEL,
    dataset: {
      name: "NewsMTSC (rw, test split)",
      url: NEWSMTSC_URL,
      filter: "sentence-level labels from targets that all share one polarity",
      seed: SAMPLE_SEED,
    },
    n: scored.length,
    unscored: items.length - scored.length,
    production: classificationReport(
      scored.map((it) => ({ actual: it.label, predicted: productionBucket(it.score) })),
    ),
    thresholdSweep: thresholdSweep(scored, SWEEP_THRESHOLDS),
  };

  writeOutputs(outDir, "accuracy", result, renderAccuracyTables(result));
  console.log(`[accuracy] accuracy ${result.production.accuracy}, macro-F1 ${result.production.macroF1}`);
  return byId;
}

// What the drift study is about to spend, printed before the first request.
// So a run that would exceed a credit limit can be interrupted
// before it starts rather than discovered afterwards.
function logDriftBudget(texts: readonly string[], languages: readonly string[]): void {
  const chars = texts.reduce((sum, t) => sum + t.length, 0);
  const docs = texts.length * languages.length * 2; // out and back
  const hfRows = texts.length * languages.length;
  const totalChars = chars * languages.length * 2;
  console.log(
    `[drift] budget: ${languages.length} language(s) x ${texts.length} items -> ` +
      `${docs} Azure documents (~${Math.round(totalChars / 1000)}K characters), ` +
      `${hfRows} HuggingFace rows in ${Math.ceil(texts.length / HF_BATCH) * languages.length} requests. ` +
      `Anything already cached is free.`,
  );
  // Azure meters characters per minute, so an uncached run is paced, not slow.
  // Saying so up front stops the wait looking like a hang.
  const minutes = totalChars / AZURE_DEFAULT_CHARS_PER_MINUTE;
  if (minutes > 1) {
    console.log(
      `[drift] Azure pacing: ~${Math.ceil(minutes)} min minimum for the uncached portion ` +
        `(${AZURE_DEFAULT_CHARS_PER_MINUTE} characters/min; raise AZURE_CHARS_PER_MINUTE on a paid tier).`,
    );
  }
}

// Study 2: does routing a headline through the production translation pivot
// change its score? English -> lang -> English -> score, vs. scoring directly.
export async function runDrift(
  opts: PipelineOptions,
  outDir: string,
  count: number,
  languages: readonly DriftLanguage[],
  baseScores?: Map<string, number | null>,
): Promise<DriftResult> {
  const sample = await loadAccuracySample(opts.cacheDir, DEFAULT_PER_CLASS);
  // NewsMTSC carries no per-item label confidence, so this is a seeded subset of
  // the accuracy sample. It is drawn per class rather than off the top, because
  // the sample is stored label-sorted, taking the first N would make the whole
  // drift study negative-only.
  const items = stratifiedSample(sample, Math.max(1, Math.floor(count / 3)), DRIFT_SEED);
  const texts = items.map((it) => it.text);

  logDriftBudget(texts, languages);
  // One tiny call before anything expensive: a rate-limited or mis-keyed Azure
  // resource should cost a second, not a language of round trips. Under
  // --dry-run this goes to the fixture router, so the check is exercised too.
  await preflightAzure();

  let base: (number | null)[];
  if (baseScores && items.every((it) => baseScores.has(it.id))) {
    base = items.map((it) => baseScores.get(it.id) ?? null);
    console.log(`[drift] reusing ${items.length} English scores from the accuracy task`);
  } else {
    console.log(`[drift] scoring ${items.length} sentences in English`);
    base = await scoreEnglish(texts, opts);
  }

  const perLanguage: DriftResult["languages"] = {};
  for (const lang of languages) {
    console.log(`[drift] ${lang}: translating out, back, and rescoring`);
    const translated = await translateTo(texts, lang, opts);
    const returned = await translateToEnglish(translated, opts);
    const variant = await scoreEnglish(returned, opts);
    const pairs: { base: number; variant: number }[] = [];
    items.forEach((_, i) => {
      const b = base[i];
      const v = variant[i];
      // Drop an unscorable item on either leg as it provides no comparison,
      // the per-language `n` shows how many survived.
      if (typeof b === "number" && typeof v === "number") pairs.push({ base: b, variant: v });
    });
    // driftStats over zero pairs returns flipRate 0 and meanAbsDelta 0, which is
    // indistinguishable from a language that survives the round trip perfectly.
    // The first live run printed exactly that for `fr` after Azure rate-limited
    // the return leg. A thin sample must abort the study, not quietly publish.
    if (pairs.length < Math.ceil(items.length * MIN_PAIR_RATE)) {
      throw new Error(
        `[drift] ${lang}: only ${pairs.length}/${items.length} items produced a comparable pair ` +
          `(need ${Math.ceil(items.length * MIN_PAIR_RATE)}). Refusing to write statistics from a ` +
          `sample this thin - check the Azure/HuggingFace errors above.`,
      );
    }
    perLanguage[lang] = driftStats(pairs);
    console.log(
      `[drift] ${lang}: n ${perLanguage[lang].n}, flip rate ${perLanguage[lang].flipRate}, mean |delta| ${perLanguage[lang].meanAbsDelta}`,
    );
  }

  const result: DriftResult = {
    generatedAt: new Date().toISOString(),
    model: HF_ENGLISH_MODEL,
    n: items.length,
    languages: perLanguage,
  };
  writeOutputs(outDir, "drift", result, renderDriftTables(result));
  return result;
}

export async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  let restoreFetch: (() => void) | null = null;
  if (args.dryRun) restoreFetch = installFixtureFetch();
  else requireEnv();

  const opts: PipelineOptions = {
    cacheDir: cacheDirFor(args.dryRun),
    gapMs: args.dryRun ? 0 : HF_GAP_MS,
    azureGapMs: args.dryRun ? 0 : AZURE_GAP_MS,
  };
  const outDir = args.out ?? (args.dryRun ? DRY_RUN_OUT_DIR : OUT_DIR);
  const perClass = args.limit ? Math.max(1, Math.floor(args.limit / 3)) : DEFAULT_PER_CLASS;
  // --drift-items sets the per-language sample directly; --limit caps both studies.
  const driftCount = Math.min(args.driftItems ?? DRIFT_ITEMS, args.limit ?? Infinity);

  console.log(`[eval] task=${args.task} dryRun=${args.dryRun} out=${outDir}`);
  try {
    let baseScores: Map<string, number | null> | undefined;
    if (args.task === "accuracy" || args.task === "all") {
      baseScores = await runAccuracy(opts, outDir, perClass);
    }
    if (args.task === "drift" || args.task === "all") {
      await runDrift(opts, outDir, driftCount, args.languages, baseScores);
    }
  } finally {
    restoreFetch?.();
  }
  console.log(`[eval] done - outputs in ${outDir}`);
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
