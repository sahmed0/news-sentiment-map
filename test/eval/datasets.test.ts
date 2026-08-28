import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PER_CLASS,
  SAMPLE_SEED,
  mulberry32,
  parseRows,
  polarityToLabel,
  stratifiedSample,
  toSentenceLabels,
  type LabelledItem,
} from "../../eval/datasets.js";

const FIXTURE = readFileSync(
  fileURLToPath(new URL("../../eval/fixtures/newsmtsc-sample.jsonl", import.meta.url)),
  "utf8",
);

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
    const rows = parseRows(FIXTURE);
    expect(rows).toHaveLength(17);
    expect(rows[0]).toMatchObject({ polarity: -1, mention: "Donald Trump" });
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
    );
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("falls back to the sentence as id when the id is missing", () => {
    expect(parseRows('{"sentence":"x","polarity":1}')[0].id).toBe("x");
  });
});

describe("toSentenceLabels (target-agreement filter)", () => {
  const items = toSentenceLabels(parseRows(FIXTURE));

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
  for (let i = 0; i < 30; i++) pool.push({ id: `n${i}`, text: `neg ${i}`, label: "negative" });
  for (let i = 0; i < 20; i++) pool.push({ id: `u${i}`, text: `neu ${i}`, label: "neutral" });
  for (let i = 0; i < 5; i++) pool.push({ id: `p${i}`, text: `pos ${i}`, label: "positive" });

  it("takes the requested count per class", () => {
    const sample = stratifiedSample(pool, 10, SAMPLE_SEED);
    // 10 negative + 10 neutral + all 5 positive (the pool holds only 5).
    expect(sample).toHaveLength(25);
    expect(sample.filter((it) => it.label === "negative")).toHaveLength(10);
    expect(sample.filter((it) => it.label === "neutral")).toHaveLength(10);
    expect(sample.filter((it) => it.label === "positive")).toHaveLength(5);
  });

  it("degrades to everything available when a class is short", () => {
    // The dry-run fixture has ~4 items per class against a request of 100; the
    // harness must shrink rather than fail.
    const sample = stratifiedSample(pool, DEFAULT_PER_CLASS, SAMPLE_SEED);
    expect(sample).toHaveLength(pool.length);
  });

  it("is deterministic for a seed and changes with the seed", () => {
    const ids = (seed: number): string[] => stratifiedSample(pool, 3, seed).map((it) => it.id);
    expect(ids(SAMPLE_SEED)).toEqual(ids(SAMPLE_SEED));
    expect(ids(SAMPLE_SEED + 1)).not.toEqual(ids(SAMPLE_SEED));
  });

  it("returns a stable label-then-id order so outputs stay diffable", () => {
    const sample = stratifiedSample(pool, 2, SAMPLE_SEED);
    const labels = sample.map((it) => it.label);
    expect(labels).toEqual([...labels].sort());
    const negIds = sample.filter((it) => it.label === "negative").map((it) => it.id);
    expect(negIds).toEqual([...negIds].sort());
  });
});
