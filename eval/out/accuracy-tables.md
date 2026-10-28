# Accuracy - production scoring path on labelled news sentences

- Model: `https://router.huggingface.co/hf-inference/models/cardiffnlp/twitter-roberta-base-sentiment-latest`, revision `3216a57f2a0d9c45a2e6c20157c20c49fb4bf9c7` (Hub revision at run time)
- Dataset: NewsMTSC (rw: test + dev + train) (sentence-level labels from targets that all share one polarity; cross-split duplicates folded together; items over 2000 characters dropped): 8367 items from 803 test / 343 dev / 8739 train rows
- Cross-split duplicates: 4 sentences, 3 kept once, 1 dropped (contradicting labels)
- Too long for the model: 1 item over 2000 characters dropped
- Sample: full pool
- Scored items: 8367
- Generated: 2026-10-27T23:37:56.659Z

**Balanced accuracy 67.4% (95% CI 66.4–68.3%), macro-F1 0.660 (95% CI 0.650 – 0.670).**

Raw accuracy 66.8% (95% CI 65.8–67.8%) reflects NewsMTSC's class mix (neg 36.5% / neu 36.6% / pos 26.9%).

Accuracy and recall intervals are Wilson; the balanced-accuracy and macro-F1 intervals are a percentile bootstrap (b = 10000, seed 20261027).

## Per class

| Class | Precision | Recall (95% CI) | F1 | Support |
|---|---|---|---|---|
| negative | 0.648 | 0.861 (0.848 – 0.872) | 0.740 | 3055 |
| neutral | 0.660 | 0.429 (0.412 – 0.447) | 0.520 | 3064 |
| positive | 0.709 | 0.732 (0.713 – 0.750) | 0.720 | 2248 |

## Confusion matrix

| actual \ predicted | negative | neutral | positive |
|---|---|---|---|
| **negative** | 2629 | 317 | 109 |
| **neutral** | 1183 | 1316 | 565 |
| **positive** | 242 | 361 | 1645 |

## By split

| Split | n | Accuracy (95% CI) | Balanced accuracy (95% CI) | Macro-F1 (95% CI) |
|---|---|---|---|---|
| test | 724 | 65.2% (61.7–68.6%) | 65.3% (61.9–68.8%) | 0.650 (0.614 – 0.685) |
| dev | 312 | 64.4% (59.0–69.5%) | 63.8% (58.5–69.1%) | 0.626 (0.567 – 0.679) |
| train | 7331 | 67.1% (66.0–68.1%) | 67.6% (66.6–68.6%) | 0.661 (0.651 – 0.672) |

## Sensitivity to clustering

The same 95% intervals, resampling whole articles or stories instead of sentences.

| Resampling unit | Units | Accuracy | Balanced accuracy | Macro-F1 |
|---|---|---|---|---|
| sentence (reported) | 8367 | 65.8–67.8% | 66.4–68.3% | 0.650 – 0.670 |
| article | 5802 | 65.8–67.8% | 66.4–68.3% | 0.650 – 0.670 |
| story | 4930 | 65.8–67.8% | 66.4–68.3% | 0.650 – 0.670 |

Articles and stories are inferred from the structure of NewsMTSC ids, which the dataset does not document.

## Baselines

Scored on the same items as the model, bucketed at the same ±0.10 band.

| Classifier | Accuracy (95% CI) | Balanced accuracy (95% CI) | Macro-F1 (95% CI) |
|---|---|---|---|
| Majority class (always neutral) | 36.6% | 33.3% | 0.179 |
| AFINN-165 lexicon | 53.8% (52.7–54.8%) | 54.4% (53.3–55.5%) | 0.540 (0.529 – 0.551) |
| **Model** | 66.8% (65.8–67.8%) | 67.4% (66.4–68.3%) | 0.660 (0.650 – 0.670) |

Model over AFINN, paired bootstrap on the same items: accuracy +13.0 pp (95% CI +11.8 pp to +14.3 pp), balanced accuracy +13.0 pp (95% CI +11.8 pp to +14.3 pp), macro-F1 +0.120 (95% CI +0.107 to +0.132).

## Neutral-band sweep

The shipped map uses ±0.10. Every other row is the same scores mapped with a different band, compared with ±0.10 by a paired bootstrap. A band is established as different only when its Bonferroni-adjusted interval (α = 0.01) excludes zero.

| Band ±t | Accuracy | Balanced acc. | Macro-F1 | Δ macro-F1 vs ±0.10 (95% CI) | 99% adj. CI | Δ balanced acc. vs ±0.10 (95% CI) | 99% adj. CI | Established? |
|---|---|---|---|---|---|---|---|---|
| 0.05 | 64.0% | 65.4% | 0.610 | −0.051 (−0.058 to −0.043) | −0.060 to −0.041 | −2.0 pp (−2.6 pp to −1.4 pp) | −2.8 pp to −1.2 pp | both |
| 0.10 *(shipped)* | 66.8% | 67.4% | 0.660 | - | - | - | - | - |
| 0.15 | 67.7% | 67.7% | 0.675 | +0.015 (+0.009 to +0.020) | +0.007 to +0.022 | +0.3 pp (−0.2 pp to +0.8 pp) | −0.4 pp to +1.0 pp | macro-F1 |
| 0.20 | 67.4% | 67.0% | 0.674 | +0.014 (+0.007 to +0.021) | +0.004 to +0.024 | −0.4 pp (−1.1 pp to +0.3 pp) | −1.3 pp to +0.5 pp | macro-F1 |
| 0.25 | 67.0% | 66.2% | 0.670 | +0.010 (+0.001 to +0.018) | −0.002 to +0.021 | −1.2 pp (−2.0 pp to −0.4 pp) | −2.3 pp to −0.2 pp | balanced acc. |
| 0.30 | 66.1% | 65.0% | 0.661 | +0.001 (−0.009 to +0.010) | −0.012 to +0.013 | −2.4 pp (−3.3 pp to −1.5 pp) | −3.5 pp to −1.3 pp | balanced acc. |
