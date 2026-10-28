# Model evaluation

The evaluation has two studies measuring the sentiment pipeline:

1. **Accuracy** - how well the production scoring path classifies labelled English news sentences, on **every** usable sentence of the NewsMTSC `rw` dataset (8,367 after filtering), plus a sweep of the neutral-band threshold.
2. **Translation drift** - how much a headline's score moves when it goes through the production translation pivot (English → language → English → score) instead of being scored directly, on a seeded, class-balanced sample of **600** sentences in five languages.

Both call the *real* production functions (`scoreInChunks`, `translateAll` from `api/_lib/sentiment-fetch.ts`), so what is measured is the deployed behaviour; the same batching, the same `top_k: null` parsing, the same retries.

## If you want to run the evaluation yourself to verify my results
### Prerequisites

You will need to sign up for the following services and set these environment variables in your shell before a live run (the same values the deployment uses):

| Variable | Used for | Required |
|---|---|---|
| `HUGGINGFACE_API_KEY` | sentiment scoring (`cardiffnlp/twitter-roberta-base-sentiment-latest`) | yes |
| `AZURE_TRANSLATOR_KEY` | translation, both directions | yes |
| `AZURE_TRANSLATOR_REGION` | only for regional (non-Global) Translator resources | if your resource is regional |
| `AZURE_CHARS_PER_MINUTE` | raises the self-pacing character budget (see below); default 30,000 suits the F0 free tier | no |

PowerShell:

```powershell
$env:HUGGINGFACE_API_KEY = "hf_..."
$env:AZURE_TRANSLATOR_KEY = "..."
$env:AZURE_TRANSLATOR_REGION = "..."   # omit for a Global resource
```

A live run with either key missing fails immediately rather than producing a page of nulls.

### Commands

```powershell
pnpm eval -- --task all --dry-run             # fixtures only, no network, no spend
pnpm eval -- --task all --drift-batches 1     # smoke run first: the full run's own first batches
pnpm eval -- --task all                       # the real run (shows the plan and asks before spending)
pnpm eval -- --task all --yes                 # the same, without the prompt
pnpm eval -- --task all --offline             # recompute statistics from the cache; a miss throws
pnpm eval -- --task accuracy                  # one study at a time
pnpm eval -- --task drift
pnpm eval -- --task drift --languages fr,de   # drift study split into specific languages at a time
```

Flags:

- `--task accuracy|drift|all`
- `--dry-run` · `--offline`
- `--limit N` caps both studies: accuracy takes a seeded `N/3` per class instead of the whole pool, and the drift sample is at most `N`.
- `--drift-items N`: the drift sample size, default 600 (`N/3` per class).
- `--drift-batches N`: a smoke run. It draws the real 600-sentence drift sample, then runs only its first `N` batches of 100 (all languages). It writes to `eval/data/smoke-out/` by default, refuses `eval/out/`, and cannot be combined with `--limit` or `--drift-items`, which would change the sample.
- `--languages fr,de,ar,ja,pt`: a subset of the drift languages; default all five. Accepts commas or spaces, so PowerShell turning an unquoted `fr,de` into `fr de` is handled either way.
- `--yes`: skip the confirmation prompt.
- `--max-azure-chars N`: the hard Azure character cap for the run, default 1,000,000.
- `--out DIR`: defaults to `eval/out/` (`eval/data/dry-run-out/` under `--dry-run`, `eval/data/smoke-out/` under `--drift-batches`).

### Smoke run first

Run `pnpm eval -- --task all --drift-batches 1` before any full run.

**Why.** Its batches are the full run's first batches, with identical cache keys, so a good smoke run is free: the full run reuses all of it. A bad one (a silent API or translation problem that only real Azure shows) loses ~140K characters, not ~900K. It runs all five languages, because each is a separate API call with its own scripts and quirks.

**What it costs.** The full accuracy study (reused by the full run) plus 100 sentences × 5 languages ≈ 0.14 M Azure characters actual (136,567 measured on 2026-10-27; ≈ 0.17 M projected), about 20 minutes.

**Checklist.** A good smoke run meets every item below.

- The run finished with `[eval] done`, and HuggingFace logged no `came back unscored` error.
- The `[eval] spent:` line shows Azure characters at or below the projection (my smoke run used 0.14 M against ~0.17 M projected). Lower is harmless. Actual **above** projected means the measured back-leg ratios under-estimate this sample, so the full run's projection cannot be trusted.
- At most a few `[Azure] … retrying` lines. `[Azure] pacing:` lines are normal.
- The `[smoke]` lines: for each language, the middle text is really in that language (French, German, Arabic script, Japanese script, Portuguese), not English echoed back, and the last text is English close in meaning to the first.
- `eval/data/smoke-out/accuracy.json`: `unscored` is 0, `modelRevision` is a 40-hex sha, and balanced accuracy is well above 0.333.
- `eval/data/smoke-out/drift-tables.md`: every language has `n` = 100 and a mean |Δ| above 0 (exactly 0 means the text came back unchanged). Flip rates are below ~40%, and not all five are 0%. A single 0% is possible on 100 negative sentences.

