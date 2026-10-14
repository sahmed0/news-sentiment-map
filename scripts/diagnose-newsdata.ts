// NewsData diagnostic for countries that share articles.
//
//   pnpm exec tsx scripts/diagnose-newsdata.ts                 Step 0 + all variants
//   pnpm exec tsx scripts/diagnose-newsdata.ts --step0-only    validate language codes only
//   pnpm exec tsx scripts/diagnose-newsdata.ts --out raw.json  also dump every raw response
//   ... --skip-step0 --already-spent N   skip Step 0; N calls already spent count against MAX_CALLS
//   ... --en-drop                        compare EN_DROP_GROUP with and without `en`
//
// Compares NewsData query variants for pairs of countries that share articles:
//   Step 0  check every language code production sends is accepted
//   Step 1  print the publisher `country` tags on the variant A results
//   Step 2  run variants A-E, reporting per-pair Jaccard overlap and hostnames
//
// Needs NEWSDATA_API_KEY and HEALTH_URL (the deployed /api/health endpoint),
// from the environment or .env.local. Calls spend real NewsData credits outside
// the cron's ledger, so it checks /api/health for headroom and caps at MAX_CALLS.

import { writeFileSync } from "node:fs";
import { LOW_PRIORITY_COUNTRIES, newsDataLanguages, newsDataQuery } from "../api/_lib/sentiment-fetch.js";

const MAX_CALLS = 50;
const GAP_MS = 2000; // NewsData's free tier allows ~1 request per second
const NEWSDATA_REAL_DAILY_LIMIT = 200; // the provider's limit, not the ledger's NEWSDATA_MAX_PER_DAY
const MIN_HEADROOM = 60;

// Country pairs that shared articles. gm ("en") always had its language filter
// sent, so it's the control: if its overlap never moves, the country filter is
// the problem rather than the language filter.
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["gm", "lr"],
  ["dz", "sd"],
  ["by", "al"],
  ["ao", "ci"],
];

// Crude "is this article about the country?" check over title + description.
const MENTIONS: Record<string, string[]> = {
  gm: ["gambia"],
  lr: ["liberia"],
  dz: ["algeria", "algérie", "algerie", "الجزائر"],
  sd: ["sudan", "السودان"],
  by: ["belarus", "беларус", "белорус", "lukashenk"],
  al: ["albania", "shqipëri", "shqiperi", "tirana"],
  ao: ["angola", "luanda"],
  ci: ["ivory coast", "côte d'ivoire", "cote d'ivoire", "ivoir", "abidjan"],
  kp: ["north korea", "dprk", "pyongyang", "kim jong", "북한", "조선", "평양"],
  bt: ["bhutan", "thimphu"],
  af: ["afghan", "kabul", "taliban", "افغانستان", "کابل"],
  sl: ["sierra leone", "freetown"],
  ls: ["lesotho", "maseru"],
  cf: ["central african", "centrafrique", "centrafricain", "bangui"],
  ml: ["mali", "bamako"],
  mg: ["madagascar", "malgache", "antananarivo"],
  er: ["eritrea", "érythrée", "erythree", "asmara", "إريتريا"],
  gq: ["equatorial guinea", "guinea ecuatorial", "guinée équatoriale", "malabo"],
};

const args = process.argv.slice(2);
const step0Only = args.includes("--step0-only");
const outIdx = args.indexOf("--out");
const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
const skipStep0 = args.includes("--skip-step0");
const enDrop = args.includes("--en-drop");
const spentIdx = args.indexOf("--already-spent");
const alreadySpent = spentIdx >= 0 ? Number(args[spentIdx + 1]) : 0;
if (!Number.isInteger(alreadySpent) || alreadySpent < 0) {
  console.error("--already-spent needs a non-negative integer");
  process.exit(1);
}

if (!process.env.NEWSDATA_API_KEY || !process.env.HEALTH_URL) {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // Fall through to the checks below.
  }
}
const apiKey = process.env.NEWSDATA_API_KEY;
if (!apiKey) {
  console.error("NEWSDATA_API_KEY is not set (and .env.local did not provide it). Nothing was called.");
  process.exit(1);
}

