# Vendored evaluation data

Committed data files the eval reads at run time.

## `afinn-165.json` - AFINN-165 sentiment lexicon

- **Source:** [`fnielsen/afinn`](https://github.com/fnielsen/afinn), file `afinn/data/AFINN-en-165.txt`, fetched from
  `https://raw.githubusercontent.com/fnielsen/afinn/master/afinn/data/AFINN-en-165.txt` (39,467 bytes).
- **Author:** Finn Årup Nielsen. `165` is the lexicon's version number, not its size.
- **Licence:** Apache License 2.0, the licence of the `fnielsen/afinn` repository the file is distributed in. That repository states no separate licence for the data.
- **Conversion:** the tab-separated `term<TAB>score` file converted one-to-one to a flat JSON object `{ "term": score }`. All 3,382 entries are kept in the file, in the original order, with the original integer scores (−5 to +5). Nothing was added, removed or re-scored.
- **Use:** `eval/baselines.ts` loads it and drops the 30 multi-word entries at load time (the reasons are in that file), leaving 3,352 single-word terms.

### Citation:

> Finn Årup Nielsen, "A new ANEW: evaluation of a word list for sentiment analysis in microblogs", Proceedings of the ESWC2011 Workshop on 'Making Sense of Microposts'. CEUR Workshop Proceedings 718: 93-98, May 2011.