If an item fails, investigate before the full run. The cache keeps what was already done, so there is no need to delete it.

### Before it spends anything

A live run never sends a billable request before you have seen the bill:

1. **The plan.** It reads the cache and prints what is still uncached: HuggingFace requests for each study, and the Azure characters the round trips will cost. The return leg is billed on the *translated* text, so its cost is projected from back-leg ratios measured on earlier runs, plus a 10% margin.
2. **The cap.** If the projected Azure characters exceed `--max-azure-chars` (default 1,000,000), the run stops there. During the run, a ledger counts every character actually sent (retries and the preflight included) and refuses any request that would cross the cap; completed batches stay cached.
3. **The prompt.** `Proceed and spend this? [y/N]`. `--yes` skips it. Without a terminal (a piped or scheduled run) and without `--yes`, the run refuses. If everything is already cached, it says so and does not ask.
4. **HuggingFace failures are loud.** Production's scorer quietly returns nulls when HuggingFace fails (fine for the map, where a country just goes unscored). The eval retries such a batch, then throws, and **never caches it**, so a re-run resumes from that batch. `unscored` in the output is therefore always 0.

At the end, a live run prints what it actually spent against the projection, and records it as `spend` in both JSONs.

**If you use the same Azure key as a deployment of the map, run it between the deployment's cron ticks.** They share the key's 2 M/month quota and per-minute character limit, so a refresh during the drift study can make both hit 429s.

### Re-running for free: `--offline`

A re-run costs nothing **only** while every request is a cache hit. A changed sample, a changed model URL or a cleared cache turns hits into misses, and a miss spends live quota (the plan and prompt above show it first). `--offline` turns every miss into an error before the request is made, skips the Azure preflight, and needs no API keys, so it can never spend anything.

**Use it for any re-run whose purpose is recomputing statistics** (new intervals, a new baseline, a changed table) rather than gathering new measurements:

```powershell
pnpm eval -- --task all --offline
```

If it fails with `--offline: cache miss for …`, the cache no longer covers the run, and dropping the flag would spend quota on the missing requests.

An `--offline` run records `modelRevision` and `spend` as `null`, since it contacts nothing. The committed outputs in `eval/out/` are from the live run, so they keep that provenance.

### Expected cost and runtime

For the default `--task all`:

| | Volume | Notes |
|---|---|---|
| Accuracy | 8,367 HuggingFace rows in 168 requests | the whole pool |
| Drift, Azure | 6,000 documents ≈ 0.88 M characters actual (≈ 0.92 M projected) | 600 sentences × 5 languages × out and back. The free tier is 2 M characters/month. |
| Drift, HuggingFace | 3,000 rows in 60 requests | the round-tripped text. The 600 direct English scores are reused from the accuracy study. |
| Wall clock | ≥ ~31 min of Azure pacing + ~17 min of HuggingFace (228 requests) | about 50 minutes in all: the accuracy scoring (~13 min) runs first, then the Azure-paced drift study |

The same totals, split across the two recommended runs:

| Run | Azure characters | Time |
|---|---|---|
| Smoke run (`--drift-batches 1`) | ≈ 0.14 M actual (136,567 measured, 2026-10-27) | ~20 min |
| Full run after it | ≈ 0.72 M actual (≈ 0.76 M projected) | ~30 min, with the accuracy study fully cached |

HuggingFace cost was ~$0.000028 per request on my pay-as-you-go account (October 2026), so about $0.006 (under one cent) per full run.

### Azure rate limiting (the character budget)

Azure Translator meters **characters, not requests**. The free **F0** tier allows 2 million characters/hour, and as per [Microsoft's service limits](https://learn.microsoft.com/en-us/azure/ai-services/translator/service-limits), that quota must be consumed *evenly*, "no faster than roughly 33,300 characters per minute", enforced as a sliding window. A back-to-back full run sends ~31 K characters (one language's out-and-back legs) in about two seconds, which trips `HTTP 429` / `429001` immediately, which is exactly how my first two live runs failed. A per-*request* gap does nothing about a per-*character* limit.

The harness now paces itself to a sliding character budget (default **30,000/min**, just under the free tier limit) across both translation legs and the preflight, and retries a 429 with long exponential backoff. On a paid tier you can raise the budget and the pacing effectively vanishes:

```powershell
$env:AZURE_CHARS_PER_MINUTE = "600000"   # e.g. an S1 resource (40 M/hour)
```

If it still throttles, drip-feed the languages and let the cache accumulate:

```powershell
pnpm eval -- --task drift --languages fr,de,pt
pnpm eval -- --task drift --languages ar,ja
pnpm eval -- --task all                          # writes the final outputs; re-spends nothing
```

