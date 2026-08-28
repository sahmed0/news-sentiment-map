// Markdown rendering of the two result objects. Kept separate from metrics.ts so
// the numbers and their presentation can't drift: everything below reads fields
// off the JSON that is written next to it, and computes nothing.
import { BUCKETS, type AccuracyResult, type DriftResult } from "./metrics.js";

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const num = (v: number, dp = 3): string => v.toFixed(dp);

export function renderAccuracyTables(r: AccuracyResult): string {
  const lines: string[] = [];
  lines.push("# Accuracy - production scoring path on labelled news sentences", "");
  lines.push(`- Model: \`${r.model}\``);
  lines.push(`- Dataset: ${r.dataset.name} (${r.dataset.filter}), seed ${r.dataset.seed}`);
  lines.push(`- Scored items: ${r.n}${r.unscored ? ` (+${r.unscored} unscored, excluded)` : ""}`);
  lines.push(`- Generated: ${r.generatedAt}`, "");
  lines.push(
    `**${pct(r.production.accuracy)} 3-class accuracy, macro-F1 ${num(r.production.macroF1)}.**`,
    "",
  );

  lines.push("## Per class", "", "| Class | Precision | Recall | F1 | Support |", "|---|---|---|---|---|");
  for (const label of BUCKETS) {
    const c = r.production.perClass[label];
    lines.push(`| ${label} | ${num(c.precision)} | ${num(c.recall)} | ${num(c.f1)} | ${c.support} |`);
  }
  lines.push("");

  lines.push("## Confusion matrix", "", `| actual \\ predicted | ${BUCKETS.join(" | ")} |`, `|---|${BUCKETS.map(() => "---").join("|")}|`);
  for (const actual of BUCKETS) {
    const row = BUCKETS.map((p) => r.production.confusion[actual][p]);
    lines.push(`| **${actual}** | ${row.join(" | ")} |`);
  }
  lines.push("");

  lines.push(
    "## Neutral-band sweep",
    "",
    "The shipped map uses ±0.10. Every other row is the same scores mapped with a different band.",
    "",
    "| Band ±t | Accuracy | Macro-F1 |",
    "|---|---|---|",
  );
  for (const row of r.thresholdSweep) {
    const mark = row.t === 0.1 ? " *(shipped)*" : "";
    lines.push(`| ${row.t.toFixed(2)}${mark} | ${pct(row.accuracy)} | ${num(row.macroF1)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderDriftTables(r: DriftResult): string {
  const lines: string[] = [];
  lines.push("# Translation round-trip drift", "");
  lines.push(`- Model: \`${r.model}\``);
  lines.push(`- Items per language: ${r.n}`);
  lines.push(`- Generated: ${r.generatedAt}`, "");
  lines.push(
    "Each item is translated English → language → English through the production",
    "Azure + HuggingFace path, then compared with its direct English score.",
    "",
    "| Language | n | Mean \\|Δ\\| | Median Δ | Max \\|Δ\\| | Label-flip rate | Pearson r |",
    "|---|---|---|---|---|---|---|",
  );
  for (const [lang, s] of Object.entries(r.languages)) {
    lines.push(
      `| ${lang} | ${s.n} | ${num(s.meanAbsDelta)} | ${num(s.medianDelta)} | ${num(s.maxAbsDelta)} | ${pct(s.flipRate)} | ${s.pearson === null ? "n/a" : num(s.pearson)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
