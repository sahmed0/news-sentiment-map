# News Sentiment Map

A world map coloured by the sentiment of each country's latest news headlines.
Headlines come from NewsData.io, are translated (Azure) and scored (HuggingFace),
and the result is cached in Upstash Redis.

## Data refresh architecture

NewsData.io's free tier allows **30 credits / 15 min** and **200 / day** (1 credit =
1 request). To stay within that while keeping ~105 countries fresh, refresh is a
**rolling, timezone-aware tick** rather than one big sweep:

- **`api/cron/refresh.js`** is the only writer. Each tick refreshes the countries
  whose local time is ~10 pm now (which surfaces that morning's ~10 am news, given
  NewsData's ~12 h free-tier lag), plus the stalest remaining countries to use any
  spare budget and recover
  prior failures. A credit ledger in Redis makes exceeding the limit impossible.
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
