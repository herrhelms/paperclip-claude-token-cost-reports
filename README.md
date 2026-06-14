# Claude Token Usage

Track Claude token usage per Paperclip company, accumulate a daily record, review it in a dashboard, and export a monthly CSV you can use to bill clients at a configurable token-based rate.

Designed for operators on a Claude Max 20x Pro plan who want to translate flat-rate consumption into a token-priced invoice.

## What it does

- Subscribes to `cost_event.created` and `agent.run.finished` and writes one row per event into a private `usage_events` table (idempotent on `source_event_id`).
- Runs a `*/15 * * * *` rollup job that recomputes `usage_daily` for each company.
- Exposes a `Token Usage` page per company with date-range KPIs, a daily table, and a calendar-month rollup table.
- Exposes a `Token Usage Settings` page where you configure `$/1M input` and `$/1M output` rates per model (Opus, Sonnet, Haiku) plus a global margin %.
- Exposes a scoped JSON route that streams a monthly billing CSV: `month, month_start, month_end, input_tokens, output_tokens, input_cost_usd, output_cost_usd, total_billed_usd`.

## Surface

| Slot | Label | Route |
| --- | --- | --- |
| `page` | Token Usage | `/usage` |
| `settingsPage` | Token Usage Settings | (settings) |

## Capabilities

- `events.subscribe`
- `database.namespace.migrate`
- `database.namespace.read`
- `database.namespace.write`
- `api.routes.register`
- `ui.page.register`
- `plugin.state.write`
- `jobs.schedule`

## Data model

Private SQL namespace via `ctx.db`:

- `usage_events(source_event_id PRIMARY KEY, company_id, agent_id, model, input_tokens, output_tokens, occurred_at, day TEXT)` — append-only event log.
- `usage_daily(company_id, day TEXT, model, input_tokens, output_tokens, PRIMARY KEY(company_id, day, model))` — rolled-up daily totals.
- `pricing_config(company_id PRIMARY KEY, json TEXT)` — per-company rates and margin %, JSON-encoded for v1 simplicity.

Migrations live in `migrations/001_init.sql`.

## Actions

Called by the UI via `usePluginAction` / `usePluginData`:

- `getDailyUsage({ companyId, from, to })` — daily rows for the dashboard table.
- `getMonthlySummary({ companyId, from, to })` — calendar-month rollups, with `$` columns when pricing is set.
- `getPricing({ companyId })` / `setPricing({ companyId, config })` — used by the settings page.

## API routes

Mounted under `/api/plugins/claude-token-usage/api/*`:

- `GET /export/monthly.csv?companyId=...&from=...&to=...` — streams the monthly billing CSV. Cost columns are blank when no pricing is saved for the company.

## Configuration

All configuration is set in the Settings page and persisted to `pricing_config`. No environment variables, no secrets.

| Key | Description |
| --- | --- |
| `pricing.opus.input` | $/1M input tokens (seeded from current public Anthropic API rate) |
| `pricing.opus.output` | $/1M output tokens for Opus |
| `pricing.sonnet.input` | $/1M input tokens for Sonnet |
| `pricing.sonnet.output` | $/1M output tokens for Sonnet |
| `pricing.haiku.input` | $/1M input tokens for Haiku |
| `pricing.haiku.output` | $/1M output tokens for Haiku |
| `margin.percent` | Number, default `0` |

Defaults are seeded from current public Anthropic API rates so you can sanity-check before editing.

## How billing math works

For each event with model `m`, input tokens `i`, output tokens `o`:

```
input_cost  = i / 1_000_000 * pricing[m].input
output_cost = o / 1_000_000 * pricing[m].output
billed      = (input_cost + output_cost) * (1 + margin.percent / 100)
```

The monthly CSV sums these per calendar month (YYYY-MM, UTC). If a company has no saved pricing config, cost and billed columns are emitted blank — token columns still populate so you can review usage before pricing it.

## Install target

Standalone plugin package. Built against `@paperclipai/plugin-sdk`. TypeScript throughout; React + inline CSS for the UI (no Tailwind); esbuild for the worker bundle, rollup for the UI bundle.

## Scope notes (v1)

- No per-agent breakdown in the dashboard — operator confirmed it isn't needed.
- Pricing is per-company and per-model. Margin is a single global %.
- Re-delivered events are deduplicated by `source_event_id` primary key.
