# Accuracy - production scoring path on labelled news sentences

- Model: `https://router.huggingface.co/hf-inference/models/cardiffnlp/twitter-roberta-base-sentiment-latest`
- Dataset: NewsMTSC (rw, test split) (sentence-level labels from targets that all share one polarity), seed 20260824
- Scored items: 300
- Generated: 2026-08-24T08:19:02.958Z

**63.3% 3-class accuracy, macro-F1 0.627.**

## Per class

| Class | Precision | Recall | F1 | Support |
|---|---|---|---|---|
| negative | 0.571 | 0.850 | 0.683 | 100 |
| neutral | 0.571 | 0.440 | 0.497 | 100 |
| positive | 0.824 | 0.610 | 0.701 | 100 |

## Confusion matrix

| actual \ predicted | negative | neutral | positive |
|---|---|---|---|
| **negative** | 85 | 13 | 2 |
| **neutral** | 45 | 44 | 11 |
| **positive** | 19 | 20 | 61 |

## Neutral-band sweep

The shipped map uses ±0.10. Every other row is the same scores mapped with a different band.

| Band ±t | Accuracy | Macro-F1 |
|---|---|---|
| 0.05 | 62.0% | 0.596 |
| 0.10 *(shipped)* | 63.3% | 0.627 |
| 0.15 | 64.0% | 0.638 |
| 0.20 | 63.0% | 0.628 |
| 0.25 | 61.0% | 0.607 |
| 0.30 | 58.0% | 0.575 |
