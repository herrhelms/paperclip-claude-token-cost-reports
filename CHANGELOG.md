# Changelog

All notable changes to this plugin will be documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
