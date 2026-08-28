import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DRY_RUN_CACHE_DIR } from "../../eval/cache.js";
import { DRIFT_LANGUAGES, OUT_DIR, main, parseArgs } from "../../eval/run.js";
import { fixtureFetch } from "../../eval/fixtures/http.js";
import type { AccuracyResult, DriftResult } from "../../eval/metrics.js";

describe("parseArgs", () => {
  it("defaults to a full live run over every drift language", () => {
    expect(parseArgs([])).toEqual({
      task: "all",
      dryRun: false,
      limit: null,
      out: null,
      languages: [...DRIFT_LANGUAGES],
      driftItems: null,
    });
  });

  it("reads every flag", () => {
    expect(
      parseArgs([
        "--task", "drift",
        "--dry-run",
        "--limit", "30",
        "--out", "tmp",
        "--languages", "fr,ja",
        "--drift-items", "40",
      ]),
    ).toEqual({
      task: "drift",
      dryRun: true,
      limit: 30,
      out: "tmp",
      languages: ["fr", "ja"],
      driftItems: 40,
    });
  });

  it("rejects an unknown task, a bad limit and stray arguments", () => {
    expect(() => parseArgs(["--task", "everything"])).toThrow(/--task must be/);
    expect(() => parseArgs(["--limit", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--limit", "2.5"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--wat"])).toThrow(/Unknown argument/);
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

describe("fixture fetch guard", () => {
  it("refuses any host that is not the dataset, Azure or HuggingFace", () => {
    // This throw is what makes --dry-run provably offline.
    expect(() => fixtureFetch("https://gnews.io/api/v4/top-headlines")).toThrow(/refusing to reach gnews.io/);
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
      "accuracy-tables.md",
      "accuracy.json",
      "drift-tables.md",
      "drift.json",
    ]);

    const accuracy = JSON.parse(readFileSync(join(out, "accuracy.json"), "utf8")) as AccuracyResult;
    expect(accuracy.model).toContain("twitter-roberta-base-sentiment-latest");
    expect(accuracy.dataset.seed).toBeTypeOf("number");
    expect(accuracy.n).toBeGreaterThan(0);
    expect(accuracy.production.accuracy).toBeGreaterThanOrEqual(0);
    expect(accuracy.production.accuracy).toBeLessThanOrEqual(1);
    expect(Object.keys(accuracy.production.perClass).sort()).toEqual(["negative", "neutral", "positive"]);
    expect(accuracy.production.confusion.negative.negative).toBeTypeOf("number");
    expect(accuracy.thresholdSweep.map((r) => r.t)).toEqual([0.05, 0.1, 0.15, 0.2, 0.25, 0.3]);

    const drift = JSON.parse(readFileSync(join(out, "drift.json"), "utf8")) as DriftResult;
    expect(Object.keys(drift.languages)).toEqual([...DRIFT_LANGUAGES]);
    for (const stats of Object.values(drift.languages)) {
      expect(stats.n).toBe(drift.n);
      expect(stats.flipRate).toBeGreaterThanOrEqual(0);
      expect(stats.flipRate).toBeLessThanOrEqual(1);
    }

    expect(readFileSync(join(out, "accuracy-tables.md"), "utf8")).toContain("## Confusion matrix");
    expect(readFileSync(join(out, "drift-tables.md"), "utf8")).toContain("| Language | n |");
  });

  it("restricts the drift study to the requested languages", async () => {
    // Run part of the study now, the rest later,
    // and let the disk cache join them up. Good rate limits workaround.
    await main(["--task", "drift", "--dry-run", "--languages", "fr", "--out", out]);
    const drift = JSON.parse(readFileSync(join(out, "drift.json"), "utf8")) as DriftResult;
    expect(Object.keys(drift.languages)).toEqual(["fr"]);
  });

  it("runs a single task and honours --limit", async () => {
    await main(["--task", "accuracy", "--dry-run", "--limit", "6", "--out", out]);
    expect(readdirSync(out).sort()).toEqual(["accuracy-tables.md", "accuracy.json"]);
    const accuracy = JSON.parse(readFileSync(join(out, "accuracy.json"), "utf8")) as AccuracyResult;
    // 6 items requested, 2 per class, and the fixture has at least that many.
    expect(accuracy.n + accuracy.unscored).toBe(6);
  });

  it("never writes fixture numbers into the committed eval/out directory", async () => {
    // A dry run leaves the directory byte-for-byte untouched.
    const snapshot = (): Record<string, number> =>
      Object.fromEntries(
        readdirSync(OUT_DIR).map((name) => [name, statSync(join(OUT_DIR, name)).mtimeMs]),
      );

    const before = snapshot();
    await main(["--task", "all", "--dry-run", "--out", out]);
    expect(snapshot()).toEqual(before);
  });

  it("fails a live run with no credentials instead of burning wall-clock", async () => {
    vi.stubEnv("HUGGINGFACE_API_KEY", "");
    vi.stubEnv("AZURE_TRANSLATOR_KEY", "");
    await expect(main(["--task", "accuracy", "--out", out])).rejects.toThrow(/Missing env var/);
    expect(readdirSync(out)).toEqual([]);
    vi.unstubAllEnvs();
  });
});
