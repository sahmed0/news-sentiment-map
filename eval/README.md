# Model evaluation

The evaluation has two studies measuring the sentiment pipeline:

1. **Accuracy** - how well the production scoring path classifies labelled English news sentences, plus a sweep of the neutral-band threshold.
2. **Translation drift** - how much a headline's score moves when it goes through the production translation pivot (English → language → English → score) instead of being scored directly.

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
pnpm eval -- --task all --dry-run     # fixtures only, no network, no spend
pnpm eval -- --task all               # the real run
pnpm eval -- --task accuracy          # one study at a time
pnpm eval -- --task drift
pnpm eval -- --task accuracy --limit 30       # short smoke test against the live APIs
pnpm eval -- --task drift --languages fr,de   # drift study split into specific languages at a time
```

Flags: `--task accuracy|drift|all` · `--dry-run` · `--limit N` (cap the items used - accuracy takes `N/3` per class) · `--languages fr,de,ar,ja,pt` (subset of the drift languages; default all five) · `--drift-items N` (items per language; default 100) · `--out DIR` (defaults to `eval/out/`).

`--languages` accepts commas or spaces, so PowerShell turning an unquoted `fr,de` into `fr de` is handled either way.

### Expected cost and runtime

For the default `--task all` - 300 accuracy sentences, and 100 items per language across 5 languages:

| Provider | Volume | Notes |
|---|---|---|
| Azure Translator | ~1,000 documents (~130 K characters) | 500 out (5 languages × 100 headlines) + 500 back. The free tier is 2 M characters/month. |
| HuggingFace inference | ~800 rows in batches of 50 | 300 for accuracy + 500 for the round trips. The 100 English baseline scores are reused from the accuracy task when you run `--task all`. |

Every run prints its own budget (documents, characters, requests) before the first call, plus the minimum minutes the Azure pacing will take, so you can interrupt one that would cost more than you want.

Wall clock is dominated by the **Azure character-rate pacing** below - expect the default `--task all` to take on the order of ten minutes on the free tier, most of it the harness deliberately waiting.

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

## Dataset

[NewsMTSC](https://github.com/fhamborg/NewsMTSC) (Hamborg & Donnay, EACL 2021), the `rw` configuration's test split: real English news sentences with manually annotated polarity, MIT licensed.

The labels are **target-dependent** (a sentence is annotated per named entity), while the map scores whole headlines. The harness therefore folds targets into sentence-level labels: **a sentence is kept only when every annotated target in it carries the same polarity**, and that polarity becomes the sentence's label. Sentences whose targets disagree - "Donald Trump attacks 'Alex' Baldwin on Twitter", negative for two targets and neutral for the platform - have no single sentence-level truth and are dropped. This yields silver-standard labels.

From the filtered pool the harness draws a seeded, class-balanced sample (100 per class by default, seed `20260824`, so the same sentences are measured on every machine and every re-run).

The HuggingFace dataset repo `fhamborg/news_sentiment_newsmtsc` is a *loading script*, not data - it points at a JSONL file in the project's GitHub repository. This harness downloads that same file, pinned to the same commit, over plain HTTPS. No `datasets` runtime, no HuggingFace token, no authentication.

`fixtures/newsmtsc-sample.jsonl` holds 17 rows copied verbatim from that file (MIT, © the NewsMTSC authors) for the offline tests and `--dry-run`.

## Layout

| Path | What |
|---|---|
| `run.ts` | CLI and the two study runners |
| `datasets.ts` | download, parse, target-agreement filter, seeded stratified sample |
| `pipeline.ts` | wrappers over the production scoring/translation functions + the eval-only English→language leg |
| `metrics.ts` | accuracy, per-class P/R/F1, macro-F1, confusion matrix, threshold sweep, drift statistics |
| `tables.ts` | markdown rendering of the two result objects |
| `cache.ts` | the disk cache every external call goes through |
| `fixtures/` | recorded dataset rows and the offline HTTP router used by `--dry-run` |
| `data/` | downloads, cache, dry-run output - gitignored on my machine |
| `out/` | results |

Tests live in `test/eval/` and run with the rest of the suite (`pnpm test`). They never touch the network: the dry-run router throws on any host that is not the dataset, Azure or HuggingFace.
