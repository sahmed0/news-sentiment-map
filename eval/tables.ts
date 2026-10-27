// Markdown rendering of the two result objects. Kept separate from metrics.ts so
// the numbers and their presentation can't drift: everything below reads fields
// off the JSON that is written next to it, and computes nothing beyond a display
// share (a count over a total).
import {
  BUCKETS,
  type AccuracyIntervals,
  type AccuracyResult,
  type ClassificationReport,
  type DriftResult,
  type Margin,
} from "./metrics.js";
import { NEWSMTSC_SPLITS } from "./datasets.js";

type Interval = [number, number];

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const num = (v: number, dp = 3): string => v.toFixed(dp);
// Signed margins use a real minus sign (U+2212) and "to" between bounds, so a
// negative bound isn't mistaken for a range dash.
const pctCI = ([lo, hi]: Interval): string => `${(lo * 100).toFixed(1)}–${(hi * 100).toFixed(1)}%`;
const numCI = ([lo, hi]: Interval, dp = 3): string => `${num(lo, dp)} – ${num(hi, dp)}`;
const signedPp = (v: number): string => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)} pp`;
const signedPpCI = ([lo, hi]: Interval): string => `${signedPp(lo)} to ${signedPp(hi)}`;
const signed = (v: number): string => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(3)}`;
const signedCI = ([lo, hi]: Interval): string => `${signed(lo)} to ${signed(hi)}`;

const revision = (r: string | null): string =>
  r === null ? "not recorded (dry run or --offline re-run)" : `\`${r}\` (Hub revision at run time)`;

// The three headline cells of one classifier: accuracy, balanced accuracy, macro-F1.
const headlineCells = (report: ClassificationReport, iv: AccuracyIntervals): string =>
  `${pct(report.accuracy)} (${pctCI(iv.accuracy)}) | ` +
  `${pct(report.balancedAccuracy)} (${pctCI(iv.balancedAccuracy)}) | ` +
  `${num(report.macroF1)} (${numCI(iv.macroF1)})`;

const establishedLabel = (m: Margin): string => {
  const e = m.adjusted?.established;
  if (!e) return "no";
  if (e.macroF1 && e.balancedAccuracy) return "both";
  if (e.macroF1) return "macro-F1";
  if (e.balancedAccuracy) return "balanced acc.";
  return "no";
};

