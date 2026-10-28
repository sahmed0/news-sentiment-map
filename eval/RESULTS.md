# Model evaluation - results

**On all 8,367 usable NewsMTSC `rw` sentences, the production pipeline scores balanced accuracy 67.4% (95% CI 66.4–68.3%) and macro-F1 0.660 (95% CI 0.650 – 0.670); raw accuracy is 66.8% (95% CI 65.8–67.8%), a figure that reflects NewsMTSC's class mix. It clearly beats the AFINN-165 word list, by +0.120 macro-F1 (95% CI +0.107 to +0.132). A translation round trip flips the label on 7.2–14.8% of 600 sentences depending on language: Japanese drifts more than French, German and Portuguese, and Arabic more than German, while the other six language pairs are not separated by this sample.**

All intervals are 95% unless labelled otherwise. Proportions (accuracy, recall, flip rates) use the Wilson score interval; balanced accuracy, macro-F1, every paired difference and the mean |Δ| use a seeded percentile bootstrap. Where several comparisons are made at once (the five sweep bands against the shipped one, the ten language pairs), a difference is called **established** only if its Bonferroni-adjusted interval excludes zero (99% for the sweep, 99.5% for the language pairs); otherwise the sample does not establish it, whatever the point estimate. See [Reproduction](#reproduction).

## Methodology

**Pipeline under test.** Exactly what production runs: a headline in English is scored directly by [`cardiffnlp/twitter-roberta-base-sentiment-latest`](https://huggingface.co/cardiffnlp/twitter-roberta-base-sentiment-latest) via the HuggingFace inference router; a headline in any other language is first translated to English by Azure Translator and the translation is scored. The score is `P(positive) − P(negative)`, in `[−1, 1]`, and the map buckets it with a ±0.1 neutral band. The eval calls the production functions themselves (`scoreInChunks`, `translateAll`), not copies.

**Dataset.** NewsMTSC (Hamborg & Donnay, EACL 2021), `rw` configuration, **all three splits** (test, dev and train) at a pinned commit - manually annotated English news sentences, MIT licensed. Labels are target-dependent; the harness folds them to sentence level by keeping only sentences where **every annotated target shares the same polarity**, using that polarity as the sentence label. Sentences with disagreeing targets are dropped, as they have no single sentence-level truth. The splits are concatenated (test, dev, train) before the fold, so the rule also applies across splits: of the 4 sentences that appear in more than one split, 3 agree and are kept once, and 1 contradicts itself and is dropped. One more item is dropped for length: a 6,321-character list of names that NewsMTSC's sentence splitter left whole, too long for the model's 512-token input (the limit is 2,000 characters; the longest real sentence is 1,397). Using the train split is fair here, because the model never saw NewsMTSC: its [model card](https://huggingface.co/cardiffnlp/twitter-roberta-base-sentiment-latest) describes pre-training on ~124M tweets (2018–2021) and fine-tuning on `tweet_eval`, and mentions no news data.

**Accuracy sample.** The whole pool: 8,367 sentences (test 724, dev 312, train 7,331), with no sampling. The pool is 37% negative, 37% neutral and 27% positive, so raw accuracy depends on that mix. Neither NewsMTSC's mix nor a balanced one is the mix the live map sees, so the main metrics are **balanced accuracy** (the unweighted mean of the three per-class recalls) and **macro-F1**, which do not depend on it. Raw accuracy is still reported, labelled as reflecting NewsMTSC's mix.

**Drift sample.** 600 sentences, 200 per class, a fresh seeded draw (`20261027`) from the full pool. It is drawn balanced so each class's flip rate is measured on enough items to compare; the flip rate re-weighted to the pool's class mix is reported as well. None of the previous evaluation's drift sentences are reused, so every translation in this study comes from one run.

**Run date:** 2026-10-27 (accuracy study) and 2026-10-28 (drift study), UTC. **Hub revision at run time:** `3216a57f2a0d9c45a2e6c20157c20c49fb4bf9c7`. That is the model repo's commit on the HuggingFace Hub when the run started; the inference router does not promise to serve that exact revision, so it is provenance rather than proof of the weights.

## Accuracy

**Balanced accuracy 67.4% (95% CI 66.4–68.3%), macro-F1 0.660 (95% CI 0.650 – 0.670)** (n = 8,367, 0 unscored). Raw accuracy 66.8% (95% CI 65.8–67.8%) reflects NewsMTSC's class mix (neg 36.5% / neu 36.6% / pos 26.9%).

### Per class

| Class | Precision | Recall (95% CI) | F1 | Support |
|---|---|---|---|---|
| negative | 0.648 | 0.861 (0.848 – 0.872) | 0.740 | 3055 |
| neutral | 0.660 | 0.429 (0.412 – 0.447) | 0.520 | 3064 |
| positive | 0.709 | 0.732 (0.713 – 0.750) | 0.720 | 2248 |

Recall intervals are Wilson on each class's items. Precision and F1 are shown without intervals; macro-F1 carries the bootstrap interval for the F1 family as a whole.

### Confusion matrix

| actual \ predicted | negative | neutral | positive |
|---|---|---|---|
| **negative** | 2629 | 317 | 109 |
| **neutral** | 1183 | 1316 | 565 |
| **positive** | 242 | 361 | 1645 |

The model leans negative, as it did in the previous evaluation. It recovers most negative sentences (recall 0.861) but at lower precision (0.648), because it reads 1,183 of the 3,064 neutral sentences as negative. Neutral is the weakest class by far, with 0.429 recall: almost as many neutral sentences are called negative (1,183) as are called neutral (1,316). Positive is the most even class, with precision 0.709 and recall 0.732, and its misses go more to neutral (361) than to negative (242). The errors are mostly pole-to-neutral or into the negative lean, not pole-to-pole: 109 of 3,055 negatives were called positive and 242 of 2,248 positives negative, the smallest error cell in each of those two rows.

### By split

| Split | n | Accuracy (95% CI) | Balanced accuracy (95% CI) | Macro-F1 (95% CI) |
|---|---|---|---|---|
| test | 724 | 65.2% (61.7–68.6%) | 65.3% (61.9–68.8%) | 0.650 (0.614 – 0.685) |
| dev | 312 | 64.4% (59.0–69.5%) | 63.8% (58.5–69.1%) | 0.626 (0.567 – 0.679) |
| train | 7331 | 67.1% (66.0–68.1%) | 67.6% (66.6–68.6%) | 0.661 (0.651 – 0.672) |

The three splits' intervals overlap on every metric, so the result is consistent across splits. Test and dev sit a little below train as point estimates, but they are much smaller, and on every metric both of their intervals contain train's estimate.

### Sensitivity to clustering

The intervals above treat sentences as independent, but sentences from one article are correlated. As a check, the main intervals are recomputed by resampling whole groups instead of sentences, at two levels: the *article*, and the *story* (AllSides groups several outlets' articles on one story). Both groupings are inferred from the structure of NewsMTSC's ids, which the dataset does not document. On the class shares, the measured design effect (cluster-level variance over item-level variance) is 1.09–1.29 at article level and 1.18–1.43 at story level, so the clustered intervals are expected to be somewhat wider. They are reported as a check, not used in place of the item-level ones.

| Resampling unit | Units | Accuracy | Balanced accuracy | Macro-F1 |
|---|---|---|---|---|
| sentence (reported) | 8367 | 65.8–67.8% | 66.4–68.3% | 0.650 – 0.670 |
| article | 5802 | 65.8–67.8% | 66.4–68.3% | 0.650 – 0.670 |
| story | 4930 | 65.8–67.8% | 66.4–68.3% | 0.650 – 0.670 |

Resampling whole articles or whole stories leaves every main interval unchanged at the precision reported: in the unrounded output, the story-level intervals are under 5% wider than the sentence-level ones on all three metrics. The class shares cluster by story (the design effects above), but the model's errors cluster much less, so treating sentences as independent costs little here.

## Baselines

Both baselines are scored on the same items as the model and bucketed with the same production rule (`bucketAt(score, 0.1)`).

| Classifier | Accuracy (95% CI) | Balanced accuracy (95% CI) | Macro-F1 (95% CI) |
|---|---|---|---|
| Majority class (always neutral) | 36.6% | 33.3% | 0.179 |
| AFINN-165 lexicon | 53.8% (52.7–54.8%) | 54.4% (53.3–55.5%) | 0.540 (0.529 – 0.551) |
| **Model** | 66.8% (65.8–67.8%) | 67.4% (66.4–68.3%) | 0.660 (0.650 – 0.670) |

**Majority class** predicts the most common label, always neutral here, for everything. Its accuracy equals that class's share of the pool, and its balanced accuracy is exactly 1/3 by construction (recall 1 on one class, 0 on the other two). Both are fixed by the data rather than estimated, so they carry no interval. It is the floor, and too weak to be informative on its own.

**AFINN-165** ([Nielsen 2011](data-static/README.md)) is a 3,382-word lexicon with integer scores from −5 to +5, vendored as data in [`data-static/`](data-static/) (Apache-2.0). A headline's score is the mean AFINN score of the words it matched, divided by 5; a headline with no matched word scores 0, which is neutral. Dividing by *matched* rather than total words stops a headline with one strong word being diluted by its function words. The 30 multi-word entries are dropped rather than phrase-matched, and five of them are the list's only negations ("not good", "does not work", …), so **this baseline has no negation handling at all**. That is a fair picture of a bag-of-words lexicon. Its margin is reported with a *paired* bootstrap: items are resampled together, so the interval keeps the correlation between the two classifiers' errors. It is a single comparison, so it is not Bonferroni-adjusted.

**What the comparison shows.** On the same items, the model leads AFINN by +0.120 macro-F1 (95% CI +0.107 to +0.132) and +13.0 pp of balanced accuracy (95% CI +11.8 pp to +14.3 pp). Both intervals are far from zero, so on macro-F1 this is a clear lead, and it settles the question the previous evaluation left open. The lead comes from the two poles: on neutral sentences AFINN is right more often than the model (1,509 of 3,064, against 1,316), plausibly because a sentence with no matched word defaults to neutral, while the model leans negative. On negative sentences (2,629 right against AFINN's 1,631) and positive ones (1,645 against 1,359) the model is well ahead.

**VADER would be the stronger lexicon comparison.** It handles negation, intensifiers and punctuation, and was designed for short social-media text close to headline register. It was not used because using it here would mean hand-porting its rule set, and a subtly faulty port would produce a baseline that looks authoritative and is wrong. AFINN is data only, so there is nothing to port.

## Threshold sweep

The shipped map uses ±0.10. Every other row is the same scores mapped with a different neutral band - the sweep is free because the scores are already computed. Each band is compared with ±0.10 by a paired bootstrap on the same items, which resolves much smaller differences than comparing the rows' separate intervals. With five bands compared against the shipped one, a band counts as better or worse only if its 99% Bonferroni-adjusted interval excludes zero.

| Band ±t | Accuracy | Balanced acc. | Macro-F1 | Δ macro-F1 vs ±0.10 (95% CI) | 99% adj. CI | Δ balanced acc. vs ±0.10 (95% CI) | 99% adj. CI | Established? |
|---|---|---|---|---|---|---|---|---|
| 0.05 | 64.0% | 65.4% | 0.610 | −0.051 (−0.058 to −0.043) | −0.060 to −0.041 | −2.0 pp (−2.6 pp to −1.4 pp) | −2.8 pp to −1.2 pp | both |
| 0.10 *(shipped)* | 66.8% | 67.4% | 0.660 | - | - | - | - | - |
| 0.15 | 67.7% | 67.7% | 0.675 | +0.015 (+0.009 to +0.020) | +0.007 to +0.022 | +0.3 pp (−0.2 pp to +0.8 pp) | −0.4 pp to +1.0 pp | macro-F1 |
| 0.20 | 67.4% | 67.0% | 0.674 | +0.014 (+0.007 to +0.021) | +0.004 to +0.024 | −0.4 pp (−1.1 pp to +0.3 pp) | −1.3 pp to +0.5 pp | macro-F1 |
| 0.25 | 67.0% | 66.2% | 0.670 | +0.010 (+0.001 to +0.018) | −0.002 to +0.021 | −1.2 pp (−2.0 pp to −0.4 pp) | −2.3 pp to −0.2 pp | balanced acc. |
| 0.30 | 66.1% | 65.0% | 0.661 | +0.001 (−0.009 to +0.010) | −0.012 to +0.013 | −2.4 pp (−3.3 pp to −1.5 pp) | −3.5 pp to −1.3 pp | balanced acc. |

Two bands beat ±0.10 on macro-F1: ±0.15 by +0.015 (99% adjusted CI +0.007 to +0.022) and ±0.20 by +0.014 (+0.004 to +0.024). Neither beats it on balanced accuracy, where ±0.15 is +0.3 pp (adjusted −0.4 pp to +1.0 pp) and ±0.20 is −0.4 pp (−1.3 pp to +0.5 pp), so on that measure the shipped band is within noise of both. Every other established difference goes against the alternative: ±0.05 is worse on both metrics, and ±0.25 and ±0.30 are worse on balanced accuracy. The gain on offer is small: a ±0.15 band would add about 0.015 macro-F1, by sending more weak scores to neutral, with no established cost in balanced accuracy. The previous evaluation's 300 sentences could not resolve a difference that size; this sample can. I'm keeping ±0.10 for now.

## Translation drift

Each item is translated English → language → English through the production Azure + HuggingFace path, then compared with its direct English score (n = 600 per language, 200 per class).

| Language | n | Mean \|Δ\| (95% CI) | Median Δ | Max \|Δ\| | Label-flip rate (95% CI) | Pearson r |
|---|---|---|---|---|---|---|
| fr | 600 | 0.072 (0.064 – 0.080) | 0.001 | 1.409 | 10.0% (7.8–12.7%), 60 flips | 0.967 |
| de | 600 | 0.071 (0.064 – 0.079) | 0.000 | 1.039 | 7.2% (5.4–9.5%), 43 flips | 0.969 |
| ar | 600 | 0.092 (0.082 – 0.103) | 0.000 | 1.475 | 11.8% (9.5–14.7%), 71 flips | 0.944 |
| ja | 600 | 0.115 (0.104 – 0.126) | 0.001 | 1.005 | 14.8% (12.2–17.9%), 89 flips | 0.930 |
| pt | 600 | 0.063 (0.056 – 0.071) | 0.000 | 0.913 | 8.5% (6.5–11.0%), 51 flips | 0.973 |

Flip rates carry Wilson intervals and mean |Δ| a bootstrap interval. Median Δ, max |Δ| and r are descriptive.

Flip rates run from 7.2% (German) to 14.8% (Japanese). Japanese is the noisiest language on every summary measure except max |Δ|: the highest mean |Δ| (0.115), the highest flip rate and the lowest correlation (r 0.930). Across all five languages the drift is mostly scatter, not bias: every median Δ is within 0.001 of zero and every Pearson r is at least 0.930, so a round trip neither brightens nor darkens a sentence on average. The larger sample does show rare large swings that the previous evaluation's 99 sentences did not: max |Δ| is above 1 in four languages (up to 1.475 in Arabic), so somewhere in each of those a sentence's score swung across the scale from one sign to the other.

### By true class

The sample is balanced, so each class's flip rate is measured on 200 items. The pool-weighted rate re-weights those three rates to the pool's class mix (37/37/27), which is closer to what an unbalanced stream of headlines would see; its interval is a bootstrap that resamples within each class.

| Language | negative | neutral | positive | Pool-weighted (95% CI) |
|---|---|---|---|---|
| fr | 5.0% (2.7–9.0%), 10/200 | 12.0% (8.2–17.2%), 24/200 | 13.0% (9.0–18.4%), 26/200 | 9.7% (7.4–12.1%) |
| de | 2.5% (1.1–5.7%), 5/200 | 7.5% (4.6–12.0%), 15/200 | 11.5% (7.8–16.7%), 23/200 | 6.8% (4.9–8.8%) |
| ar | 6.5% (3.8–10.8%), 13/200 | 14.0% (9.9–19.5%), 28/200 | 15.0% (10.7–20.6%), 30/200 | 11.5% (9.1–14.1%) |
| ja | 9.0% (5.8–13.8%), 18/200 | 17.0% (12.4–22.8%), 34/200 | 18.5% (13.7–24.5%), 37/200 | 14.5% (11.7–17.5%) |
| pt | 4.5% (2.4–8.3%), 9/200 | 9.5% (6.2–14.4%), 19/200 | 11.5% (7.8–16.7%), 23/200 | 8.2% (6.1–10.4%) |

In every language, negative sentences flip least (2.5–9.0%) and positive sentences most (11.5–18.5%), with neutral in between. The per-class intervals on 200 items are wide and these class differences are not formally tested, but the order is the same in all five languages. The pool-weighted rates (6.8–14.5%) sit just below the balanced ones, because the pool holds fewer positive sentences than the balanced sample.

### Which language drifts most

Comparing two languages' separate intervals is weak, because both are measured on the same 600 sentences. Each pair is instead compared with a paired bootstrap of the difference in flip rate, on the same sentences. With ten pairs, one of them would likely look like a "winner" by chance alone, so a difference counts as established only if its 99.5% Bonferroni-adjusted interval excludes zero.

| A − B | n | Δ flip rate (95% CI) | 99.5% adj. CI | Established? |
|---|---|---|---|---|
| fr − de | 600 | +2.8 pp (+0.5 pp to +5.2 pp) | −0.5 pp to +6.3 pp | no |
| fr − ar | 600 | −1.8 pp (−4.3 pp to +0.7 pp) | −5.3 pp to +1.7 pp | no |
| fr − ja | 600 | −4.8 pp (−7.8 pp to −1.8 pp) | −9.3 pp to −0.5 pp | yes |
| fr − pt | 600 | +1.5 pp (−0.8 pp to +4.0 pp) | −2.0 pp to +5.0 pp | no |
| de − ar | 600 | −4.7 pp (−7.2 pp to −2.2 pp) | −8.2 pp to −1.2 pp | yes |
| de − ja | 600 | −7.7 pp (−10.7 pp to −4.7 pp) | −12.0 pp to −3.5 pp | yes |
| de − pt | 600 | −1.3 pp (−3.7 pp to +1.0 pp) | −4.7 pp to +2.0 pp | no |
| ar − ja | 600 | −3.0 pp (−5.8 pp to −0.3 pp) | −7.0 pp to +1.0 pp | no |
| ar − pt | 600 | +3.3 pp (+1.0 pp to +5.7 pp) | +0.0 pp to +6.7 pp | no |
| ja − pt | 600 | +6.3 pp (+3.3 pp to +9.3 pp) | +2.0 pp to +10.8 pp | yes |

Four differences are established. Japanese drifts more than French (fr − ja −4.8 pp, adjusted CI −9.3 pp to −0.5 pp), German (de − ja −7.7 pp, −12.0 pp to −3.5 pp) and Portuguese (ja − pt +6.3 pp, +2.0 pp to +10.8 pp), and Arabic drifts more than German (de − ar −4.7 pp, −8.2 pp to −1.2 pp).

The sample does not establish the other six. The first three below exclude zero at 95% but not after adjustment, which is exactly the case the Bonferroni rule exists for; the last three include zero even at 95%:

- **Arabic vs Japanese:** ar − ja −3.0 pp (95% CI −5.8 pp to −0.3 pp; adjusted −7.0 pp to +1.0 pp).
- **French vs German:** fr − de +2.8 pp (95% CI +0.5 pp to +5.2 pp; adjusted −0.5 pp to +6.3 pp).
- **Arabic vs Portuguese:** ar − pt +3.3 pp (95% CI +1.0 pp to +5.7 pp; adjusted +0.0 pp to +6.7 pp).
- **French vs Arabic:** fr − ar −1.8 pp (95% CI −4.3 pp to +0.7 pp; adjusted −5.3 pp to +1.7 pp).
- **French vs Portuguese:** fr − pt +1.5 pp (95% CI −0.8 pp to +4.0 pp; adjusted −2.0 pp to +5.0 pp).
- **German vs Portuguese:** de − pt −1.3 pp (95% CI −3.7 pp to +1.0 pp; adjusted −4.7 pp to +2.0 pp).

So the sample supports Japanese above the three European languages, and Arabic above German, but no finer ranking: it does not separate Japanese from Arabic, and it does not order French, German and Portuguese.

## Limitations

- **Domain mismatch.** The model is fine-tuned on tweets; this evaluation is news sentences.
- **Translation pivot.** Every non-English headline is scored on a machine translation, so the drift study measures the pipeline's own added error, which is why it exists.
- **Round-trip direction.** The drift study translates English → X → English, which measures round-trip noise on English-origin text. Production goes X → English on *native* headlines, with local named entities and idiom. A round trip on English is likely kinder, so the 7.2–14.8% flip rates are plausibly a **lower bound** on what production's translation adds.
- **Which language drifts most.** Four of the ten language pairs are established (Japanese above French, German and Portuguese; Arabic above German). The other six are not, Japanese against Arabic among them, so the drift table supports a coarse grouping, not a strict ranking. The grouping is also measured on English-origin round trips, not on native headlines (see above).
- **Clustered sentences.** The reported intervals assume independent sentences, but NewsMTSC takes several sentences from one article and several articles from one story. See [Sensitivity to clustering](#sensitivity-to-clustering) for the same intervals with whole articles and stories resampled.
- **Class mix.** Raw accuracy reflects NewsMTSC's class mix (37/37/27), which is not production's. That is why balanced accuracy and macro-F1 are the main metrics.
- **Cross-country comparability.** Three things differ between countries and none is adjusted for. *Provider:* the 68 high-priority countries come from GNews top headlines (popularity/relevance-ranked); the rest come from NewsData's `latest` endpoint, which is recency-ranked (newest first). *Language:* English headlines are scored directly, other languages via Azure with the flip rates above. *Cadence:* high-priority countries refresh daily, the rest every `LOW_PRIORITY_DAYS` (2) days. A single country's series over time is internally consistent; a ranking across countries is not a like-for-like comparison.
- **Silver labels.** Sentence-level labels are derived from target-level annotations by the agreement filter above; they are not human sentence-level judgements.
- **Small per-country sample.** The live map averages at most five headlines per country per refresh, so a country's daily score is noisier than any figure here.
- **Sentences, not headlines.** NewsMTSC items are sentences drawn from article bodies. They are close to headline register but not identical to it.

I think the most promising next step is a news-domain sentiment model in place of the Twitter-tuned one: a domain-matched model tends to fix miscalibration between classes, and it would also shrink the translation drift by making the English scorer less sensitive to the phrasing noise a round trip introduces.

## Previous evaluation (superseded)

The first version of this evaluation used a class-balanced sample of 300 sentences from the `rw` **test** split only (100 per class), and 99 drift sentences per language.

- **Accuracy** 63.3% (95% CI 57.7–68.6%) and macro-F1 0.627 (95% CI 0.570–0.681).
- **AFINN-165** scored 56.3% accuracy and 0.566 macro-F1. The model's lead was +7.0 pp of accuracy (95% CI +0.3 to +13.7) and +0.061 macro-F1 (95% CI −0.006 to +0.128): the macro-F1 interval included zero.
- **Flip rates** were fr 8.1%, de 12.1%, ar 8.1%, ja 15.2% and pt 12.1%, and every language's interval overlapped every other's.

At that size the two most interesting questions, whether the model beats the word list on the balanced measure and which language drifts most, were left open. It is superseded by the full-pool study above. Its test sample is not the same as this study's `test` row: 300 balanced sentences there, against all 724 test sentences, in NewsMTSC's own class mix, here.

**Agreement with this study.** The new `test` row, balanced accuracy 65.3% (95% CI 61.9–68.8%) and macro-F1 0.650 (95% CI 0.614 – 0.685), overlaps the previous evaluation's 63.3% (57.7–68.6%) and 0.627 (0.570–0.681), and so does the full-pool result (67.4%, 66.4–68.3%; 0.660, 0.650 – 0.670): the two studies are consistent. On the previous evaluation's balanced sample, accuracy and balanced accuracy were the same number. The samples still differ, 300 balanced sentences there against all 724 here, so the rows are not like for like. The AFINN margin is consistent too: the previous evaluation's macro-F1 interval (−0.006 to +0.128) overlaps the new one (+0.107 to +0.132), which now excludes zero. In drift, Japanese had the highest flip rate in both studies. The previous evaluation's order of the other four was within its noise and does not carry over: German, 12.1% then, is the lowest here at 7.2%.

## Reproduction

```powershell
pnpm eval -- --task all --offline                 # recompute every statistic from the cache; spends nothing
pnpm eval -- --task all --drift-batches 1         # smoke run before gathering new measurements
pnpm eval -- --task all                           # gather new measurements (shows the plan, then asks)
pnpm eval -- --task all --yes --max-azure-chars 1000000   # the same without the prompt, with an explicit cap
```

`--offline` turns any cache miss into an error before a request is made, so a run meant to recompute statistics can never quietly become a paid one. It also records `modelRevision` and `spend` as `null`, since it contacts nothing; the committed outputs are from the live run, so they keep that provenance. See [eval/README.md](README.md) for the required environment variables, expected spend, and the caching behaviour. Raw outputs live in [eval/out/](out/).

**Intervals.** Wilson score intervals (z = 1.96) for accuracy, per-class recall and flip rates, each computed from the exact count in the committed output. Everything else is a percentile bootstrap, b = 10,000 resamples, seeded with `20261027` (mulberry32), taking the values at 0-based indices 250 and 9,750 of the sorted resamples (25 and 9,975 for the 99.5% adjusted intervals, 50 and 9,950 for the 99% ones).

- The **macro-F1 and balanced-accuracy intervals are reproducible from the committed confusion matrix alone**: it fully determines the (actual, predicted) pairs, with no cache and no network.
- The **cluster check, the sweep margins, the pairwise differences, the per-class flip rates, the mean |Δ| intervals and the pool-weighted rates** are reproducible from the committed item files (`accuracy-items.json`, `drift-items.json`) plus the seed. [`test/eval/committed-output.test.ts`](../test/eval/committed-output.test.ts) recomputes every one of them and checks them against the committed JSON.
- The **model-over-AFINN margin** also needs the sentence text, since AFINN scores the words. It is reproducible from the item files plus the public dataset, joined by `id`. The test does not check it.

In the previous evaluation, a stratified bootstrap (resampling within each class, matching that study's 100/100/100 design) was checked against the plain one with the same seed and b, and gave a macro-F1 interval of 0.5744–0.6783 against 0.5704–0.6809: within 0.004 at both ends and slightly narrower, as stratifying on a fixed design should be. The difference did not change any conclusion, so the simpler plain bootstrap was kept.
