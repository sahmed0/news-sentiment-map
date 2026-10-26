import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVAL_SEED,
  MAX_TEXT_CHARS,
  articleKey,
  compareItems,
  dropOverlong,
  loadPool,
  mulberry32,
  parseRows,
  polarityToLabel,
  storyKey,
  stratifiedSample,
  summariseCrossSplit,
  toSentenceLabels,
  type LabelledItem,
  type NewsmtscRow,
  type NewsmtscSplit,
} from "../../eval/datasets.js";
import { installFixtureFetch } from "../../eval/fixtures/http.js";

const FIXTURE = readFileSync(
  fileURLToPath(new URL("../../eval/fixtures/newsmtsc-sample.jsonl", import.meta.url)),
  "utf8",
);

const row = (sentence: string, polarity: number, id: string, split: NewsmtscSplit): NewsmtscRow => ({
  mention: "",
  polarity,
  sentence,
  id,
  split,
});

describe("polarityToLabel", () => {
  it("maps the NewsMTSC -1/0/1 vocabulary", () => {
    expect(polarityToLabel(-1)).toBe("negative");
    expect(polarityToLabel(0)).toBe("neutral");
    expect(polarityToLabel(1)).toBe("positive");
  });

  it("rejects anything else so an unexpected encoding fails loudly", () => {
    // Some NewsMTSC releases use 2/4/6; silently mislabelling those would poison
    // the whole study, so they must not map at all.
    expect(polarityToLabel(2)).toBeNull();
    expect(polarityToLabel(6)).toBeNull();
  });
});

