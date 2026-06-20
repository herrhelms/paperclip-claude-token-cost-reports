# Changelog

All notable changes to this plugin will be documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.6] - 2026-06-20
### Added
- `recoverRawModelsFromHost` action + `sampleRawModels` data handler. The recovery action joins `usage_events` to `public.cost_events` on `'cost_event:' || ce.id::text = source_event_id` and re-sources `raw_model` from the host's preserved payload. The data handler surfaces the distinct raw_model values + their stored / would-normalize-to keys for diagnostic purposes.

### Why
- Investigating why 1.0.5's `renormalizeStaleModels` reported `updated: 0` on a host that still showed 607M unknown tokens turned up the root cause: migration `002_costs_overview.sql` (shipped in 0.3.0) ran `UPDATE usage_events SET raw_model = model WHERE raw_model IS NULL` as a backfill for legacy rows. For events ingested before the raw_model column existed, that overwrote `raw_model` with the already-normalized `model` value — so an `unknown` row literally stores `raw_model='unknown'` instead of the original `claude-opus-4-6[1m]`. Re-running the normalizer on that lossy string is a no-op. The fix: re-source `raw_model` from the host's `public.cost_events` (preserved by the host) before re-normalizing.

### Recovery sequence
```bash
# 1. Recover raw_model from the host's cost_events.
paperclipai plugin bridge:action claude-token-cost-reports \
  --payload-json '{"key":"recoverRawModelsFromHost","params":{}}' --json

# 2. Re-run normalizer + rollup against the recovered raw_models.
paperclipai plugin bridge:action claude-token-cost-reports \
  --payload-json '{"key":"renormalizeStaleModels","params":{}}' --json

# 3. Verify (per-model breakdown should now show priced rows).
paperclipai plugin bridge:data claude-token-cost-reports \
  --payload-json '{"key":"sampleRawModels","params":{}}' --json | jq
```

## [1.0.5] - 2026-06-20
### Added
- `renormalizeStaleModels` action that walks `usage_events`, re-runs `normalizeModel(raw_model)` for every row, updates `model` in-place where the result differs from the stored value, and re-rolls every affected `(company, day)`. Closes the gap exposed by 1.0.4: extending the priced table doesn't retroactively re-classify rows that were ingested under the old normalizer and stored as `model='unknown'`. Idempotent — re-running is a no-op once the data converges. Optional `companyId` parameter scopes the sweep; omitting it walks every company on the host.

### Why
- 1.0.4 added Opus 4.6 / 4.6-1m / 4.5 / Haiku 4.5 to `DEFAULT_PRICING`, but a reinstall on a host with existing April data still showed `unknown` because the stored `model` column was already stamped. This action is the migration path.

### How to use
```bash
paperclipai plugin bridge:action claude-token-cost-reports \
  --payload-json '{"key":"renormalizeStaleModels","params":{}}' --json
# scope to one company:
paperclipai plugin bridge:action claude-token-cost-reports \
  --payload-json '{"key":"renormalizeStaleModels","params":{"companyId":"<uuid>"}}' --json
```

## [1.0.4] - 2026-06-20
### Added
- 5 new rows in the priced model table to cover model identifiers the host emits but the 8-row table missed: `opus-4-6`, `opus-4-6-1m`, `opus-4-5`, `haiku-4-5`. The standout — `opus-4-6` / `opus-4-6-1m` at $5 / $25 per MTok — is why historical April periods with Claude Opus 4.6 events showed up as `unknown` model and €0.00 cost. Rates fetched from platform.claude.com/docs/en/about-claude/pricing on 2026-06-20. Per the page's "Long context pricing" section, Opus 4.6 / 4.7 / 4.8 and Sonnet 4.6 include the full 1M-context window at standard pricing, so each `-1m` row matches the standard rate.
- Settings page now renders 12 rows (was 8). Existing installs keep their custom rates for the original 8 keys; new keys are seeded from defaults on next load via the existing upgrade path.

### Note
- This is a tactical extension of the hardcoded table, NOT the operator-extensible matrix design discussed for 2.0.0. Long-term plan: drop the static enum, let operators add arbitrary `(model-key, rate)` rows in Settings, and snapshot pricing changes with `effective_from` so historical periods bill against the configuration that was active when the tokens were consumed. Tracked as a separate work item.

