# Claude Token Cost Reports

> A Paperclip plugin that turns Claude API consumption into a token-priced client invoice.

Tracks Claude token usage per Paperclip company, attributes it to agents and models, and exports a client-facing monthly invoice CSV in the currency you bill in. Daily FX snapshots, a configurable margin per company, and a subscription-mode toggle for operators billing through a flat-rate Anthropic plan.

---

## Install

```bash
# From inside a Paperclip-enabled environment with the CLI installed:
paperclipai plugin install @herrhelms/claude-token-cost-reports

# Verify the install
paperclipai plugin list
# expect: key=claude-token-cost-reports  status=ready  version=2.0.4  id=<uuid>
```

The host runs the plugin's database migrations automatically and registers the dashboard + settings page slots. No additional configuration is required to install — pricing and currency are set per-company in the Settings page after install.

> The npm package is scoped (`@herrhelms/…`) but the in-app plugin key is not — that's a Paperclip-host convention. To uninstall, use the unscoped key:
>
> ```bash
> paperclipai plugin uninstall claude-token-cost-reports
> ```
>
> `paperclipai plugin list` prints the unscoped key next to each install, so you can always discover it from the host.

### Requirements

- Paperclip host with `@paperclipai/plugin-sdk` >= `2026.609.0` available.
- Node.js 22+ on the host that runs the plugin worker.
- Outbound HTTP access from the host to `https://open.er-api.com` (used by the hourly FX-rate job).
- The plugin must be granted the capabilities listed in [Capabilities](#capabilities). The Paperclip host prompts the operator on install.

### Where it shows up after install

| Surface | Where to find it | What's there |
| --- | --- | --- |
| Dashboard | `/$COMPANY_HANDLE/monthly-report-claude` (in the company sidebar) | Usage KPIs, per-model bars, per-agent table, daily chart, monthly CSV export |
| Settings | `/$COMPANY_HANDLE/company/settings/instance/plugins/<install-uuid>` | Free-form pricing matrix (Add / Edit / Delete rows), margin, billing currency, FX-rate status, snapshot history timeline, optional subscription multiplier |

The `<install-uuid>` is printed by `paperclipai plugin list` after install.

---

## Quick start

After install, open the Settings page for any company:

1. **Pick a billing currency** (10 supported). The hourly FX job fetches today's USD→target rate and stores one row per `(day, currency)`.
2. **Set a margin %** — what you add on top of cost when invoicing the client.
3. **(Optional) Adjust per-model rates or add new model rows.** Defaults are seeded from Anthropic's list prices for Opus 4.6 / 4.7 / 4.8, Sonnet 4.5 / 4.6, and Haiku 4.5 (including 1M-context variants). For any model id you see the host emit that's missing from the table, click "Add rate" — type the exact model string and set input/output rates. The dashboard's "no rate set" chip surfaces these in real time.
4. **(Optional) Pick a subscription preset.** Most operators leave this at **Off** and bill against the raw API list price. If you're running off a Pro or Max subscription, read the [Subscription mode](#subscription-mode) section before turning it on — the divisors are approximations, not Anthropic rates.
5. **Backfill historical events.** Use `Backfill from history` for the current period or `Backfill all history` to seed from the company's first event. The plugin reads `public.cost_events` directly via the `coreReadTables` whitelist, so pre-install usage is available immediately.

Then open `/$COMPANY_HANDLE/monthly-report-claude` — the dashboard reflects the configuration within a second.

---

## What it does

- Subscribes to `cost_event.created` and writes one row per event into a private `usage_events` table, keyed by `cost_event:<id>` so live ingestion and the backfill action share a keyspace and dedupe idempotently. Filters to `provider IN ('anthropic', 'claude')` so it cohabits cleanly with sibling plugins for other providers.
- Rolls up `usage_daily` every 15 minutes per company. The rollup is a single UPSERT, so concurrent live + cron writes can't race to lose tokens.
- Fetches a daily USD→target FX rate from `open.er-api.com`, bounded to a sanity envelope; outliers are logged and skipped rather than persisted to the invoice trail.
- Cleans up when a company is archived: purges usage tables, currency state, and pricing state.

### Dashboard at `/$COMPANY/monthly-report-claude`

- 6 KPI cards: total tokens, input, output, list (pre-margin), net (subscription-adjusted), price (chargeback). The List + Net labels surface only when a subscription preset is active.
- Per-model horizontal bar chart, native-currency cost and price.
- Per-agent table with totals + per-model breakdown (Runs / Input / Output / Cost / Price).
- Daily volume column chart — input + output stacked, peak label.
- Status chips for ingest health and FX staleness next to the page title.

### Settings at `/$COMPANY/company/settings/instance/plugins/<install-uuid>`

- Per-model rates (USD per 1M input / output) for Opus 4.8 / 4.7 and Sonnet 4.6 / 4.5, plus the 1M-context variants.
- Margin %.
- Billing currency (10 currencies), with **Refresh FX now** and a status line showing the active rate.
- Optional subscription preset, with a visible caveat about what the divisors actually mean — see [Subscription mode](#subscription-mode).

The dashboard inherits the host's Paperclip theme (light/dark, shadcn-style cards) by referencing host CSS variables directly.

---

## Billing math

For each event with model `m`, input tokens `i`, output tokens `o`:

```text
list_cost     = (i × pricing[m].input + o × pricing[m].output) / 1_000_000     # USD
client_price  = list_cost × (1 + margin.percent / 100)                          # USD
row.price     = client_price × fx_rate(month_end_day, currency)                 # Native currency
```

When subscription mode is active, `list_cost` is divided by the preset's divisor (5 for Pro, 20 for Max) before margin is applied. See the next section for the reasoning and a hard caveat.

KPI **Cost** on the dashboard is `list_cost` in the billing currency (what an API user would pay at list price). KPI **Price** is `row.price` (what the client owes after margin and currency conversion). The per-model and per-agent cards show both side by side, so reconciliation is explicit.

The monthly CSV emits only `row.price` — operator-internal numbers (list cost, divisor, margin %) stay off the file you send to the client.

---

## Subscription mode

> ⚠️ **The multiplier is an approximation, not an Anthropic rate.**
>
> Anthropic does not publish a per-token cost for Pro or Max subscriptions. What a subscription user effectively pays per token varies with monthly usage and is not a straight discount on the API list price. The multiplier here is a pragmatic stand-in so that an operator on a flat-rate plan can fold a subscription account into the same billing pipeline the rest of the system runs on — list price → multiplier → margin → currency → invoice. It is NOT a recovered Anthropic price formula.

Use this mode if you need a defensible chargeback number for a client and you don't want to invent one. If your contract or workload diverges materially from `list × multiplier`, override the per-model rates in Settings and leave the multiplier at **1.0** — that path stays honest by construction.

The plugin has one knob: `effective_input_rate_multiplier`, default `1.0`
(no adjustment). Operators on a flat-rate subscription set it to whatever
matches their effective per-token cost:

| Plan | Multiplier | Why |
| --- | --- | --- |
| Off (default) | 1.0 | Client pays full API list price |
| Claude Pro | 0.2 | ÷5 of list — matches the 1.x Pro preset |
| Claude Max | 0.05 | ÷20 of list — matches the 1.x Max preset |
| Custom | any value in (0, 1] | Operator-specific contract |

The multiplier applies to the input rate only. Output stays at list.
Switching multipliers creates a new snapshot, so historical periods are
unaffected.

---

## Monthly CSV export

```text
GET /api/plugins/claude-token-cost-reports/api/export/monthly.csv?companyId=...&from=YYYY-MM-DD&to=YYYY-MM-DD
```

Columns: `period, month_start, month_end, model, input_tokens, output_tokens, total_tokens, currency, price`. Cells are RFC 4180-escaped; `from` / `to` are validated as strict `YYYY-MM-DD`.

Multi-month exports include a `model = TOTAL` row at the end of each month section. Filename: `usage-<company-slug>-<from>-<to>-<currency>.csv`.

---

## Capabilities

The Paperclip host gates each of these on install. All are required for the plugin to function correctly.

| Capability | Why it's declared |
| --- | --- |
| `events.subscribe` | Receive `cost_event.created`, `agent.run.finished`, `company.updated` |
| `costs.read` | Gates delivery of `cost_event.created` |
| `agents.read` | Resolve agent display names for the per-agent breakdown |
| `companies.read` | Resolve company name for the CSV filename slug |
| `database.namespace.migrate` / `.read` / `.write` | Private SQL namespace |
| `plugin.state.read` / `.write` | Per-company pricing + currency config in `ctx.state` |
| `jobs.schedule` | `rollup-daily` (15 min) and `fetch-fx-daily` (hourly) |
| `api.routes.register` | Scoped CSV export route |
| `ui.page.register` | Dashboard page slot |
| `instance.settings.register` | Settings page slot |
| `http.outbound` | Daily FX fetch from `open.er-api.com` |

---

## Reference

### Data model

Private SQL namespace via `ctx.db` (`plugin_claude_token_cost_reports_c7ca204bbe`):

- `usage_events(source_event_id PRIMARY KEY, company_id, agent_id, model, raw_model, provider, source, input_tokens, output_tokens, cached_input_tokens, cost_cents, occurred_at, day TEXT)` — append-only event log. `raw_model` preserves the literal model id (`claude-opus-4-7[1m]`) while `model` holds the normalized key; `provider` and `source` (`api` / `subscription`) drive the cost split.
- `usage_daily(company_id, day TEXT, model, input_tokens, output_tokens, PRIMARY KEY(company_id, day, model))` — rolled-up daily totals.
- `pricing_config(company_id PRIMARY KEY, json TEXT)` — kept for historical compatibility; live pricing lives in `ctx.state`.
- `fx_rates(day, currency, rate, source, fetched_at, PRIMARY KEY(day, currency))` — daily USD-base FX snapshots.

Migrations: `migrations/001_init.sql`, `migrations/002_costs_overview.sql`, `migrations/003_fx_rates.sql`.

Core-read tables (declared in manifest): `cost_events` — used by the backfill action to import history from before the plugin install. Filtered to `provider IN ('anthropic', 'claude')`.

### Plugin state keys

- Company-scoped: `pricing-config` (rates + margin + subscription), `currency-config` (selected billing currency).
- Instance-scoped: `active-currencies` (string[] — drives which currencies the daily fetcher requests).

### Data handlers (registered on `ctx.data`, called from UI via `usePluginData`)

- `getDailyUsage({ companyId, from, to })` — daily rows with cost/price in USD and native currency. Drives the dashboard daily chart + KPIs.
- `getMonthlySummary({ companyId, from, to })` — calendar-month rollups (legacy aggregate, kept for the API surface).
- `getPerModelForRange({ companyId, from, to })` — per-model breakdown with cost → price in native currency.
- `getPerAgentBreakdown({ companyId, from, to })` — per-agent + per-model with runs, tokens, cost, price.
- `getPricing({ companyId })` — bare PricingConfig.
- `getCurrencyConfig({ companyId })` — `{ currency, supported }`.
- `getFxStatus({ companyId })` — current rate, day, source for the company's currency.
- `getIngestStats({ companyId })` — total + 24h ingest counts for the dashboard health chip.

### Actions (registered on `ctx.actions`, called from UI via `usePluginAction`)

- `setPricing({ companyId, config })`
- `setCurrencyConfig({ companyId, currency })` (best-effort prefetches FX)
- `refreshFxNow({ companyId })`
- `backfillFromCostEvents({ companyId, from, to })`
- `backfillAllHistory({ companyId })`

### API routes

Mounted under `/api/plugins/claude-token-cost-reports/api/*`:

- `GET /export/monthly.csv?companyId=...&from=...&to=...` — streams the client-facing monthly CSV. `auth: board`.

---

## Naming and forking

Three names refer to the same thing; keep them aligned across npm, the host, and the database:

| Surface | Value | Where it's set |
| --- | --- | --- |
| npm package name | `@herrhelms/claude-token-cost-reports` | `package.json` `name` |
| In-app plugin key | `claude-token-cost-reports` | `src/manifest.ts` `id` |
| Private DB namespace | `plugin_claude_token_cost_reports_c7ca204bbe` | derived by the host as `plugin_<slug-with-underscores>_<sha256(slug)[0:10]>` |

The `c7ca204bbe` suffix is the first 10 hex characters of `sha256("claude-token-cost-reports")`. **Forks that rename the plugin must regenerate this suffix in every migration file** — the host computes the namespace from the slug at install time, and a stale suffix in the SQL makes every migration fail with "schema X does not exist". A one-liner to recompute:

```bash
node -e "console.log(require('crypto').createHash('sha256').update('your-new-slug').digest('hex').slice(0,10))"
```

Then `sed -i '' 's/plugin_claude_token_cost_reports_c7ca204bbe/plugin_<new_slug>_<new_hash>/g' migrations/*.sql`. Tests do not catch this — the SQL runs at host install time, not at plugin build time.

---

## Build from source

For developers and forks. Standalone plugin package; built against `@paperclipai/plugin-sdk`. TypeScript throughout; React + inline CSS for the UI (no Tailwind); esbuild for both the worker and the UI bundle.

```bash
pnpm install
pnpm typecheck       # base + tests/ (chained via tsconfig.test.json)
pnpm test            # 53 unit tests on pure math, validators, and manifest
pnpm build           # emits dist/manifest.js, dist/worker.js, dist/ui/index.js
```

Install the locally built copy into the Paperclip host on this machine:

```bash
paperclipai plugin install -l .
paperclipai plugin list
```

For a clean reinstall during development:

```bash
paperclipai plugin uninstall claude-token-cost-reports --force
paperclipai plugin install -l .
```

---

## License

MIT — see [`LICENSE`](LICENSE).

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md). The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
