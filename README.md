# News Sentiment Map

[![CI](https://github.com/sahmed0/news-sentiment-map/actions/workflows/ci.yml/badge.svg)](https://github.com/sahmed0/news-sentiment-map/actions/workflows/ci.yml)

A world map coloured by the sentiment of each country's latest news headlines.
Headlines are translated (Azure) and scored (HuggingFace), and the result is
cached in Upstash Redis.

## Headline sources (hybrid)

The app focuses on the **most popular** headlines, which NewsData.io doesn't rank
for (it returns by recency), so headlines come from **two providers, routed by tier**:

- **GNews** (popularity-ranked top headlines) for the **high-priority** countries.
  GNews covers ~71 countries, which the high-priority tier stays within.
- **NewsData.io** (recency, but ~155-country reach) for the **low-priority**
  countries, so total coverage isn't capped at GNews's smaller country list.

`fetchCountries(subset)` routes each country by `HIGH_PRIORITY_CODES` membership and
returns the same enriched shape regardless of provider. GNews returns no per-article
language, so each high-priority country carries a primary `lang` (in NewsData's
vocabulary) used to tag its GNews headlines for the translate/score routing.
Requires a `GNEWS_API_KEY` env var alongside `NEWSDATA_API_KEY`.

## Data refresh architecture

The two providers have **independent quotas**, tracked by **separate credit
ledgers** so neither throttles the other:

- **NewsData.io** free tier: **30 credits / 15 min** and **200 / day** (1 credit = 1
  request).
- **GNews** free tier: **~100 requests / day** (no sub-window limit).

To stay within both while keeping ~155 countries fresh, refresh is a **rolling,
timezone-aware tick** rather than one big sweep:

- **`api/cron/refresh.js`** is the only writer. Each tick refreshes the countries
  whose local time is ~ 6 am now (which surfaces the previous evenings's ~ 6 pm news, given
  NewsData's ~12 h free-tier lag), plus the stalest remaining countries to use any
  spare budget and recover
  prior failures. Per-provider credit ledgers in Redis make exceeding either API's
  limit impossible.
- **Per-country storage** (`sentiment:country:<code>`, no TTL) + an aggregate
  (`sentiment:world`) rebuilt every tick. A single country's failure isolates to
  that country and self-heals next tick; the served map never goes blank.
- **`api/sentiment.js`** is read-only - it serves the aggregate or returns `503`
  while warming, so user traffic never spends NewsData credits.

See the full design in the plan notes; key files: `api/_lib/refresh-core.js`
(selection + ledger + persistence) and `api/_lib/sentiment-fetch.js`
(`fetchCountries(subset)` pipeline + the `COUNTRIES` table with `utcOffset`).

### Scheduling the tick (zero-cost)

An **Upstash QStash** hourly schedule is the sole trigger (free tier - 500 msgs/day).
Create one schedule (cron `0 * * * *`) targeting `https://<app>/api/cron/refresh`.
QStash forwards the auth header so the handler sees `Authorization: Bearer <CRON_SECRET>`.
Create it once via the QStash dashboard or:
```bash
curl -X POST https://qstash.upstash.io/v2/schedules/https://<app>/api/cron/refresh \
  -H "Authorization: Bearer $QSTASH_TOKEN" \
  -H "Upstash-Cron: 0 * * * *" \
  -H "Upstash-Forward-Authorization: Bearer $CRON_SECRET"
```
A single missed/late fire self-heals: the country stays stale and not-done, so the
next tick's backfill picks it up. The ledger + per-day done-set make extra/retried
fires harmless. If QStash is fully down, the map keeps serving last-good data
(per-country keys have no TTL) until it recovers.

### Local development

Set `NEWSDATA_MAX_COUNTRIES=3` (or similar) before `vercel dev` so a manual
`POST /api/cron/refresh` only fetches a tiny subset. Page loads hit the read-only
`/api/sentiment` and return `503` until the cache is warmed, so dev never burns quota.

---

## React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