## [1.0.3] - 2026-06-20
### Changed
- README: Install section now documents the install / uninstall slug asymmetry. The npm package is scoped (`@herrhelms/…`) but the in-app plugin key is not, so install uses `@herrhelms/claude-token-cost-reports` while uninstall uses `claude-token-cost-reports`. The host's `paperclipai plugin list` prints the unscoped key, but a single line in the README saves operators a head-scratch on first uninstall.

## [1.0.2] - 2026-06-20
### Changed
- Settings page now surfaces a prominent caveat next to the subscription preset: the ÷5 / ÷20 divisors are pragmatic stand-ins, not Anthropic-published per-token rates. Same caveat that the README has carried since 1.0.0 — now visible where the operator actually chooses the preset.
- README: editorial rewrite. Tagline + lead paragraph no longer gatekeep the plugin behind "Claude Pro / Max subscription"; the subscription-mode toggle is presented as optional throughout. "Subscription mode" section now leads with the grain-of-salt warning instead of burying it as a footer. Quick start step 4 is explicit about the approximation. "What it does" tightened around the architectural fixes shipped in 1.0.0 (provider filter, atomic rollup, FX bounds).
- Plugin manifest description rewritten to lead with the billing-CSV outcome instead of the model list, and to mention subscription mode as optional / approximate rather than as the headline use case.

## [1.0.1] - 2026-06-20
### Fixed
- Worker bundle now includes `@paperclipai/plugin-sdk` instead of treating it as external. The 1.0.0 release relied on the SDK being in the worker's Node resolution chain, which holds in local dev but fails when paperclipai installs the plugin under `~/.paperclip/plugins/node_modules/@herrhelms/...` where the SDK is absent. Symptom: `ERR_MODULE_NOT_FOUND: Cannot find package '@paperclipai/plugin-sdk'` on first worker spawn after install from npm.
- Manifest bundle (`dist/manifest.js`) follows the same pattern for the same reason.

## [1.0.0] - 2026-06-20

First GA release on the npm registry. Fork point for the rc.1 → rc.4 line is recorded below; rc.5 was an internal staging tag that collapsed into this release after the pre-publish audit.

### Changed
- npm package name set to `@herrhelms/claude-token-cost-reports` for the first publish to the npm registry. In-app plugin key (`claude-token-cost-reports`) and DB namespace unchanged.

### Fixed
- BLOCKER: ingest + backfill now filter to `provider IN ('anthropic', 'claude')` so the plugin no longer slurps OpenAI events when installed alongside `@herrhelms/openai-token-cost-reports`.
- BLOCKER: `rollupCompanyDay` rewritten as a single `INSERT … SELECT … ON CONFLICT DO UPDATE` so concurrent cron + live ingest can't race to lose tokens.
- BLOCKER: CSV `/export/monthly.csv` rejects `from`/`to` query strings that aren't strict `YYYY-MM-DD`. Prevents header injection via crafted query string.
- BLOCKER: CSV cells are RFC 4180-escaped; values containing comma / quote / CRLF are quoted with internal quotes doubled.
- BLOCKER: FX rates from `open.er-api.com` are now bounded to `0.01..1000`. Outlier values are logged and skipped instead of persisted.
- Archive cleanup now purges the per-company pricing config from `ctx.state` (alongside the currency state it already purged).
- `isPricingConfig` rejects `margin.percent` that is NaN, negative, or above 500.
- `rollup-daily` cron now re-rolls today AND yesterday on each tick. Catches midnight-boundary late events and recovers from partial-failure live ingests.
- Per-event ingest log demoted from `info` to `debug`. Stops dumping per-event billing telemetry into the steady-state log stream.

## [1.0.0-rc.4] - 2026-06-20
### Changed
- BREAKING: npm package renamed `claude-token-cost-reports` → `@herrhelms/claude-token-cost-reports` so installs match the user's npm scope. The in-app plugin key (`id` in manifest) and DB namespace stay as `claude-token-cost-reports` / `plugin_claude_token_cost_reports_c7ca204bbe` — only the npm name changed.
- BREAKING: dashboard `routePath` renamed `tokens` → `monthly-report-claude`. Dashboard URL becomes `/$COMPANY/monthly-report-claude`. The previous `/$COMPANY/tokens` no longer resolves.
- Internal `docs/` folder is no longer tracked in git (gitignored). README.md + CHANGELOG.md remain the consumer-facing docs.