export function renderAccuracyTables(r: AccuracyResult): string {
  const lines: string[] = [];
  const d = r.dataset;
  lines.push("# Accuracy - production scoring path on labelled news sentences", "");
  lines.push(`- Model: \`${r.model}\`, revision ${revision(r.modelRevision)}`);
  lines.push(
    `- Dataset: ${d.name} (${d.filter}): ${d.size} items from ` +
      `${NEWSMTSC_SPLITS.map((s) => `${d.splits[s].rows} ${s}`).join(" / ")} rows`,
  );
  lines.push(
    `- Cross-split duplicates: ${d.crossSplitDuplicates.sentences} sentences, ` +
      `${d.crossSplitDuplicates.kept} kept once, ${d.crossSplitDuplicates.dropped} dropped (contradicting labels)`,
  );
  lines.push(
    `- Too long for the model: ${d.overlong.dropped} item${d.overlong.dropped === 1 ? "" : "s"} over ` +
      `${d.overlong.maxChars} characters dropped`,
  );
  lines.push(
    `- Sample: ${r.sample.kind === "full" ? "full pool" : `--limit: ${r.sample.perClass} per class, seed ${r.sample.seed}`}`,
  );
  lines.push(`- Scored items: ${r.n}${r.unscored ? ` (+${r.unscored} unscored, excluded)` : ""}`);
  lines.push(`- Generated: ${r.generatedAt}`, "");

  const shares = BUCKETS.map((label) => `${label.slice(0, 3)} ${pct(d.size ? d.classCounts[label] / d.size : 0)}`);
  lines.push(
    `**Balanced accuracy ${pct(r.production.balancedAccuracy)} (95% CI ${pctCI(r.intervals.balancedAccuracy)}), ` +
      `macro-F1 ${num(r.production.macroF1)} (95% CI ${numCI(r.intervals.macroF1)}).**`,
    "",
    r.sample.kind === "full"
      ? `Raw accuracy ${pct(r.production.accuracy)} (95% CI ${pctCI(r.intervals.accuracy)}) reflects NewsMTSC's class mix (${shares.join(" / ")}).`
      : `Raw accuracy ${pct(r.production.accuracy)} (95% CI ${pctCI(r.intervals.accuracy)}) on a class-balanced --limit sample.`,
    "",
    `Accuracy and recall intervals are Wilson; the balanced-accuracy and macro-F1 intervals are a ` +
      `${r.bootstrap.method} bootstrap (b = ${r.bootstrap.b}, seed ${r.bootstrap.seed}).`,
    "",
  );

  lines.push("## Per class", "", "| Class | Precision | Recall (95% CI) | F1 | Support |", "|---|---|---|---|---|");
  for (const label of BUCKETS) {
    const c = r.production.perClass[label];
    lines.push(
      `| ${label} | ${num(c.precision)} | ${num(c.recall)} (${numCI(r.intervals.perClassRecall[label])}) | ${num(c.f1)} | ${c.support} |`,
    );
  }
  lines.push("");

  lines.push("## Confusion matrix", "", `| actual \\ predicted | ${BUCKETS.join(" | ")} |`, `|---|${BUCKETS.map(() => "---").join("|")}|`);
  for (const actual of BUCKETS) {
    const row = BUCKETS.map((p) => r.production.confusion[actual][p]);
    lines.push(`| **${actual}** | ${row.join(" | ")} |`);
  }
  lines.push("");

  lines.push(
    "## By split",
    "",
    "| Split | n | Accuracy (95% CI) | Balanced accuracy (95% CI) | Macro-F1 (95% CI) |",
    "|---|---|---|---|---|",
  );
  for (const split of NEWSMTSC_SPLITS) {
    const s = r.perSplit[split];
    lines.push(`| ${split} | ${s.report.n} | ${headlineCells(s.report, s.intervals)} |`);
  }
  lines.push("");

  const { article, story } = r.clusterCheck;
  lines.push(
    "## Sensitivity to clustering",
    "",
    "The same 95% intervals, resampling whole articles or stories instead of sentences.",
    "",
    "| Resampling unit | Units | Accuracy | Balanced accuracy | Macro-F1 |",
    "|---|---|---|---|---|",
    `| sentence (reported) | ${r.n} | ${pctCI(r.intervals.accuracy)} | ${pctCI(r.intervals.balancedAccuracy)} | ${numCI(r.intervals.macroF1)} |`,
    `| article | ${article.clusters} | ${pctCI(article.accuracy)} | ${pctCI(article.balancedAccuracy)} | ${numCI(article.macroF1)} |`,
    `| story | ${story.clusters} | ${pctCI(story.accuracy)} | ${pctCI(story.balancedAccuracy)} | ${numCI(story.macroF1)} |`,
    "",
    "Articles and stories are inferred from the structure of NewsMTSC ids, which the dataset does not document.",
    "",
  );

  const { majorityClass, afinn, afinnIntervals, modelOverAfinn } = r.baselines;
  lines.push(
    "## Baselines",
    "",
    "Scored on the same items as the model, bucketed at the same ±0.10 band.",
    "",
    "| Classifier | Accuracy (95% CI) | Balanced accuracy (95% CI) | Macro-F1 (95% CI) |",
    "|---|---|---|---|",
    `| Majority class (always ${majorityClass.label}) | ${pct(majorityClass.accuracy)} | ${pct(majorityClass.balancedAccuracy)} | ${num(majorityClass.macroF1)} |`,
    `| AFINN-165 lexicon | ${headlineCells(afinn, afinnIntervals)} |`,
    `| **Model** | ${headlineCells(r.production, r.intervals)} |`,
    "",
    `Model over AFINN, paired bootstrap on the same items: accuracy ${signedPp(modelOverAfinn.accuracy)} ` +
      `(95% CI ${signedPpCI(modelOverAfinn.accuracyCI)}), balanced accuracy ${signedPp(modelOverAfinn.balancedAccuracy)} ` +
      `(95% CI ${signedPpCI(modelOverAfinn.balancedAccuracyCI)}), macro-F1 ${signed(modelOverAfinn.macroF1)} ` +
      `(95% CI ${signedCI(modelOverAfinn.macroF1CI)}).`,
    "",
  );

  const adjLevel = `${num((1 - r.bootstrap.sweepAdjustedAlpha) * 100, 1).replace(/\.0$/, "")}% adj. CI`;
  lines.push(
    "## Neutral-band sweep",
    "",
    "The shipped map uses ±0.10. Every other row is the same scores mapped with a different band, " +
      "compared with ±0.10 by a paired bootstrap. A band is established as different only when its " +
      `Bonferroni-adjusted interval (α = ${r.bootstrap.sweepAdjustedAlpha}) excludes zero.`,
    "",
    `| Band ±t | Accuracy | Balanced acc. | Macro-F1 | Δ macro-F1 vs ±0.10 (95% CI) | ${adjLevel} | Δ balanced acc. vs ±0.10 (95% CI) | ${adjLevel} | Established? |`,
    "|---|---|---|---|---|---|---|---|---|",
  );
  for (const row of r.thresholdSweep) {
    const m = row.vsShipped;
    const head = `| ${row.t.toFixed(2)}${m ? "" : " *(shipped)*"} | ${pct(row.accuracy)} | ${pct(row.balancedAccuracy)} | ${num(row.macroF1)}`;
    if (!m || !m.adjusted) {
      lines.push(`${head} | - | - | - | - | - |`);
      continue;
    }
    lines.push(
      `${head} | ${signed(m.macroF1)} (${signedCI(m.macroF1CI)}) | ${signedCI(m.adjusted.macroF1CI)} | ` +
        `${signedPp(m.balancedAccuracy)} (${signedPpCI(m.balancedAccuracyCI)}) | ${signedPpCI(m.adjusted.balancedAccuracyCI)} | ` +
        `${establishedLabel(m)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function renderDriftTables(r: DriftResult): string {
  const lines: string[] = [];
  lines.push("# Translation round-trip drift", "");
  if (r.sample.firstBatches !== null) {
    lines.push(
      `**Smoke run (--drift-batches ${r.sample.firstBatches}): the first ${r.sample.n} items of the drift sample only. These are not results.**`,
      "",
    );
  }
  const batches = r.sample.firstBatches;
  lines.push(`- Model: \`${r.model}\`, revision ${revision(r.modelRevision)}`);
  lines.push(
    `- Sample: ${r.sample.n} items, ${r.sample.perClass} per class, seed ${r.sample.seed}` +
      `${batches !== null ? `, first ${batches} batch${batches === 1 ? "" : "es"} only` : ""}`,
  );
  lines.push(`- Generated: ${r.generatedAt}`, "");
  lines.push(
    "Each item is translated English → language → English through the production",
    "Azure + HuggingFace path, then compared with its direct English score.",
    "",
    "| Language | n | Mean \\|Δ\\| (95% CI) | Median Δ | Max \\|Δ\\| | Label-flip rate (95% CI) | Pearson r |",
    "|---|---|---|---|---|---|---|",
  );
  for (const [lang, s] of Object.entries(r.languages)) {
    lines.push(
      `| ${lang} | ${s.n} | ${num(s.meanAbsDelta)} (${numCI(s.meanAbsDeltaCI)}) | ${num(s.medianDelta)} | ${num(s.maxAbsDelta)} | ` +
        `${pct(s.flipRate)} (${pctCI(s.flipRateCI)}), ${s.flips} flips | ${s.pearson === null ? "n/a" : num(s.pearson)} |`,
    );
  }
  lines.push("");

  lines.push(
    "## By true class",
    "",
    "The pool-weighted rate re-weights the per-class rates to the dataset's class mix.",
    "",
    `| Language | ${BUCKETS.join(" | ")} | Pool-weighted (95% CI) |`,
    "|---|---|---|---|---|",
  );
  for (const [lang, s] of Object.entries(r.languages)) {
    const cells = BUCKETS.map((label) => {
      const c = s.perClass[label];
      return `${pct(c.flipRate)} (${pctCI(c.flipRateCI)}), ${c.flips}/${c.n}`;
    });
    lines.push(`| ${lang} | ${cells.join(" | ")} | ${pct(s.poolWeightedFlipRate)} (${pctCI(s.poolWeightedFlipRateCI)}) |`);
  }
  lines.push("");

  const alpha = r.bootstrap.pairwiseAdjustedAlpha;
  if (alpha !== null) {
    const level = `${num((1 - alpha) * 100, 1).replace(/\.0$/, "")}% adj. CI`;
    lines.push(
      "## Pairwise differences",
      "",
      "Flip rate of A minus flip rate of B, on the same sentences.",
      "",
      `| A − B | n | Δ flip rate (95% CI) | ${level} | Established? |`,
      "|---|---|---|---|---|",
    );
    for (const p of r.pairwise) {
      lines.push(
        `| ${p.a} − ${p.b} | ${p.n} | ${signedPp(p.diff)} (${signedPpCI(p.ci)}) | ${signedPpCI(p.adjustedCI)} | ${p.established ? "yes" : "no"} |`,
      );
    }
    lines.push("");
  }

  lines.push(
    "Per-language flip-rate intervals are Wilson; the pairwise intervals are a paired bootstrap on the same items",
    `(b = ${r.bootstrap.b}, seed ${r.bootstrap.seed}). A difference between two languages counts as established only`,
    "when its Bonferroni-adjusted interval excludes zero.",
    "",
  );
  return lines.join("\n");
}