const HEALTH_URL = process.env.HEALTH_URL ?? "";
if (!HEALTH_URL) {
  console.error("HEALTH_URL is not set (and .env.local did not provide it). Nothing was called.");
  process.exit(1);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const asStr = (v: unknown): string | null => (typeof v === "string" ? v : null);
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface NdArticle {
  link: string | null;
  title: string | null;
  description: string | null;
  sourceId: string | null;
  language: string | null;
  country: unknown; // printed raw: its format is not documented reliably
}

interface NdResponse {
  query: string;
  status: number;
  body: string;
  articles: NdArticle[];
}

let calls = alreadySpent;
const raw: NdResponse[] = [];

async function nd(query: string): Promise<NdResponse> {
  if (calls >= MAX_CALLS) throw new Error(`refusing call ${calls + 1}: MAX_CALLS (${MAX_CALLS}) reached`);
  if (calls > alreadySpent) await delay(GAP_MS);
  calls++;
  const res = await fetch(`https://newsdata.io/api/1/latest?${query}&apikey=${apiKey}`, {
    signal: AbortSignal.timeout(60000),
  });
  const body = await res.text();
  const articles: NdArticle[] = [];
  if (res.ok) {
    try {
      const data: unknown = JSON.parse(body);
      const results = isRecord(data) && Array.isArray(data.results) ? data.results : [];
      for (const a of results) {
        if (!isRecord(a)) continue;
        articles.push({
          link: asStr(a.link),
          title: asStr(a.title),
          description: asStr(a.description),
          sourceId: asStr(a.source_id),
          language: asStr(a.language),
          country: a.country,
        });
      }
    } catch {
      // Left empty; the status line below still shows what came back.
    }
  }
  const out = { query, status: res.status, body: res.ok ? "" : body, articles };
  raw.push(out);
  return out;
}

const host = (url: string | null): string => {
  if (!url) return "(no link)";
  try {
    return new URL(url).hostname;
  } catch {
    return "(bad link)";
  }
};

const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
};

async function checkHeadroom(): Promise<void> {
  const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(30000) });
  const data: unknown = await res.json();
  const nd = isRecord(data) && isRecord(data.budgets) && isRecord(data.budgets.newsdata) ? data.budgets.newsdata.used : null;
  if (typeof nd !== "number") throw new Error(`could not read budgets.newsdata.used from ${HEALTH_URL}`);
  const headroom = NEWSDATA_REAL_DAILY_LIMIT - nd;
  console.log(`health: ndUsedDay=${nd}, headroom against the real ${NEWSDATA_REAL_DAILY_LIMIT}/day limit = ${headroom}`);
  if (headroom < MIN_HEADROOM) throw new Error(`headroom ${headroom} < ${MIN_HEADROOM}; not spending diagnostic credits today`);
}

// Step 0
// Validate a group of codes; on a 422, split and retry until the rejected code
// is isolated. Returns the rejected codes.
async function validate(codes: string[]): Promise<string[]> {
  const r = await nd(`language=${codes.join(",")}&size=1`);
  if (r.status === 200) {
    console.log(`  ok    ${codes.join(",")}`);
    return [];
  }
  console.log(`  ${r.status}   ${codes.join(",")}  body: ${r.body.slice(0, 400)}`);
  if (r.status !== 422) throw new Error(`HTTP ${r.status} is not a language verdict; cannot validate`);
  if (codes.length === 1) return codes;
  const mid = Math.ceil(codes.length / 2);
  return [...(await validate(codes.slice(0, mid))), ...(await validate(codes.slice(mid)))];
}

async function step0(): Promise<string[]> {
  const codes = [...new Set(LOW_PRIORITY_COUNTRIES.flatMap((c) => newsDataLanguages(c.lang)))];
  console.log(`\n== Step 0: validate ${codes.length} language codes, five per call ==`);
  const rejected: string[] = [];
  for (let i = 0; i < codes.length; i += 5) rejected.push(...(await validate(codes.slice(i, i + 5))));
  console.log(rejected.length ? `REJECTED: ${rejected.join(",")}` : "all codes accepted");
  return rejected;
}

// Step 2 variants

type Variant = "A" | "B" | "C" | "D" | "E";

