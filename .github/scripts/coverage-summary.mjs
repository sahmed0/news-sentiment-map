// Renders coverage/coverage-summary.json as a GitHub-flavored markdown table.
// CI pipes stdout into $GITHUB_STEP_SUMMARY so the numbers show on the run page.
// Fail-soft: a missing summary (e.g. tests skipped) must not fail the job, so we
// print a note and exit 0 rather than throwing.
import { readFileSync } from "node:fs";

const SUMMARY_PATH = "coverage/coverage-summary.json";

let total;
try {
  total = JSON.parse(readFileSync(SUMMARY_PATH, "utf8")).total;
} catch {
  console.log("coverage summary not found");
  process.exit(0);
}

const rows = ["lines", "statements", "functions", "branches"].map((metric) => {
  const m = total[metric];
  return `| ${metric} | ${m.pct}% | ${m.covered}/${m.total} |`;
});

console.log("### Coverage");
console.log("");
console.log("| Metric | % | Covered/Total |");
console.log("| --- | --- | --- |");
console.log(rows.join("\n"));