## [1.0.0-rc.3] - 2026-06-18
### Changed
- README rewritten as a consumer-focused install guide: install command up top, Quick start walkthrough for first-time Settings configuration, reordered structure (Install → Quick start → What it does → Subscription mode → Billing → Reference → Build from source).
- Fixed stale `plugin_claude_token_usage_<hash>` namespace reference in the data-model section.
- Git history rewritten with `git filter-repo` to remove a test-fixture company UUID that had leaked into commit messages. No content change at HEAD; SHAs of all prior commits change.

## [1.0.0-rc.2] - 2026-06-16
### Changed
- Worker bundle no longer ships `@paperclipai/plugin-sdk` (now marked external in esbuild). `dist/worker.js` shrinks from 426 KB to 51 KB; published tarball drops from 211 KB to 34 KB.
- `package.json` `files` array switched from directory globs to explicit `dist/**/*.js` + `dist/**/*.d.ts` so source maps stay local but aren't published (saves ~240 KB per install).
### Added
- "Naming" section in README documenting npm package name / in-app slug / DB-namespace-hash alignment, with a one-liner to regenerate the SHA-256 suffix for forks.
- `docs/PRODUCTION-INSTALL-CHECKLIST.md` — eight-section verification flow for the first production install. Closes the path to GA: when every box is green, blocker #4 (state.get scope error watch-list) can be definitively closed.

## [1.0.0-rc.1] - 2026-06-16
### Changed
- BREAKING: renamed `claude-token-usage` → `claude-token-cost-reports` (npm package, in-app slug, DB namespace). Existing installs must `paperclipai plugin uninstall claude-token-usage --force` before installing.
- Migrations made idempotent so re-installs don't fail on lingering postgres schemas.
- Migration prefix collision resolved (`002_fx_rates.sql` → `003_fx_rates.sql`).
- Package now publishable: `private: false`, `license: MIT`, SDK pinned to a version range, LICENSE file added.
- Typecheck now covers tests via `tsconfig.test.json`.
### Added
- `CHANGELOG.md`, `LICENSE`, "Subscription mode" README section.

## [0.9.2] - 2026-06-15
### Changed
- KPI grid breakpoints: 6 cols on widescreen / 3×2 on laptop / 2×3 on tablet / 1 col on phone.

## [0.9.0] - 2026-06-15
### Added
- Always-visible billing-config strip above the KPI row showing period, currency + FX, margin, and subscription preset.
- KPI labels switch to "List" + "Sub-adjusted" when a subscription preset is active.

## [0.8.0] - 2026-06-14
### Added
- Audit-grade dashboard: subscription preset surfaced in every total cell.
### Fixed
- Monthly CSV export applies the divisor at row aggregation time so the exported invoice matches the dashboard.

## [0.7.0] - 2026-06-14
### Added
- Subscription preset (Off / Pro ÷5 / Max ÷20) with deterministic billable math: `tokens × rate ÷ divisor × (1 + margin) × FX`.

## [0.6.0] - 2026-06-14
### Added
- Monthly CSV export priced in the operator's billing currency.
### Changed
- Worker rolls usage_daily up every 15 minutes; previously every hour.

## [0.5.0] - 2026-06-13
### Added
- `backfillFromCostEvents` action — reads `public.cost_events` directly via `coreReadTables` so the dashboard can show pre-install history.

## [0.4.1] - 2026-06-13
### Fixed
- Per-agent table now reads live host `/api/costs/by-agent-model` because `cost_event.created` events never fire on the host. Worker subscription is kept as a fallback.

## [0.4.0] - 2026-06-13
### Added
- Per-agent breakdown card with expandable per-model sub-rows (mirrors host /costs).

## [0.3.x] - 2026-06-13
### Changed
- `routePath: "tokens"` (single-segment slug, per host validator).
- Settings link resolves the install UUID at runtime via `GET /api/plugins`.
- Cross-link from settings back to the usage dashboard.

## [0.2.x] - 2026-06-13
### Added
- 8-row pricing table for Opus 4.8 / 4.7 and Sonnet 4.6 / 4.5 with 1M-context variants.
- Pricing defaults sourced from platform.claude.com/docs/en/about-claude/pricing.
- Settings link, CSV download via Blob fetch, costs.read capability.

## [0.1.0] - 2026-06-13
### Added
- Initial scaffold: `cost_event.created` subscription, `usage_events`/`usage_daily` tables, weekly CSV export.
