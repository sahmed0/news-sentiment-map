# Translation round-trip drift

- Model: `https://router.huggingface.co/hf-inference/models/cardiffnlp/twitter-roberta-base-sentiment-latest`
- Items per language: 99
- Generated: 2026-08-24T08:24:12.213Z

Each item is translated English → language → English through the production
Azure + HuggingFace path, then compared with its direct English score.

| Language | n | Mean \|Δ\| | Median Δ | Max \|Δ\| | Label-flip rate | Pearson r |
|---|---|---|---|---|---|---|
| fr | 99 | 0.069 | -0.004 | 0.469 | 8.1% | 0.970 |
| de | 99 | 0.083 | -0.001 | 0.463 | 12.1% | 0.958 |
| ar | 99 | 0.078 | 0.003 | 0.441 | 8.1% | 0.965 |
| ja | 99 | 0.112 | -0.005 | 0.607 | 15.2% | 0.933 |
| pt | 99 | 0.071 | 0.003 | 0.441 | 12.1% | 0.969 |