A failed leg is never cached, the wrappers throw rather than resolving with placeholder text, so a retry genuinely retries. Consequently, a rate-limited run that outlasts its retries **crashes instead of publishing a zero**: drift statistics computed over too few surviving pairs are refused outright.

**Every external call is cached on disk** under `eval/data/cache/`, keyed by a hash of the request. If a run crashes or you interrupt it, re-running costs nothing for the work already done. Delete that directory only if you want to start from scratch again.

`--dry-run` uses a separate cache (`eval/data/cache-dryrun/`) and writes to `eval/data/dry-run-out/`, so fixture numbers can never be mistaken for real results.

### When the run finishes

Outputs land in `eval/out/`:

- `accuracy.json`, `accuracy-tables.md`
- `drift.json`, `drift-tables.md`
- `accuracy-items.json` and `drift-items.json`: one record per sentence (id, split, label, and the unrounded scores). They hold ids, not text; join them with the dataset by `id`. With these, every interval in the output can be recomputed (`test/eval/committed-output.test.ts` does).

## Dataset

[NewsMTSC](https://github.com/fhamborg/NewsMTSC) (Hamborg & Donnay, EACL 2021), all three splits of the `rw` configuration (test, dev and train), pinned to one commit: real English news sentences with manually annotated polarity, MIT licensed.

The labels are **target-dependent** (a sentence is annotated per named entity), while the map scores whole headlines. The harness therefore folds targets into sentence-level labels: **a sentence is kept only when every annotated target in it carries the same polarity**, and that polarity becomes the sentence's label. Sentences whose targets disagree - "Donald Trump attacks 'Alex' Baldwin on Twitter", negative for two targets and neutral for the platform - have no single sentence-level truth and are dropped. This yields silver-standard labels.

The three splits are concatenated in the order test, dev, train before that fold, so a sentence found in more than one split is judged on all of its rows. Four sentences are: three agree and are kept once (as the earlier split's row), and one contradicts itself across splits and is dropped. Finally, items over 2,000 characters are dropped, because the model accepts at most 512 tokens and HuggingFace rejects a longer input outright (HTTP 400) instead of truncating it. Exactly one item is that long: a 6,321-character list of names that NewsMTSC's sentence splitter left in one piece. The longest real sentence is 1,397 characters. The result is 8,367 sentences: 3,055 negative, 3,064 neutral and 2,248 positive.

**No train/test leakage.** The model was never trained on NewsMTSC, so its train split is as fair to evaluate on as its test split. The [model card](https://huggingface.co/cardiffnlp/twitter-roberta-base-sentiment-latest) says it was pre-trained on ~124M tweets (TimeLMs, January 2018 to December 2021) and fine-tuned on `tweet_eval`, and mentions no news dataset.

Each run records `modelRevision`, the model repo's commit on the HuggingFace Hub at run time. That is provenance, not a guarantee: the HuggingFace inference router does not promise to serve that exact revision.

One seed, `20261027`, drives everything random: the drift sample, every bootstrap and `--limit` sampling. So the same sentences and the same intervals come out on every machine and every re-run.

The HuggingFace dataset repo `fhamborg/news_sentiment_newsmtsc` is a *loading script*, not data - it points at JSONL files in the project's GitHub repository. This harness downloads those same files, pinned to the same commit, over plain HTTPS. No `datasets` runtime, no HuggingFace token, no authentication.

`fixtures/` holds 17 + 8 + 8 rows copied verbatim from the start of the test, dev and train files (MIT, © the NewsMTSC authors) for the offline tests and `--dry-run`.

## Layout

| Path | What |
|---|---|
| `run.ts` | CLI, the plan and prompt, and the two study runners |
| `datasets.ts` | download, parse, target-agreement and cross-split fold, seeded stratified sample, cluster keys |
| `pipeline.ts` | wrappers over the production scoring/translation functions + the eval-only English→language leg, the spend ledger and cap, and the planner |
| `metrics.ts` | accuracy, balanced accuracy, per-class P/R/F1, macro-F1, confusion matrix, threshold sweep, drift statistics, the output types |
| `stats.ts` | confidence intervals: Wilson for proportions, seeded percentile bootstraps (item, cluster, stratified) for everything else |
| `drift.ts` | the drift study's per-language, per-class, pool-weighted and pairwise statistics |
| `baselines.ts` | majority-class and AFINN-165 lexicon baselines |
| `data-static/` | vendored, committed data (the AFINN-165 lexicon; licence and citation in its README) |
| `tables.ts` | markdown rendering of the two result objects |
| `cache.ts` | the disk cache every external call goes through |
| `fixtures/` | recorded dataset rows and the offline HTTP router used by `--dry-run` |
| `data/` | downloads, cache, dry-run and smoke-run output (gitignored) |
| `out/` | results |

Tests live in `test/eval/` and run with the rest of the suite (`pnpm test`). They never touch the network: the dry-run router throws on any host that is not the dataset, Azure or HuggingFace.
