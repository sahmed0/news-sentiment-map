import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DRY_RUN_CACHE_DIR } from "../../eval/cache.js";
import { NEWSMTSC_URLS } from "../../eval/datasets.js";
import {
  DRIFT_LANGUAGES,
  DRY_RUN_OUT_DIR,
  OUT_DIR,
  SMOKE_OUT_DIR,
  main,
  parseArgs,
  resolveOutDir,
} from "../../eval/run.js";
import { fixtureFetch } from "../../eval/fixtures/http.js";
import {
  confusionMatrix,
  productionBucket,
  type AccuracyItemRecord,
  type AccuracyResult,
  type DriftItemRecord,
  type DriftResult,
} from "../../eval/metrics.js";

const readJson = <T>(dir: string, name: string): T => JSON.parse(readFileSync(join(dir, name), "utf8")) as T;

// eval/out/ by name and mtime: proves a run left it byte-for-byte untouched.
const outSnapshot = (): Record<string, number> =>
  Object.fromEntries(readdirSync(OUT_DIR).map((name) => [name, statSync(join(OUT_DIR, name)).mtimeMs]));

describe("parseArgs", () => {
  it("defaults to a full live run over every drift language", () => {
    expect(parseArgs([])).toEqual({
      task: "all",
      dryRun: false,
      offline: false,
      limit: null,
      out: null,
      languages: [...DRIFT_LANGUAGES],
      driftItems: null,
      yes: false,
      maxAzureChars: 1_000_000,
      driftBatches: null,
    });
  });

  it("reads every flag", () => {
    expect(
      parseArgs([
        "--task", "drift",
        "--dry-run",
        "--offline",
        "--limit", "30",
        "--out", "tmp",
        "--languages", "fr,ja",
        "--drift-items", "40",
        "--yes",
        "--max-azure-chars", "5000",
      ]),
    ).toEqual({
      task: "drift",
      dryRun: true,
      offline: true,
      limit: 30,
      out: "tmp",
      languages: ["fr", "ja"],
      driftItems: 40,
      yes: true,
      maxAzureChars: 5000,
      driftBatches: null,
    });
  });

  it("ignores the bare -- that pnpm 11 forwards from `pnpm eval -- --task all`", () => {
    expect(parseArgs(["--", "--task", "drift", "--offline"])).toMatchObject({ task: "drift", offline: true });
  });

  it("rejects an unknown task, a bad limit and stray arguments", () => {
    expect(() => parseArgs(["--task", "everything"])).toThrow(/--task must be/);
    expect(() => parseArgs(["--limit", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--limit", "2.5"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--wat"])).toThrow(/Unknown argument/);
  });

  it("rejects a cap that is not a positive integer", () => {
    expect(() => parseArgs(["--max-azure-chars", "0"])).toThrow(/--max-azure-chars must be a positive integer/);
    expect(() => parseArgs(["--max-azure-chars", "lots"])).toThrow(/--max-azure-chars must be a positive integer/);
  });

  it("accepts the space-separated list PowerShell produces from an unquoted fr,de", () => {
    // PowerShell reads `--languages fr,de` as an array literal and hands the
    // process the single argument "fr de". So must not reject it.
    expect(parseArgs(["--languages", "fr de"]).languages).toEqual(["fr", "de"]);
  });

  it("rejects a language the drift study does not cover", () => {
    // A typo must not silently shrink the study to the languages it did parse.
    expect(() => parseArgs(["--languages", "fr,klingon"])).toThrow(/unknown language\(s\) klingon/);
    expect(() => parseArgs(["--languages", ""])).toThrow(/comma-separated/);
    expect(() => parseArgs(["--drift-items", "0"])).toThrow(/positive integer/);
  });
});

