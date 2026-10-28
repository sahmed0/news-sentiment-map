# Translation round-trip drift

- Model: `https://router.huggingface.co/hf-inference/models/cardiffnlp/twitter-roberta-base-sentiment-latest`, revision `3216a57f2a0d9c45a2e6c20157c20c49fb4bf9c7` (Hub revision at run time)
- Sample: 600 items, 200 per class, seed 20261027
- Generated: 2026-10-28T00:11:06.440Z

Each item is translated English → language → English through the production
Azure + HuggingFace path, then compared with its direct English score.

| Language | n | Mean \|Δ\| (95% CI) | Median Δ | Max \|Δ\| | Label-flip rate (95% CI) | Pearson r |
|---|---|---|---|---|---|---|
| fr | 600 | 0.072 (0.064 – 0.080) | 0.001 | 1.409 | 10.0% (7.8–12.7%), 60 flips | 0.967 |
| de | 600 | 0.071 (0.064 – 0.079) | 0.000 | 1.039 | 7.2% (5.4–9.5%), 43 flips | 0.969 |
| ar | 600 | 0.092 (0.082 – 0.103) | 0.000 | 1.475 | 11.8% (9.5–14.7%), 71 flips | 0.944 |
| ja | 600 | 0.115 (0.104 – 0.126) | 0.001 | 1.005 | 14.8% (12.2–17.9%), 89 flips | 0.930 |
| pt | 600 | 0.063 (0.056 – 0.071) | 0.000 | 0.913 | 8.5% (6.5–11.0%), 51 flips | 0.973 |

## By true class

The pool-weighted rate re-weights the per-class rates to the dataset's class mix.

| Language | negative | neutral | positive | Pool-weighted (95% CI) |
|---|---|---|---|---|
| fr | 5.0% (2.7–9.0%), 10/200 | 12.0% (8.2–17.2%), 24/200 | 13.0% (9.0–18.4%), 26/200 | 9.7% (7.4–12.1%) |
| de | 2.5% (1.1–5.7%), 5/200 | 7.5% (4.6–12.0%), 15/200 | 11.5% (7.8–16.7%), 23/200 | 6.8% (4.9–8.8%) |
| ar | 6.5% (3.8–10.8%), 13/200 | 14.0% (9.9–19.5%), 28/200 | 15.0% (10.7–20.6%), 30/200 | 11.5% (9.1–14.1%) |
| ja | 9.0% (5.8–13.8%), 18/200 | 17.0% (12.4–22.8%), 34/200 | 18.5% (13.7–24.5%), 37/200 | 14.5% (11.7–17.5%) |
| pt | 4.5% (2.4–8.3%), 9/200 | 9.5% (6.2–14.4%), 19/200 | 11.5% (7.8–16.7%), 23/200 | 8.2% (6.1–10.4%) |

## Pairwise differences

Flip rate of A minus flip rate of B, on the same sentences.

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

Per-language flip-rate intervals are Wilson; the pairwise intervals are a paired bootstrap on the same items
(b = 10000, seed 20261027). A difference between two languages counts as established only
when its Bonferroni-adjusted interval excludes zero.