// A reproduces the query before the newsDataLanguages fix: `language=` was sent
// only when the whole lang string was one code from the old allowlist.
const ADDED_BY_FIX = new Set(["be", "ku", "ps", "sw", "ha", "tk", "is", "kk"]);
const oldGuardSent = (lang: string | undefined): lang is string =>
  !!lang && !lang.includes(",") && !ADDED_BY_FIX.has(lang) && newsDataLanguages(lang).length === 1;

function variantQuery(v: Variant, code: string, name: string, lang: string | undefined): string {
  const langs = newsDataLanguages(lang);
  const langParam = (list: string[]): string => (list.length ? `&language=${list.join(",")}` : "");
  switch (v) {
    case "A": {
      const old = oldGuardSent(lang) ? `&language=${lang}` : "";
      return `country=${code}${old}&sort=source&removeduplicate=1&size=5`;
    }
    case "B":
      return `country=${code}${langParam(langs)}&sort=source&removeduplicate=1&size=5`;
    case "C":
      return `country=${code}&removeduplicate=1&size=5${langParam(langs)}`;
    case "D":
      return `country=${code}&removeduplicate=1&size=5${langParam(langs.filter((l) => l !== "en"))}`;
    case "E":
      return `q=${encodeURIComponent(name)}&removeduplicate=1&size=5${langParam(langs)}`;
  }
}

function mentions(code: string, a: NdArticle): boolean {
  const text = `${a.title ?? ""} ${a.description ?? ""}`.toLowerCase();
  return (MENTIONS[code] ?? []).some((k) => text.includes(k));
}

async function step2(): Promise<void> {
  const byCode = new Map(LOW_PRIORITY_COUNTRIES.map((c) => [c.code, c]));
  const variants: Variant[] = ["A", "B", "C", "D", "E"];
  const summary: string[] = [];

  for (const v of variants) {
    console.log(`\n== Variant ${v} ==`);
    const urls = new Map<string, Set<string>>();
    const pairCells: string[] = [];
    for (const pair of PAIRS) {
      for (const code of pair) {
        const def = byCode.get(code);
        if (!def) throw new Error(`${code} is not a low-priority country`);
        const r = await nd(variantQuery(v, code, def.name, def.lang));
        const set = new Set(r.articles.map((a) => a.link).filter((u): u is string => !!u));
        urls.set(code, set);
        const about = r.articles.filter((a) => mentions(code, a)).length;
        console.log(`  ${code} {${def.lang}}  ${r.query}`);
        console.log(`     HTTP ${r.status}, ${r.articles.length} articles, ${about} mention ${def.name}${r.body ? `  body: ${r.body.slice(0, 300)}` : ""}`);
        for (const a of r.articles) {
          console.log(`     ${mentions(code, a) ? "*" : " "} [${a.language}] ${host(a.link)}  ${(a.title ?? "").slice(0, 90)}`);
          if (v === "A") console.log(`         publisher country (raw): ${JSON.stringify(a.country)}`);
        }
      }
      const [x, y] = pair;
      const j = jaccard(urls.get(x) ?? new Set(), urls.get(y) ?? new Set());
      pairCells.push(`${x}-${y} ${j.toFixed(2)}`);
    }
    const hosts = new Map<string, number>();
    for (const r of raw.slice(-8)) for (const a of r.articles) hosts.set(host(a.link), (hosts.get(host(a.link)) ?? 0) + 1);
    const hostList = [...hosts.entries()].sort((a, b) => b[1] - a[1]).map(([h, n]) => `${h}(${n})`).join(" ");
    console.log(`  Jaccard: ${pairCells.join("  ")}`);
    console.log(`  hosts: ${hostList}`);
    summary.push(`  ${v}  ${pairCells.join("  ")}`);

    if (v === "A") step1(raw.slice(-8));
  }

  console.log("\n== Summary: Jaccard overlap of returned URL sets per pair ==");
  for (const line of summary) console.log(line);
}

// Step 1