describe("--drift-batches", () => {
  it("takes a positive integer", () => {
    expect(parseArgs(["--drift-batches", "2"]).driftBatches).toBe(2);
    expect(() => parseArgs(["--drift-batches", "0"])).toThrow(/--drift-batches must be a positive integer/);
    expect(() => parseArgs(["--drift-batches", "1.5"])).toThrow(/--drift-batches must be a positive integer/);
  });

  it("refuses the flags that would change the drift sample", () => {
    // Either one would draw a different sample, so none of the smoke run's
    // batches would be the full run's.
    expect(() => parseArgs(["--drift-batches", "1", "--limit", "30"])).toThrow(/cannot be combined/);
    expect(() => parseArgs(["--drift-items", "30", "--drift-batches", "1"])).toThrow(/cannot be combined/);
  });

  it("allows a subset of languages, which are keyed separately", () => {
    expect(parseArgs(["--drift-batches", "1", "--languages", "fr,ja"])).toMatchObject({
      driftBatches: 1,
      languages: ["fr", "ja"],
    });
  });
});

describe("resolveOutDir", () => {
  it("sends a smoke run to its own directory", () => {
    expect(resolveOutDir(parseArgs(["--drift-batches", "1"]))).toBe(SMOKE_OUT_DIR);
    expect(resolveOutDir(parseArgs(["--drift-batches", "1", "--dry-run"]))).toBe(DRY_RUN_OUT_DIR);
    expect(resolveOutDir(parseArgs(["--drift-batches", "1", "--out", "elsewhere"]))).toBe("elsewhere");
    expect(resolveOutDir(parseArgs([]))).toBe(OUT_DIR);
  });

  it("refuses eval/out/ for a smoke run, however it is spelled", () => {
    const refuse = (out: string): void => {
      expect(() => resolveOutDir(parseArgs(["--drift-batches", "1", "--out", out]))).toThrow(
        /must not be written to eval\/out/,
      );
    };
    refuse(OUT_DIR);
    refuse(OUT_DIR.replace(/[\\/]$/, ""));
  });

  it.skipIf(process.platform !== "win32")("refuses an upper-cased eval/out/ on Windows", () => {
    expect(() => resolveOutDir(parseArgs(["--drift-batches", "1", "--out", OUT_DIR.toUpperCase()]))).toThrow(
      /must not be written to eval\/out/,
    );
  });
});

describe("fixture fetch guard", () => {
  it("refuses any host that is not the dataset, Azure or HuggingFace", () => {
    // This throw is what makes --dry-run provably offline.
    expect(() => fixtureFetch("https://gnews.io/api/v4/top-headlines")).toThrow(/refusing to reach gnews.io/);
    // The model-revision lookup must never run under --dry-run either.
    expect(() => fixtureFetch("https://huggingface.co/api/models/x")).toThrow(/refusing to reach huggingface.co/);
  });
});

