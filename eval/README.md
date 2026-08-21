# Model evaluation

The evaluation has two studies measuring the sentiment pipeline:

1. **Accuracy** - how well the production scoring path classifies labelled English news sentences, plus a sweep of the neutral-band threshold.
2. **Translation drift** - how much a headline's score moves when it goes through the production translation pivot (English → language → English → score) instead of being scored directly.

Both call the *real* production functions (`scoreInChunks`, `translateAll` from `api/_lib/sentiment-fetch.ts`), so what is measured is the deployed behaviour; the same batching, the same `top_k: null` parsing, the same retries.

## Dataset

[NewsMTSC](https://github.com/fhamborg/NewsMTSC) (Hamborg & Donnay, EACL 2021), the `rw` configuration's test split: real English news sentences with manually annotated polarity, MIT licensed.

The labels are **target-dependent** (a sentence is annotated per named entity), while the map scores whole headlines. The harness therefore folds targets into sentence-level labels: **a sentence is kept only when every annotated target in it carries the same polarity**, and that polarity becomes the sentence's label. Sentences whose targets disagree - "Donald Trump attacks 'Alex' Baldwin on Twitter", negative for two targets and neutral for the platform - have no single sentence-level truth and are dropped. This yields silver-standard labels.

From the filtered pool the harness draws a seeded, class-balanced sample (100 per class by default, seed `20260722`, so the same sentences are measured on every machine and every re-run).

The HuggingFace dataset repo `fhamborg/news_sentiment_newsmtsc` is a *loading script*, not data - it points at a JSONL file in the project's GitHub repository. This harness downloads that same file, pinned to the same commit, over plain HTTPS. No `datasets` runtime, no HuggingFace token, no authentication.

`fixtures/newsmtsc-sample.jsonl` holds 17 rows copied verbatim from that file (MIT, © the NewsMTSC authors) for the offline tests and `--dry-run`.
