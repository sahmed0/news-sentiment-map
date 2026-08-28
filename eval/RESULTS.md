# Model evaluation - results

**63.3% 3-class accuracy (macro-F1 0.627) on 300 labelled news sentences; translation round-trip flips the label on 8–15% of headlines depending on language (worst: Japanese, 15.2%).**

## Methodology

**Pipeline under test.** Exactly what production runs: a headline in English is scored directly by [`cardiffnlp/twitter-roberta-base-sentiment-latest`](https://huggingface.co/cardiffnlp/twitter-roberta-base-sentiment-latest) via the HuggingFace inference router; a headline in any other language is first translated to English by Azure Translator and the translation is scored. The score is `P(positive) − P(negative)`, in `[−1, 1]`, and the map buckets it with a ±0.1 neutral band. The eval calls the production functions themselves (`scoreInChunks`, `translateAll`), not copies.

**Dataset.** NewsMTSC (Hamborg & Donnay, EACL 2021), `rw` configuration, test split - manually annotated English news sentences, MIT licensed. Labels are target-dependent; the harness folds them to sentence level by keeping only sentences where **every annotated target shares the same polarity**, using that polarity as the sentence label. Sentences with disagreeing targets are dropped, as they have no single sentence-level truth.

**Sample.** Seeded (`20260824`), class-balanced: up to 100 sentences per class (~300 total) for the accuracy study; a seeded ~100-sentence class-balanced subset of the same sample, drawn per class, for the drift study.

**Run date:** 2026-08-24.

## Accuracy

**63.3% 3-class accuracy, macro-F1 0.627** (n = 300, 0 unscored).

### Per class

| Class | Precision | Recall | F1 | Support |
|---|---|---|---|---|
| negative | 0.571 | 0.850 | 0.683 | 100 |
| neutral | 0.571 | 0.440 | 0.497 | 100 |
| positive | 0.824 | 0.610 | 0.701 | 100 |

### Confusion matrix

| actual \ predicted | negative | neutral | positive |
|---|---|---|---|
| **negative** | 85 | 13 | 2 |
| **neutral** | 45 | 44 | 11 |
| **positive** | 19 | 20 | 61 |

The model leans negative. It recovers 85% of true-negative sentences but at low precision (0.571), because it also reads nearly half of the neutral set (45 of 100) as negative - neutral is the weakest class by far, with 0.440 recall. Positive is the opposite trade-off: high precision (0.824), so a "positive" prediction is usually right, but 0.610 recall, with the missed positives lost roughly equally to negative (19) and neutral (20). Crucially the errors are almost all pole-to-neutral or into the negative bias, not pole-to-pole: only 2 negatives were called positive and 19 positives called negative, so the model rarely inverts a headline's sign - it mostly softens or over-darkens it.

## Threshold sweep

The shipped map uses ±0.10. Every other row is the same 300 scores mapped with a different neutral band - the sweep is free because the scores are already computed.

| Band ±t | Accuracy | Macro-F1 |
|---|---|---|
| 0.05 | 62.0% | 0.596 |
| 0.10 *(shipped)* | 63.3% | 0.627 |
| 0.15 | 64.0% | 0.638 |
| 0.20 | 63.0% | 0.628 |
| 0.25 | 61.0% | 0.607 |
| 0.30 | 58.0% | 0.575 |

The shipped ±0.10 band is near-optimal: the macro-F1 peak is at ±0.15 (0.638), only +0.011 above ±0.10 and +0.7 pp of accuracy - within the noise of a 300-item sample. Both narrower and wider bands are worse, and beyond ±0.20 macro-F1 falls off sharply. Widening the band toward 0.15 would paint marginally more countries neutral-yellow (fewer weak scores committed to a pole); narrowing it makes the map more opinionated on thin evidence. Given how small the gain is, there is no accuracy case for moving the band - any change would be a product/visual choice, not a correctness one.

## Translation drift

Each item is translated English → language → English through the production Azure + HuggingFace path, then compared with its direct English score (n = 99 per language).

| Language | n | Mean \|Δ\| | Median Δ | Max \|Δ\| | Label-flip rate | Pearson r |
|---|---|---|---|---|---|---|
| fr | 99 | 0.069 | -0.004 | 0.469 | 8.1% | 0.970 |
| de | 99 | 0.083 | -0.001 | 0.463 | 12.1% | 0.958 |
| ar | 99 | 0.078 | 0.003 | 0.441 | 8.1% | 0.965 |
| ja | 99 | 0.112 | -0.005 | 0.607 | 15.2% | 0.933 |
| pt | 99 | 0.071 | 0.003 | 0.441 | 12.1% | 0.969 |

Japanese is the worst on every measure - highest mean |Δ| (0.112), highest max |Δ| (0.607), highest flip rate (15.2%), lowest correlation (r 0.933) - which fits the expectation that a CJK pivot loses the most in round-trip. But across all five languages the drift is mostly small noise, not systematic bias: every Pearson r is ≥ 0.93 and every median Δ sits within ±0.005 of zero, so translation neither reliably brightens nor darkens a headline; it just adds scatter. The flips (8–15%) come from that scatter tipping already-borderline scores across a bucket boundary. Per the limitation below, each rate carries a ~±8 pp interval, so the ordering between adjacent rows (e.g. de vs pt, both 12.1%) is not meaningful.
Japanese can be thought of as "the noisiest" and the European/Arabic languages as low-noise and comparable, rather than as a strict ranking.

## Limitations

- **Domain mismatch.** The model is fine-tuned on tweets; this evaluation is news sentences.
- **Translation pivot.** Every non-English headline is scored on a machine translation, so the drift study measures the pipeline's own added error, which is why it exists.
- **Silver labels.** Sentence-level labels are derived from target-level annotations by the agreement filter above; they are not human sentence-level judgements.
- **The drift rates are estimates, not rankings.** Each language's flip rate comes from ~100 items, so its 95% interval is roughly ±8 percentage points. That is wide enough to support a claim about groups of languages and too wide to say one language is better than its neighbour in the table. Read the numbers accordingly.
- **Small per-country sample.** The live map averages at most five headlines per country per refresh, so a country's daily score is noisier than any figure here.
- **Sentences, not headlines.** NewsMTSC items are sentences drawn from article bodies. They are close to headline register but not identical to it.

The single most promising next step is a news-domain sentiment model in place of the Twitter-tuned one: the accuracy errors are concentrated in the neutral class and a general negative lean rather than in sign inversions, which is exactly the kind of miscalibration a domain-matched model tends to fix, and it would also shrink the Japanese-heavy translation drift by making the English scorer less sensitive to the phrasing noise a round-trip introduces.

## Reproduction

```powershell
pnpm eval -- --task all
```

See [eval/README.md](README.md) for the required environment variables, expected spend, and the caching behaviour. Raw outputs live in [eval/out/](out/).