describe("end-to-end --dry-run", () => {
  let out: string;

  beforeAll(() => {
    // Start from a cold fixture cache so these assertions can never be satisfied
    // by entries an earlier fixture version wrote.
    rmSync(DRY_RUN_CACHE_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), "eval-out-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(out, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("writes valid accuracy and drift outputs without touching the network", async () => {
    await main(["--task", "all", "--dry-run", "--out", out]);

    expect(readdirSync(out).sort()).toEqual([
      "accuracy-items.json",
      "accuracy-tables.md",
      "accuracy.json",
      "drift-items.json",
      "drift-tables.md",
      "drift.json",
    ]);

    const accuracy = readJson<AccuracyResult>(out, "accuracy.json");
    expect(accuracy.formatVersion).toBe(2);
    expect(accuracy.model).toContain("twitter-roberta-base-sentiment-latest");
    expect(accuracy.modelRevision).toBeNull();
    expect(accuracy.spend).toBeNull();
    expect(accuracy.dataset.size).toBe(24);
    expect(accuracy.dataset.splits.test.rows).toBe(17);
    expect(accuracy.dataset.splits.dev.rows).toBe(8);
    expect(accuracy.dataset.splits.train.rows).toBe(8);
    expect(accuracy.dataset.overlong).toEqual({ maxChars: 2000, dropped: 0 });
    expect(accuracy.sample).toEqual({ kind: "full" });
    expect(accuracy.n).toBeGreaterThan(0);
    expect(Object.keys(accuracy.production.perClass).sort()).toEqual(["negative", "neutral", "positive"]);
    expect(accuracy.thresholdSweep.map((r) => r.t)).toEqual([0.05, 0.1, 0.15, 0.2, 0.25, 0.3]);

    // Every point estimate ships with an interval that contains it.
    for (const [point, [lo, hi]] of [
      [accuracy.production.accuracy, accuracy.intervals.accuracy],
      [accuracy.production.balancedAccuracy, accuracy.intervals.balancedAccuracy],
      [accuracy.production.macroF1, accuracy.intervals.macroF1],
    ] as const) {
      expect(lo).toBeLessThanOrEqual(point);
      expect(hi).toBeGreaterThanOrEqual(point);
    }
    expect(accuracy.bootstrap).toEqual({ b: 10000, seed: 20261027, method: "percentile", sweepAdjustedAlpha: 0.01 });

    expect(Object.keys(accuracy.perSplit)).toEqual(["test", "dev", "train"]);
    const splitN = Object.values(accuracy.perSplit).reduce((sum, s) => sum + s.report.n, 0);
    expect(splitN).toBe(accuracy.n);
    // The train fixture holds two sentences of article allsides_1000_401, and
    // articles 1018 and 1019 of story 408: the only end-to-end check that
    // stories group differently from articles.
    expect(accuracy.clusterCheck.article.clusters).toBeLessThan(accuracy.n);
    expect(accuracy.clusterCheck.story.clusters).toBeLessThan(accuracy.clusterCheck.article.clusters);

    for (const row of accuracy.thresholdSweep) {
      if (row.t === 0.1) expect(row.vsShipped).toBeNull();
      else expect(row.vsShipped?.adjusted?.alpha).toBe(0.01);
    }
    // Baselines are scored on the same items as the model.
    expect(accuracy.baselines.afinn.n).toBe(accuracy.n);
    expect(accuracy.baselines.majorityClass.balancedAccuracy).toBeCloseTo(1 / 3, 3);
    expect(accuracy.baselines.modelOverAfinn.adjusted).toBeNull();
    expect(accuracy.baselines.modelOverAfinn.accuracy).toBeCloseTo(
      accuracy.production.accuracy - accuracy.baselines.afinn.accuracy,
      3,
    );

    // The item file holds every sampled item and rebuilds the confusion matrix.
    const items = readJson<AccuracyItemRecord[]>(out, "accuracy-items.json");
    expect(items).toHaveLength(accuracy.n + accuracy.unscored);
    const pairs = items.flatMap((it) =>
      it.score === null ? [] : [{ actual: it.label, predicted: productionBucket(it.score) }],
    );
    expect(confusionMatrix(pairs)).toEqual(accuracy.production.confusion);

    const drift = readJson<DriftResult>(out, "drift.json");
    expect(drift.formatVersion).toBe(2);
    expect(drift.modelRevision).toBeNull();
    expect(drift.spend).toBeNull();
    expect(drift.sample.firstBatches).toBeNull();
    expect(Object.keys(drift.languages)).toEqual([...DRIFT_LANGUAGES]);
    expect(drift.pairwise).toHaveLength(10);
    expect(drift.bootstrap.pairwiseAdjustedAlpha).toBe(0.005);
    for (const stats of Object.values(drift.languages)) {
      expect(stats.n).toBe(drift.n);
      expect(stats.flipRateCI[0]).toBeLessThanOrEqual(stats.flipRate);
      expect(stats.flipRateCI[1]).toBeGreaterThanOrEqual(stats.flipRate);
      expect(Object.keys(stats.perClass)).toEqual(["negative", "neutral", "positive"]);
      expect(stats.poolWeightedFlipRate).toBeGreaterThanOrEqual(0);
      expect(stats.poolWeightedFlipRate).toBeLessThanOrEqual(1);
    }
    expect(readJson<DriftItemRecord[]>(out, "drift-items.json")).toHaveLength(drift.n);

    const accuracyMd = readFileSync(join(out, "accuracy-tables.md"), "utf8");
    for (const heading of ["## Confusion matrix", "## By split", "## Sensitivity to clustering", "## Baselines", "## Neutral-band sweep"]) {
      expect(accuracyMd).toContain(heading);
    }
    expect(accuracyMd).toContain("| AFINN-165 lexicon |");
    expect(accuracyMd).toContain("not recorded (dry run or --offline re-run)");
    const driftMd = readFileSync(join(out, "drift-tables.md"), "utf8");
    for (const heading of ["| Language | n |", "## By true class", "## Pairwise differences"]) {
      expect(driftMd).toContain(heading);
    }
    expect(driftMd).not.toContain("Smoke run");
  });

  it("restricts the drift study to the requested languages", async () => {
    // Run part of the study now, the rest later,
    // and let the disk cache join them up. Good rate limits workaround.
    await main(["--task", "drift", "--dry-run", "--languages", "fr", "--out", out]);
    const drift = readJson<DriftResult>(out, "drift.json");
    expect(Object.keys(drift.languages)).toEqual(["fr"]);
    expect(drift.pairwise).toEqual([]);
    expect(drift.bootstrap.pairwiseAdjustedAlpha).toBeNull();
  });

  it("runs a single task and honours --limit", async () => {
    await main(["--task", "accuracy", "--dry-run", "--limit", "6", "--out", out]);
    expect(readdirSync(out).sort()).toEqual(["accuracy-items.json", "accuracy-tables.md", "accuracy.json"]);
    const accuracy = readJson<AccuracyResult>(out, "accuracy.json");
    // 6 items requested, 2 per class, and the fixture has at least that many.
    expect(accuracy.n + accuracy.unscored).toBe(6);
    expect(accuracy.sample).toEqual({ kind: "limit", perClass: 2, seed: 20261027 });
  });

  it("draws the drift sample from inside the accuracy sample", async () => {
    await main(["--task", "all", "--dry-run", "--limit", "9", "--drift-items", "6", "--out", out]);
    const accuracyItems = readJson<AccuracyItemRecord[]>(out, "accuracy-items.json");
    const driftItems = readJson<DriftItemRecord[]>(out, "drift-items.json");
    for (const label of ["negative", "neutral", "positive"]) {
      expect(accuracyItems.filter((it) => it.label === label)).toHaveLength(3);
    }
    expect(driftItems).toHaveLength(6);
    const ids = new Set(accuracyItems.map((it) => it.id));
    expect(driftItems.every((it) => ids.has(it.id))).toBe(true);
  });

  it("marks a --drift-batches run as a smoke run", async () => {
    await main(["--task", "all", "--dry-run", "--drift-batches", "1", "--out", out]);
    const drift = readJson<DriftResult>(out, "drift.json");
    expect(drift.sample.firstBatches).toBe(1);
    // The fixture pool is smaller than one batch, so the slice holds all of it.
    expect(drift.n).toBe(24);
    expect(readFileSync(join(out, "drift-tables.md"), "utf8")).toContain("Smoke run (--drift-batches 1)");
  });

  it("never writes fixture numbers into the committed eval/out directory", async () => {
    // A dry run leaves the directory byte-for-byte untouched.
    const before = outSnapshot();
    await main(["--task", "all", "--dry-run", "--out", out]);
    expect(outSnapshot()).toEqual(before);
  });

  it("refuses to write a smoke run into eval/out", async () => {
    const before = outSnapshot();
    await expect(main(["--task", "all", "--dry-run", "--drift-batches", "1", "--out", OUT_DIR])).rejects.toThrow(
      /must not be written to eval\/out/,
    );
    expect(outSnapshot()).toEqual(before);
  });

  it("--offline re-runs from a warm cache without calling out", async () => {
    await main(["--task", "all", "--dry-run", "--out", out]); // warms the fixture cache
    const entries = (): string[] => readdirSync(DRY_RUN_CACHE_DIR).sort();
    const before = entries();
    rmSync(join(out, "accuracy.json"));
    await main(["--task", "all", "--dry-run", "--offline", "--out", out]);
    // The output was rebuilt and the cache is unchanged, so every request was a hit.
    expect(readdirSync(out)).toContain("accuracy.json");
    expect(entries()).toEqual(before);
  });

  it("--offline throws on a cold cache instead of spending", async () => {
    rmSync(DRY_RUN_CACHE_DIR, { recursive: true, force: true });
    await expect(main(["--task", "accuracy", "--dry-run", "--offline", "--out", out])).rejects.toThrow(
      /--offline: cache miss for dataset:newsmtsc-rw-test/,
    );
    expect(readdirSync(out)).toEqual([]);
  });

  it("fails a live run with no credentials instead of burning wall-clock", async () => {
    vi.stubEnv("HUGGINGFACE_API_KEY", "");
    vi.stubEnv("AZURE_TRANSLATOR_KEY", "");
    await expect(main(["--task", "accuracy", "--out", out])).rejects.toThrow(/Missing env var/);
    expect(readdirSync(out)).toEqual([]);
    vi.unstubAllEnvs();
  });
});