// NewsData's `country` is the publisher's registered country, not the story's.
// Counts publishers tagged for 5+ countries, i.e. region-wide outlets.
function step1(responses: NdResponse[]): void {
  console.log("\n== Step 1: publisher country tags on variant A ==");
  for (const r of responses) {
    const code = /country=([a-z]{2})/.exec(r.query)?.[1] ?? "?";
    const wide = new Set<string>();
    for (const a of r.articles) {
      if (Array.isArray(a.country) && a.country.length >= 5) wide.add(a.sourceId ?? host(a.link));
    }
    const sizes = r.articles.map((a) => (Array.isArray(a.country) ? a.country.length : "?")).join(",");
    console.log(`  ${code}: tag-list sizes [${sizes}]; publishers tagged for 5+ countries: ${wide.size} ${[...wide].join(" ")}`);
  }
}

// --en-drop

// Countries that still shared articles after the query fix. Each is queried as
// production queries it, then again with `en` removed. English-only countries
// (sl, ls, bt) are measured but have no en-dropped variant.
const EN_DROP_GROUP = ["kp", "bt", "af", "sl", "ls", "cf", "ml", "mg", "er", "gq"];

async function enDropStep(): Promise<void> {
  const byCode = new Map(LOW_PRIORITY_COUNTRIES.map((c) => [c.code, c]));
  const current = new Map<string, Set<string>>();
  const dropped = new Map<string, Set<string>>();

  const run = async (label: string, code: string, query: string): Promise<Set<string>> => {
    const r = await nd(query);
    const about = r.articles.filter((a) => mentions(code, a)).length;
    const langs = [...new Set(r.articles.map((a) => a.language))].join(",");
    console.log(`  ${label} ${code}  ${r.query}`);
    console.log(`     HTTP ${r.status}, ${r.articles.length} articles, ${about} mention the country, languages: ${langs}${r.body ? `  body: ${r.body.slice(0, 300)}` : ""}`);
    for (const a of r.articles) console.log(`     ${mentions(code, a) ? "*" : " "} [${a.language}] ${host(a.link)}  ${(a.title ?? "").slice(0, 90)}`);
    return new Set(r.articles.map((a) => a.link).filter((u): u is string => !!u));
  };

  console.log("\n== --en-drop: production query ==");
  for (const code of EN_DROP_GROUP) {
    const def = byCode.get(code);
    if (!def) throw new Error(`${code} is not a low-priority country`);
    current.set(code, await run("prod", code, newsDataQuery(def)));
  }

  console.log("\n== --en-drop: production query with en removed ==");
  for (const code of EN_DROP_GROUP) {
    const def = byCode.get(code);
    if (!def) throw new Error(`${code} is not a low-priority country`);
    const withoutEn = newsDataLanguages(def.lang).filter((l) => l !== "en");
    if (!withoutEn.length) continue; // English-only: dropping en would drop the filter
    dropped.set(code, await run("no-en", code, newsDataQuery({ code, lang: withoutEn.join(",") })));
  }

  // Overlap of every pair in the group, first with everyone on production, then
  // with every candidate switched to its en-dropped set.
  const matrix = (title: string, sets: Map<string, Set<string>>): void => {
    console.log(`\n== Jaccard, ${title} (pairs above 0) ==`);
    for (const code of EN_DROP_GROUP) {
      const mine = sets.get(code) ?? new Set<string>();
      const cells = EN_DROP_GROUP.filter((o) => o !== code)
        .map((o) => [o, jaccard(mine, sets.get(o) ?? new Set())] as const)
        .filter(([, j]) => j > 0)
        .map(([o, j]) => `${o} ${j.toFixed(2)}`);
      console.log(`  ${code} (${mine.size} urls): ${cells.length ? cells.join("  ") : "none"}`);
    }
  };
  matrix("everyone on production", current);
  matrix("candidates without en", new Map([...current, ...dropped]));
}

// main

async function main(): Promise<void> {
  await checkHeadroom();
  try {
    if (enDrop) {
      await enDropStep();
      return;
    }
    const rejected = skipStep0 ? [] : await step0();
    if (rejected.length) {
      console.log("\nA code was rejected: remove it from NEWSDATA_SUPPORTED_LANGS before running the variants.");
      return;
    }
    if (!step0Only) await step2();
  } finally {
    console.log(`\nNewsData calls made: ${calls - alreadySpent} this run, ${calls} counted against the cap of ${MAX_CALLS}. These bypass the credit ledger.`);
    if (outPath) {
      writeFileSync(outPath, JSON.stringify(raw, null, 2));
      console.log(`raw responses written to ${outPath}`);
    }
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