describe("parseRows", () => {
  it("reads every annotated row of the fixture", () => {
    const rows = parseRows(FIXTURE, "test");
    expect(rows).toHaveLength(17);
    expect(rows[0]).toMatchObject({ polarity: -1, mention: "Donald Trump" });
  });

  it("stamps the split on every row", () => {
    expect(parseRows(FIXTURE, "dev").every((r) => r.split === "dev")).toBe(true);
  });

  it("skips blank, malformed and wrongly-typed lines instead of throwing", () => {
    const rows = parseRows(
      [
        "",
        "not json",
        '{"sentence":"ok","polarity":0,"id":"a"}',
        '{"sentence":"no polarity","id":"b"}',
        '{"sentence":"bad polarity","polarity":4,"id":"c"}',
        '{"sentence":"   ","polarity":0,"id":"d"}',
        "[1,2,3]",
      ].join("\n"),
      "test",
    );
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("falls back to the sentence as id when the id is missing", () => {
    expect(parseRows('{"sentence":"x","polarity":1}', "train")[0].id).toBe("x");
  });
});

describe("toSentenceLabels (target-agreement filter)", () => {
  const items = toSentenceLabels(parseRows(FIXTURE, "test"));

  it("folds 17 target-level rows into 13 sentence-level items", () => {
    // 14 distinct sentences, one of which has disagreeing targets.
    expect(items).toHaveLength(13);
  });

  it("drops a sentence whose targets disagree", () => {
    // "Donald Trump attacks 'Alex' Baldwin on Twitter" is negative for two
    // targets and neutral for the platform - there is no sentence-level truth.
    expect(items.some((it) => it.text.includes("attacks 'Alex' Baldwin"))).toBe(false);
  });

  it("keeps a multi-target sentence whose targets agree, once", () => {
    const agreed = items.filter((it) => it.text.startsWith("Unlike Trump, Obama"));
    expect(agreed).toHaveLength(1);
    expect(agreed[0].label).toBe("negative");
  });

  it("labels single-target sentences from their polarity", () => {
    const byText = new Map(items.map((it) => [it.text, it.label]));
    expect(byText.get("Judge Kavanaugh has sterling academic credentials.")).toBe("positive");
    expect(byText.get("He raised the gun and started firing.")).toBe("negative");
    expect(byText.get("He has Bill Clinton.”")).toBe("neutral");
  });
});

describe("cross-split folding", () => {
  // Concatenated in the loader's order: test, then dev, then train.
  const rows = [
    row("Contradicts itself.", 1, "t1", "test"),
    row("Agrees with itself.", 0, "t2", "test"),
    row("Dev and train agree.", -1, "d1", "dev"),
    row("Only in train.", 1, "r0", "train"),
    row("Contradicts itself.", 0, "r1", "train"),
    row("Agrees with itself.", 0, "r2", "train"),
    row("Dev and train agree.", -1, "r3", "train"),
  ];
  const items = toSentenceLabels(rows);

  it("drops a sentence whose splits contradict each other", () => {
    expect(items.some((it) => it.text === "Contradicts itself.")).toBe(false);
  });

  it("keeps a consistent duplicate once, as its earliest split's row", () => {
    expect(items.filter((it) => it.text === "Agrees with itself.")).toEqual([
      { id: "t2", text: "Agrees with itself.", label: "neutral", split: "test" },
    ]);
    expect(items.filter((it) => it.text === "Dev and train agree.")).toEqual([
      { id: "d1", text: "Dev and train agree.", label: "negative", split: "dev" },
    ]);
  });

  it("summarises the duplicates", () => {
    expect(summariseCrossSplit(rows, items)).toEqual({ sentences: 3, kept: 2, dropped: 1 });
  });
});

describe("compareItems", () => {
  const item = (id: string, label: LabelledItem["label"] = "neutral"): LabelledItem => ({
    id,
    text: id,
    label,
    split: "test",
  });

  it("orders by plain code units, not the locale", () => {
    // localeCompare puts "a_a" first (case-insensitive at the first level); code
    // units put "B" (0x42) before "a" (0x61).
    expect(compareItems(item("a_B"), item("a_a"))).toBeLessThan(0);
    expect(compareItems(item("a_a"), item("a_B"))).toBeGreaterThan(0);
    expect(compareItems(item("x"), item("x"))).toBe(0);
  });

  it("sorts by label before id", () => {
    expect(compareItems(item("z", "negative"), item("a", "positive"))).toBeLessThan(0);
  });
});

describe("articleKey and storyKey", () => {
  it("groups POLUSA ids by article at both levels", () => {
    const id = "polusa_v1_59488606_-1_30_Dr. Sidney J. Blair_1_3";
    expect(articleKey(id)).toBe("polusa_v1_59488606");
    expect(storyKey(id)).toBe("polusa_v1_59488606");
  });

  it("groups AllSides ids by article, and articles by story", () => {
    expect(articleKey("allsides_1018_408_1_Hillary Clinton_2_17")).toBe("allsides_1018_408");
    expect(articleKey("allsides_1019_408_0_Hillary Clinton_8_15")).toBe("allsides_1019_408");
    expect(storyKey("allsides_1018_408_1_Hillary Clinton_2_17")).toBe("allsides_story_408");
    expect(storyKey("allsides_1019_408_0_Hillary Clinton_8_15")).toBe("allsides_story_408");
  });

  it("makes any other id its own cluster", () => {
    expect(articleKey("Some sentence used as its own id.")).toBe("Some sentence used as its own id.");
    expect(storyKey("polusa_v2_1_x")).toBe("polusa_v2_1_x");
  });
});

describe("mulberry32", () => {
  it("is deterministic for a seed and differs between seeds", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const draw = (rand: () => number): number[] => [rand(), rand(), rand()];
    const first = draw(a);
    expect(draw(b)).toEqual(first);
    expect(draw(c)).not.toEqual(first);
    expect(first.every((v) => v >= 0 && v < 1)).toBe(true);
  });
});

describe("stratifiedSample", () => {
  const pool: LabelledItem[] = [];
  for (let i = 0; i < 30; i++) pool.push({ id: `n${i}`, text: `neg ${i}`, label: "negative", split: "test" });
  for (let i = 0; i < 20; i++) pool.push({ id: `u${i}`, text: `neu ${i}`, label: "neutral", split: "dev" });
  for (let i = 0; i < 5; i++) pool.push({ id: `p${i}`, text: `pos ${i}`, label: "positive", split: "train" });

  it("takes the requested count per class", () => {
    const sample = stratifiedSample(pool, 10, EVAL_SEED);
    // 10 negative + 10 neutral + all 5 positive (the pool holds only 5).
    expect(sample).toHaveLength(25);
    expect(sample.filter((it) => it.label === "negative")).toHaveLength(10);
    expect(sample.filter((it) => it.label === "neutral")).toHaveLength(10);
    expect(sample.filter((it) => it.label === "positive")).toHaveLength(5);
  });

  it("degrades to everything available when a class is short", () => {
    // The dry-run fixture has ~4 items per class against a request of 100; the
    // harness must shrink rather than fail.
    const sample = stratifiedSample(pool, 100, EVAL_SEED);
    expect(sample).toHaveLength(pool.length);
  });

  it("is deterministic for a seed and changes with the seed", () => {
    const ids = (seed: number): string[] => stratifiedSample(pool, 3, seed).map((it) => it.id);
    expect(ids(EVAL_SEED)).toEqual(ids(EVAL_SEED));
    expect(ids(EVAL_SEED + 1)).not.toEqual(ids(EVAL_SEED));
  });

  it("returns a stable label-then-id order so outputs stay diffable", () => {
    const sample = stratifiedSample(pool, 2, EVAL_SEED);
    expect(sample).toEqual([...sample].sort(compareItems));
  });

  it("nests: a smaller draw is a subset of a larger one", () => {
    // What lets the drift sample reuse the accuracy study's scores, and a smoke
    // run's batches be the full run's.
    for (const k of [1, 2, 4, 7]) {
      const larger = new Set(stratifiedSample(pool, k + 3, EVAL_SEED).map((it) => it.id));
      expect(stratifiedSample(pool, k, EVAL_SEED).every((it) => larger.has(it.id))).toBe(true);
    }
  });
});

describe("dropOverlong", () => {
  it("drops only items over MAX_TEXT_CHARS, keeping the rest in order", () => {
    // HuggingFace rejects an input over the model's 512 tokens with a 400, which
    // would fail the whole batch on every retry.
    const item = (id: string, length: number): LabelledItem => ({
      id,
      text: "x".repeat(length),
      label: "neutral",
      split: "train",
    });
    const items = [item("a", 10), item("b", MAX_TEXT_CHARS + 1), item("c", MAX_TEXT_CHARS)];
    const { kept, dropped } = dropOverlong(items);
    expect(kept.map((it) => it.id)).toEqual(["a", "c"]);
    expect(dropped).toBe(1);
  });
});

describe("loadPool", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("folds the three fixture splits into one sorted pool", async () => {
    dir = mkdtempSync(join(tmpdir(), "eval-pool-"));
    const restore = installFixtureFetch();
    try {
      const pool = await loadPool(dir);
      expect(pool.items).toHaveLength(24);
      const count = (label: LabelledItem["label"]): number => pool.items.filter((it) => it.label === label).length;
      expect([count("negative"), count("neutral"), count("positive")]).toEqual([9, 10, 5]);
      expect(pool.rows).toEqual({ test: 17, dev: 8, train: 8 });
      expect(pool.crossSplit).toEqual({ sentences: 0, kept: 0, dropped: 0 });
      expect(pool.overlong).toBe(0);
      expect(pool.items).toEqual([...pool.items].sort(compareItems));
    } finally {
      restore();
    }
  });
});