// A live run with the providers replaced by the fixture router. Each case gets a
// fresh temporary cache, so no fixture response can ever reach the real
// API cache in eval/data/cache/.
describe("live-mode safety", () => {
  let out: string;
  let cacheDir: string;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let logs: string[];

  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), "eval-live-out-"));
    cacheDir = mkdtempSync(join(tmpdir(), "eval-live-cache-"));
    vi.stubEnv("HUGGINGFACE_API_KEY", "test-hf");
    vi.stubEnv("AZURE_TRANSLATOR_KEY", "test-azure");
    // Far above the fixture's traffic, so pacing never adds a real wait.
    vi.stubEnv("AZURE_CHARS_PER_MINUTE", "100000000");
    fetchSpy = vi.fn(fixtureFetch);
    vi.stubGlobal("fetch", fetchSpy);
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      logs.push(parts.join(" "));
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(out, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const requestedHosts = (): string[] =>
    fetchSpy.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input));

  it("spends nothing when the prompt is answered no", async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    await expect(main(["--task", "all", "--out", out], { cacheDir, confirm })).rejects.toThrow(
      /Aborted: nothing was spent/,
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    // Only the free dataset downloads went out.
    const datasetUrls = new Set(Object.values(NEWSMTSC_URLS));
    expect(requestedHosts().every((url) => datasetUrls.has(url))).toBe(true);
    expect(readdirSync(out)).toEqual([]);
  });

  it("refuses to spend with no terminal to ask and no --yes", async () => {
    await expect(main(["--task", "all", "--out", out], { cacheDir, isTTY: false })).rejects.toThrow(/--yes/);
    expect(readdirSync(out)).toEqual([]);
  });

  it("stops at the projected cap before asking", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    await expect(
      main(["--task", "all", "--max-azure-chars", "10", "--out", out], { cacheDir, confirm }),
    ).rejects.toThrow(/--max-azure-chars/);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("records the spend with --yes, then skips the prompt once everything is cached", async () => {
    await main(["--task", "all", "--yes", "--out", out], { cacheDir });
    const accuracy = readJson<AccuracyResult>(out, "accuracy.json");
    const drift = readJson<DriftResult>(out, "drift.json");
    expect(accuracy.spend).not.toBeNull();
    expect(accuracy.spend?.hfRequests).toBeGreaterThan(0);
    expect(drift.spend?.azureChars).toBeGreaterThan(0);
    // The fixture router refuses huggingface.co; the lookup warns, never fails.
    expect(accuracy.modelRevision).toBeNull();
    expect(drift.modelRevision).toBeNull();
    expect(logs.some((line) => line.startsWith("[eval] spent: Azure"))).toBe(true);

    // No --yes and no terminal, but everything is cached, so there is nothing to
    // confirm. If the prompt ran anyway, this confirm's "no" would reject the run.
    const confirm = vi.fn().mockResolvedValue(false);
    logs = [];
    await main(["--task", "all", "--out", out], { cacheDir, confirm, isTTY: false });
    expect(confirm).not.toHaveBeenCalled();
    expect(logs.some((line) => line.includes("everything is cached"))).toBe(true);
    expect(readJson<AccuracyResult>(out, "accuracy.json").spend).toEqual({
      hfRequests: 0,
      hfRows: 0,
      azureRequests: 0,
      azureChars: 0,
    });
  });
});
