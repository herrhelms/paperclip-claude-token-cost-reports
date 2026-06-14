import React, { useMemo, useState, useEffect, useCallback } from "react";
import {
  useHostContext,
  useHostNavigation,
  usePluginData,
  usePluginAction,
  usePluginToast,
} from "@paperclipai/plugin-sdk/ui";

// Host paths for the two surfaces this plugin contributes.
//
// Settings: the host mounts plugin settings under the instance settings tree at
//   /$COMPANY_HANDLE/settings/instance/plugins/<plugin-key>
// (slug accepted; the install UUID isn't exposed to the worker or UI host context).
//
// Usage page: the `page` slot's `routePath` is mounted by the host directly
// under the company prefix as `/:companyPrefix/<routePath>` — NOT under
// `/plugins/<pluginKey>/...`. The host validator requires routePath to be a
// single lowercase slug (letters/numbers/hyphens). With routePath:"tokens"
// the canonical page URL is /$COMPANY_HANDLE/tokens. linkProps() takes a
// company-relative path (leading slash, no company prefix) and the host
// resolves the prefix at render time.
const PLUGIN_KEY = "claude-token-usage";
const USAGE_ROUTE_SLUG = "tokens";
// Host router (confirmed against the installed bundle):
//   path:"company/settings/instance/plugins/:pluginId"
// — and :pluginId is the install UUID, NOT the plugin key. The UUID isn't
// available at build time, so we resolve it at runtime via GET /api/plugins,
// then build the settings href below. While the lookup is in flight we render
// the link with a #set-pricing fallback that does nothing harmful.
const SETTINGS_FALLBACK_HREF = "#set-pricing";
const USAGE_HREF = `/${USAGE_ROUTE_SLUG}`;

type PluginInstallSummary = { id: string; pluginKey: string };
let cachedInstallId: string | null = null;
let installIdPromise: Promise<string | null> | null = null;

async function fetchInstallId(): Promise<string | null> {
  if (cachedInstallId) return cachedInstallId;
  if (installIdPromise) return installIdPromise;
  installIdPromise = (async () => {
    try {
      const res = await fetch("/api/plugins", { credentials: "include" });
      if (!res.ok) return null;
      const list = (await res.json()) as PluginInstallSummary[];
      const match = list.find((p) => p.pluginKey === PLUGIN_KEY);
      cachedInstallId = match?.id ?? null;
      return cachedInstallId;
    } catch {
      return null;
    } finally {
      installIdPromise = null;
    }
  })();
  return installIdPromise;
}

function useSettingsHref(): string {
  const [href, setHref] = useState<string>(
    cachedInstallId
      ? `/company/settings/instance/plugins/${cachedInstallId}`
      : SETTINGS_FALLBACK_HREF,
  );
  useEffect(() => {
    let cancelled = false;
    fetchInstallId().then((id) => {
      if (cancelled || !id) return;
      setHref(`/company/settings/instance/plugins/${id}`);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return href;
}

type DailyRow = {
  day: string;
  input_tokens: number;
  output_tokens: number;
  billable_usd?: number | null;
};

type MonthlyRow = {
  month: string;
  month_start: string;
  month_end: string;
  input_tokens: number;
  output_tokens: number;
  input_cost_usd?: number | null;
  output_cost_usd?: number | null;
  total_billed_usd?: number | null;
};

// Mirrors the shape returned by the worker's getIngestStats action.
// Lets the UI prove the cost_event.created pipeline is actually flowing —
// if the host hasn't granted costs.read, this is how the operator finds out.
type IngestStats = {
  asOf: string;
  totalEvents: number;
  last24hEvents: number;
  lastEventAt: string | null;
  hasCostsReadCapability: boolean;
  diagnosticHint: string | null;
};

// Mirrors the shape returned by the worker's getCostsOverview action.
// Tracks the same data the host /costs page surfaces: rolling windows over the
// last 5h / 24h / 7d, a subscription-vs-API split, and per-model breakdown.
type CostsOverview = {
  asOf: string;
  windowStart: string;
  rollingWindows: Array<{
    windowKey: "5h" | "24h" | "7d";
    tokens: number;
    costUsd: number | null;
  }>;
  subscription: {
    runs: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    subscriptionTokens: number;
    apiTokens: number;
    subscriptionShare: number;
  };
  perModel: Array<{
    rawModel: string;
    normalizedKey: ModelKey | "unknown";
    provider: string;
    source: string;
    tokens: number;
    tokenShare: number;
    costUsd: number | null;
  }>;
  perAgent: Array<{
    agentId: string;
    agentName: string;
    agentTitle: string | null;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    apiRuns: number;
    subscriptionRuns: number;
    costUsd: number | null;
    models: Array<{
      rawModel: string;
      normalizedKey: ModelKey | "unknown";
      provider: string;
      source: string;
      tokens: number;
      inputTokens: number;
      outputTokens: number;
      agentTokenShare: number;
      costUsd: number | null;
    }>;
  }>;
  priced: boolean;
  quotaNote: string;
};

// Model keys mirror the worker's PRICED_MODEL_KEYS. Keep in sync.
type ModelKey =
  | "opus-4-8"
  | "opus-4-8-1m"
  | "opus-4-7"
  | "opus-4-7-1m"
  | "sonnet-4-6"
  | "sonnet-4-6-1m"
  | "sonnet-4-5"
  | "sonnet-4-5-1m";

const PRICED_MODEL_KEYS: ReadonlyArray<ModelKey> = [
  "opus-4-8",
  "opus-4-8-1m",
  "opus-4-7",
  "opus-4-7-1m",
  "sonnet-4-6",
  "sonnet-4-6-1m",
  "sonnet-4-5",
  "sonnet-4-5-1m",
];

type PricingConfig = {
  pricing: Record<ModelKey, { input: number; output: number }>;
  margin: { percent: number };
};

// Defaults from https://platform.claude.com/docs/en/about-claude/pricing#model-pricing.
// Opus 4.8 / 4.7 / Sonnet 4.6 INCLUDE the 1M context window at standard pricing per the
// "Long context pricing" section. Sonnet 4.5 isn't listed there; default its [1m] variant
// to the base rate so the line item exists if the operator's data uses it. Override either.
const DEFAULT_PRICING: PricingConfig = {
  pricing: {
    "opus-4-8":      { input: 5, output: 25 },
    "opus-4-8-1m":   { input: 5, output: 25 },
    "opus-4-7":      { input: 5, output: 25 },
    "opus-4-7-1m":   { input: 5, output: 25 },
    "sonnet-4-6":    { input: 3, output: 15 },
    "sonnet-4-6-1m": { input: 3, output: 15 },
    "sonnet-4-5":    { input: 3, output: 15 },
    "sonnet-4-5-1m": { input: 3, output: 15 },
  },
  margin: { percent: 0 },
};

// Display labels for the settings table. Match the user's requested format: "Opus 4.8", "Opus 4.8[1m]".
const MODEL_LABELS: Record<ModelKey, string> = {
  "opus-4-8":      "Opus 4.8",
  "opus-4-8-1m":   "Opus 4.8[1m]",
  "opus-4-7":      "Opus 4.7",
  "opus-4-7-1m":   "Opus 4.7[1m]",
  "sonnet-4-6":    "Sonnet 4.6",
  "sonnet-4-6-1m": "Sonnet 4.6[1m]",
  "sonnet-4-5":    "Sonnet 4.5",
  "sonnet-4-5-1m": "Sonnet 4.5[1m]",
};

function normalizePricing(raw: unknown): PricingConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const p = r.pricing as Record<string, unknown> | undefined;
  if (!p) return null;
  const out: PricingConfig = JSON.parse(JSON.stringify(DEFAULT_PRICING));
  for (const k of PRICED_MODEL_KEYS) {
    const row = p[k] as { input?: unknown; output?: unknown } | undefined;
    if (row && typeof row.input === "number" && typeof row.output === "number") {
      out.pricing[k] = { input: row.input, output: row.output };
    }
  }
  // Legacy: pre-0.2.0 configs had flat opus/sonnet/haiku keys.
  // Carry forward into the most-recent base variant if the operator hasn't set the new key yet.
  const legacyOpus = p.opus as { input?: unknown; output?: unknown } | undefined;
  if (
    legacyOpus &&
    typeof legacyOpus.input === "number" &&
    typeof legacyOpus.output === "number" &&
    out.pricing["opus-4-7"].input === DEFAULT_PRICING.pricing["opus-4-7"].input
  ) {
    out.pricing["opus-4-7"] = { input: legacyOpus.input, output: legacyOpus.output };
  }
  const legacySonnet = p.sonnet as { input?: unknown; output?: unknown } | undefined;
  if (
    legacySonnet &&
    typeof legacySonnet.input === "number" &&
    typeof legacySonnet.output === "number" &&
    out.pricing["sonnet-4-6"].input === DEFAULT_PRICING.pricing["sonnet-4-6"].input
  ) {
    out.pricing["sonnet-4-6"] = { input: legacySonnet.input, output: legacySonnet.output };
  }
  const m = r.margin as { percent?: unknown } | undefined;
  if (m && typeof m.percent === "number") {
    out.margin.percent = m.percent;
  } else if (typeof (r as { marginPercent?: unknown }).marginPercent === "number") {
    // tolerate old flat shape if any was persisted
    out.margin.percent = (r as { marginPercent: number }).marginPercent;
  }
  return out;
}

function isoDateOffset(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function fmtInt(n: number): string {
  return n.toLocaleString();
}

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `$${n.toFixed(2)}`;
}

// Compact token formatter — matches the host /costs page's "39.6k tok" / "1.0M tok" style.
function fmtTokens(n: number): string {
  if (!isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function fmtPercent(share: number): string {
  if (!isFinite(share)) return "0%";
  return `${Math.round(share * 100)}%`;
}

function fmtRelativeTime(isoOrNull: string | null, nowMs: number): string {
  if (!isoOrNull) return "never";
  const t = Date.parse(isoOrNull);
  if (!isFinite(t)) return "never";
  const deltaSec = Math.max(0, Math.round((nowMs - t) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.round(deltaSec / 60)}m ago`;
  if (deltaSec < 24 * 3600) return `${Math.round(deltaSec / 3600)}h ago`;
  return `${Math.round(deltaSec / 86400)}d ago`;
}

const THEME_CSS = `
.tu-root {
  --tu-fg: #111;
  --tu-muted: #57606a;
  --tu-border: #d0d7de;
  --tu-border-soft: #eaecef;
  --tu-card-bg: #fafbfc;
  --tu-table-head-bg: #f6f8fa;
  --tu-input-bg: #fff;
  --tu-input-fg: #111;
  --tu-accent: #0969da;
  --tu-accent-fg: #fff;
  --tu-btn-bg: #fff;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  .tu-root {
    --tu-fg: #e6edf3;
    --tu-muted: #8b949e;
    --tu-border: #30363d;
    --tu-border-soft: #21262d;
    --tu-card-bg: #161b22;
    --tu-table-head-bg: #161b22;
    --tu-input-bg: #0d1117;
    --tu-input-fg: #e6edf3;
    --tu-accent: #2f81f7;
    --tu-accent-fg: #fff;
    --tu-btn-bg: #21262d;
  }
}
:is(.dark, [data-theme="dark"], .theme-dark) .tu-root,
.tu-root:is(.dark, [data-theme="dark"]) {
  --tu-fg: #e6edf3;
  --tu-muted: #8b949e;
  --tu-border: #30363d;
  --tu-border-soft: #21262d;
  --tu-card-bg: #161b22;
  --tu-table-head-bg: #161b22;
  --tu-input-bg: #0d1117;
  --tu-input-fg: #e6edf3;
  --tu-accent: #2f81f7;
  --tu-accent-fg: #fff;
  --tu-btn-bg: #21262d;
}
.tu-root input[type="number"],
.tu-root input[type="date"] {
  color-scheme: light dark;
}
`;

const styles = {
  page: {
    padding: "24px",
    fontFamily:
      "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    color: "var(--tu-fg)",
    maxWidth: 1100,
    margin: "0 auto",
  } as React.CSSProperties,
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
    flexWrap: "wrap" as const,
    gap: 12,
  },
  title: { fontSize: 22, fontWeight: 600, margin: 0, color: "var(--tu-fg)" },
  controls: {
    display: "flex",
    gap: 8,
    alignItems: "center",
    flexWrap: "wrap" as const,
  },
  input: {
    padding: "6px 10px",
    border: "1px solid var(--tu-border)",
    borderRadius: 6,
    fontSize: 13,
    background: "var(--tu-input-bg)",
    color: "var(--tu-input-fg)",
  } as React.CSSProperties,
  btn: {
    padding: "6px 12px",
    border: "1px solid var(--tu-border)",
    borderRadius: 6,
    background: "var(--tu-btn-bg)",
    color: "var(--tu-fg)",
    cursor: "pointer",
    fontSize: 13,
  } as React.CSSProperties,
  btnPrimary: {
    padding: "6px 12px",
    border: "1px solid var(--tu-accent)",
    borderRadius: 6,
    background: "var(--tu-accent)",
    color: "var(--tu-accent-fg)",
    cursor: "pointer",
    fontSize: 13,
  } as React.CSSProperties,
  kpiRow: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: 12,
    margin: "20px 0",
  } as React.CSSProperties,
  kpi: {
    border: "1px solid var(--tu-border)",
    borderRadius: 8,
    padding: 16,
    background: "var(--tu-card-bg)",
    color: "var(--tu-fg)",
  } as React.CSSProperties,
  kpiLabel: {
    fontSize: 12,
    color: "var(--tu-muted)",
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  kpiValue: { fontSize: 24, fontWeight: 600, marginTop: 4, color: "var(--tu-fg)" },
  sectionTitle: {
    fontSize: 16,
    fontWeight: 600,
    margin: "24px 0 8px",
    color: "var(--tu-fg)",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: 13,
    color: "var(--tu-fg)",
  },
  th: {
    textAlign: "left" as const,
    padding: "8px 10px",
    borderBottom: "2px solid var(--tu-border)",
    background: "var(--tu-table-head-bg)",
    color: "var(--tu-fg)",
    fontWeight: 600,
  },
  td: {
    padding: "8px 10px",
    borderBottom: "1px solid var(--tu-border-soft)",
    color: "var(--tu-fg)",
  },
  empty: {
    padding: 24,
    textAlign: "center" as const,
    color: "var(--tu-muted)",
    border: "1px dashed var(--tu-border)",
    borderRadius: 8,
  },
  link: { color: "var(--tu-accent)", textDecoration: "none", fontSize: 13 },
  mutedLabel: { fontSize: 12, color: "var(--tu-muted)" },

  // Costs overview card — mirrors the host /costs page card.
  costsCard: {
    border: "1px solid var(--tu-border)",
    borderRadius: 8,
    padding: 16,
    background: "var(--tu-card-bg)",
    color: "var(--tu-fg)",
    display: "flex",
    flexDirection: "column" as const,
    gap: 16,
    margin: "20px 0",
  } as React.CSSProperties,
  costsSection: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
  } as React.CSSProperties,
  costsSectionLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: "var(--tu-muted)",
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    margin: 0,
  } as React.CSSProperties,
  costsRow: {
    display: "grid",
    gridTemplateColumns: "32px 1fr auto",
    alignItems: "center",
    gap: 8,
    fontSize: 12,
  } as React.CSSProperties,
  costsRowKey: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "var(--tu-muted)",
  } as React.CSSProperties,
  costsRowTok: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "var(--tu-muted)",
  } as React.CSSProperties,
  costsRowCost: {
    fontVariantNumeric: "tabular-nums" as const,
    fontWeight: 500,
  } as React.CSSProperties,
  costsBar: {
    height: 8,
    width: "100%",
    border: "1px solid var(--tu-border)",
    overflow: "hidden" as const,
    borderRadius: 3,
    position: "relative" as const,
  } as React.CSSProperties,
  costsBarFill: {
    height: "100%",
    background: "var(--tu-accent)",
    opacity: 0.6,
    transition: "width 150ms ease",
  } as React.CSSProperties,
  costsBarFillCost: {
    position: "absolute" as const,
    inset: 0,
    background: "var(--tu-accent)",
    opacity: 0.85,
    transition: "width 150ms ease",
  } as React.CSSProperties,
  costsDivider: {
    borderTop: "1px solid var(--tu-border-soft)",
    margin: 0,
  } as React.CSSProperties,
  costsModelRow: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
  } as React.CSSProperties,
  costsModelHead: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 8,
  } as React.CSSProperties,
  costsModelName: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12,
    color: "var(--tu-fg)",
    display: "block",
  } as React.CSSProperties,
  costsModelSub: {
    fontSize: 11,
    color: "var(--tu-muted)",
    display: "block",
    marginTop: 2,
  } as React.CSSProperties,
  costsNote: {
    fontSize: 11,
    color: "var(--tu-muted)",
    margin: 0,
    fontStyle: "italic" as const,
  } as React.CSSProperties,
  costsHealthOk: {
    fontSize: 11,
    color: "var(--tu-muted)",
    display: "flex",
    alignItems: "center",
    gap: 6,
    margin: 0,
  } as React.CSSProperties,
  costsHealthWarn: {
    fontSize: 12,
    color: "#b54708",
    background: "rgba(255, 196, 0, 0.08)",
    border: "1px solid rgba(255, 196, 0, 0.3)",
    borderRadius: 6,
    padding: "8px 10px",
    margin: 0,
  } as React.CSSProperties,
  healthDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: "#16a34a",
    display: "inline-block",
  } as React.CSSProperties,
};

function ThemeStyles(): JSX.Element {
  return <style>{THEME_CSS}</style>;
}

/**
 * Costs overview card — mirrors the host /costs page card.
 *
 * Top section: rolling 5h / 24h / 7d totals with a bar showing each window's
 * share of the maximum (so the 7d bar caps the visual scale).
 * Middle section: subscription summary (runs · total · in · out) + a bar
 * indicating the subscription share of total token traffic.
 * Bottom section: per-model breakdown bars grouped by `rawModel`.
 *
 * Quota windows (Current session / Current week / Sonnet-only) are deliberately
 * absent — that data is sourced from Claude CLI local state and isn't exposed
 * via `cost_event.created`. We surface a small note explaining this gap.
 */
function CostsOverviewCard(props: {
  costs: CostsOverview | null;
  loading: boolean;
  ingest: IngestStats | null;
}): JSX.Element | null {
  const { costs, loading, ingest } = props;
  const nowMs = useMemo(() => Date.now(), []);
  if (loading && !costs) {
    return (
      <div style={styles.costsCard}>
        <div style={styles.costsSection}>
          <p style={styles.costsSectionLabel}>Costs overview</p>
          <p style={{ fontSize: 12, color: "var(--tu-muted)" }}>Loading…</p>
        </div>
      </div>
    );
  }
  if (!costs) return null;

  const windowMax = Math.max(
    1,
    ...costs.rollingWindows.map((w) => w.tokens),
  );

  const showHealthBanner = !!ingest && ingest.totalEvents === 0;
  const healthOk = !!ingest && ingest.totalEvents > 0;

  return (
    <div style={styles.costsCard}>
      {showHealthBanner && (
        <p style={styles.costsHealthWarn}>
          <strong>No cost events ingested yet.</strong>{" "}
          {ingest!.hasCostsReadCapability
            ? "The worker is subscribed to cost_event.created and the costs.read capability is granted; events may take a few minutes to flow after install, or the host may not be emitting any."
            : "The running manifest does not declare costs.read — the host gates cost_event.created delivery behind this capability. Reinstall or upgrade the plugin so the host re-evaluates capabilities."}
        </p>
      )}
      {healthOk && (
        <p style={styles.costsHealthOk}>
          <span style={styles.healthDot} />
          Live · {fmtInt(ingest!.totalEvents)} events · last{" "}
          {fmtRelativeTime(ingest!.lastEventAt, nowMs)} ·{" "}
          {fmtInt(ingest!.last24hEvents)} in 24h
        </p>
      )}

      {/* Rolling windows */}
      <div style={styles.costsSection}>
        <p style={styles.costsSectionLabel}>Rolling windows</p>
        {costs.rollingWindows.map((w) => {
          const widthPct = (w.tokens / windowMax) * 100;
          return (
            <div key={w.windowKey} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={styles.costsRow}>
                <span style={styles.costsRowKey}>{w.windowKey}</span>
                <span style={styles.costsRowTok}>{fmtTokens(w.tokens)} tok</span>
                <span style={styles.costsRowCost}>{fmtUsd(w.costUsd)}</span>
              </div>
              <div style={styles.costsBar}>
                <div style={{ ...styles.costsBarFill, width: `${widthPct}%` }} />
              </div>
            </div>
          );
        })}
      </div>

      <div style={styles.costsDivider} />

      {/* Subscription summary */}
      <div style={styles.costsSection}>
        <p style={styles.costsSectionLabel}>Subscription</p>
        <p style={{ fontSize: 12, color: "var(--tu-muted)", margin: 0 }}>
          <span style={{ fontFamily: "ui-monospace, Menlo, monospace", color: "var(--tu-fg)" }}>
            {fmtInt(costs.subscription.runs)}
          </span>{" "}
          runs ·{" "}
          <span style={{ fontFamily: "ui-monospace, Menlo, monospace", color: "var(--tu-fg)" }}>
            {fmtTokens(costs.subscription.totalTokens)}
          </span>{" "}
          total ·{" "}
          <span style={{ fontFamily: "ui-monospace, Menlo, monospace", color: "var(--tu-fg)" }}>
            {fmtTokens(costs.subscription.inputTokens)}
          </span>{" "}
          in ·{" "}
          <span style={{ fontFamily: "ui-monospace, Menlo, monospace", color: "var(--tu-fg)" }}>
            {fmtTokens(costs.subscription.outputTokens)}
          </span>{" "}
          out
        </p>
        <div style={{ ...styles.costsBar, height: 6 }}>
          <div
            style={{
              ...styles.costsBarFill,
              width: `${costs.subscription.subscriptionShare * 100}%`,
            }}
          />
        </div>
        <p style={{ fontSize: 11, color: "var(--tu-muted)", margin: 0 }}>
          {fmtPercent(costs.subscription.subscriptionShare)} of token usage via subscription
        </p>
      </div>

      <div style={styles.costsDivider} />

      {/* Per-model breakdown */}
      <div style={styles.costsSection}>
        <p style={styles.costsSectionLabel}>Per model</p>
        {costs.perModel.length === 0 ? (
          <p style={styles.costsNote}>No usage in the last 7 days.</p>
        ) : (
          costs.perModel.map((m) => {
            const tokenPct = m.tokenShare * 100;
            return (
              <div key={`${m.rawModel}|${m.source}`} style={styles.costsModelRow}>
                <div style={styles.costsModelHead}>
                  <div style={{ minWidth: 0 }}>
                    <span style={styles.costsModelName}>{m.rawModel}</span>
                    <span style={styles.costsModelSub}>
                      {m.provider.charAt(0).toUpperCase() + m.provider.slice(1)} ·{" "}
                      {m.source.charAt(0).toUpperCase() + m.source.slice(1)}
                    </span>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      flexShrink: 0,
                      fontSize: 12,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    <span style={{ color: "var(--tu-muted)" }}>{fmtTokens(m.tokens)} tok</span>
                    <span style={{ fontWeight: 500 }}>{fmtUsd(m.costUsd)}</span>
                  </div>
                </div>
                <div style={styles.costsBar}>
                  <div
                    style={{ ...styles.costsBarFill, width: `${tokenPct}%` }}
                    title={`${fmtPercent(m.tokenShare)} of provider tokens`}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>

      <div style={styles.costsDivider} />

      {/* Per-agent breakdown — mirrors host /costs "What each agent consumed". */}
      <CostsPerAgentSection rows={costs.perAgent} />

      <div style={styles.costsDivider} />

      <p style={styles.costsNote}>{costs.quotaNote}</p>
    </div>
  );
}

/**
 * Per-agent breakdown rendered as a list of expandable rows. Collapsed shows
 * the agent name, total in/out tokens, and the api/subscription run split.
 * Expanded reveals one row per (model, source) the agent used.
 */
function CostsPerAgentSection(props: {
  rows: CostsOverview["perAgent"];
}): JSX.Element {
  const { rows } = props;
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div style={styles.costsSection}>
      <p style={styles.costsSectionLabel}>What each agent consumed</p>
      {rows.length === 0 ? (
        <p style={styles.costsNote}>
          No per-agent usage in the last 7 days. (Events without an agent id are excluded.)
        </p>
      ) : (
        rows.map((a) => {
          const isOpen = openIds.has(a.agentId);
          const initials = agentInitials(a.agentName);
          return (
            <div
              key={a.agentId}
              style={{
                border: "1px solid var(--tu-border-soft)",
                borderRadius: 6,
                padding: 10,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div
                role="button"
                tabIndex={0}
                onClick={() => toggle(a.agentId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggle(a.agentId);
                  }
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    fontFamily: "ui-monospace, Menlo, monospace",
                    fontSize: 11,
                    color: "var(--tu-muted)",
                    width: 12,
                  }}
                >
                  {isOpen ? "▾" : "▸"}
                </span>
                <span
                  aria-hidden
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    background: "var(--tu-border-soft)",
                    color: "var(--tu-fg)",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                >
                  {initials}
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--tu-fg)" }}>
                    {a.agentName}
                  </div>
                  {a.agentTitle && (
                    <div style={{ fontSize: 11, color: "var(--tu-muted)" }}>{a.agentTitle}</div>
                  )}
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-end",
                    gap: 2,
                    flexShrink: 0,
                    fontSize: 12,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{fmtUsd(a.costUsd)}</span>
                  <span style={{ color: "var(--tu-muted)" }}>
                    in {fmtTokens(a.inputTokens)} · out {fmtTokens(a.outputTokens)}
                  </span>
                  <span style={{ color: "var(--tu-muted)", fontSize: 11 }}>
                    {fmtInt(a.apiRuns)} api · {fmtInt(a.subscriptionRuns)} subscription
                  </span>
                </div>
              </div>

              {isOpen && a.models.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    paddingLeft: 50,
                    borderLeft: "1px dashed var(--tu-border-soft)",
                    marginLeft: 20,
                  }}
                >
                  {a.models.map((m) => (
                    <div
                      key={`${a.agentId}|${m.rawModel}|${m.source}`}
                      style={styles.costsModelRow}
                    >
                      <div style={styles.costsModelHead}>
                        <div style={{ minWidth: 0 }}>
                          <span style={styles.costsModelName}>
                            {m.provider.charAt(0).toUpperCase() + m.provider.slice(1)}
                            {" / "}
                            {m.rawModel}
                          </span>
                          <span style={styles.costsModelSub}>
                            {m.provider.charAt(0).toUpperCase() + m.provider.slice(1)} ·{" "}
                            {m.source.charAt(0).toUpperCase() + m.source.slice(1)}
                          </span>
                        </div>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 12,
                            flexShrink: 0,
                            fontSize: 12,
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          <span style={{ color: "var(--tu-muted)" }}>
                            {fmtTokens(m.tokens)} tok
                          </span>
                          <span style={{ fontWeight: 500 }}>
                            {fmtUsd(m.costUsd)}{" "}
                            <span style={{ color: "var(--tu-muted)", fontWeight: 400 }}>
                              ({fmtPercent(m.agentTokenShare)})
                            </span>
                          </span>
                        </div>
                      </div>
                      <div style={styles.costsBar}>
                        <div
                          style={{
                            ...styles.costsBarFill,
                            width: `${m.agentTokenShare * 100}%`,
                          }}
                          title={`${fmtPercent(m.agentTokenShare)} of this agent's tokens`}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

function agentInitials(name: string): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function UsagePage(): JSX.Element {
  const host = useHostContext();
  const nav = useHostNavigation();
  const toast = usePluginToast();
  const companyId = host?.companyId ?? "";
  const settingsHref = useSettingsHref();
  const settingsLinkProps = nav.linkProps(settingsHref);
  const [downloading, setDownloading] = useState(false);
  const [from, setFrom] = useState(isoDateOffset(30));
  const [to, setTo] = useState(isoDateOffset(0));

  const daily = usePluginData<DailyRow[]>("getDailyUsage", {
    companyId,
    from,
    to,
  });
  const monthly = usePluginData<MonthlyRow[]>("getMonthlySummary", {
    companyId,
    from,
    to,
  });
  const pricing = usePluginData<PricingConfig | null>("getPricing", {
    companyId,
  });
  const costs = usePluginData<CostsOverview>("getCostsOverview", {
    companyId,
  });
  const ingest = usePluginData<IngestStats>("getIngestStats", { companyId });

  const refresh = useCallback(() => {
    daily.refresh();
    monthly.refresh();
    pricing.refresh();
    costs.refresh();
    ingest.refresh();
  }, [daily, monthly, pricing, costs, ingest]);

  const totals = useMemo(() => {
    const rows = daily.data ?? [];
    let inp = 0;
    let out = 0;
    let billable = 0;
    let hasBillable = false;
    for (const r of rows) {
      inp += r.input_tokens;
      out += r.output_tokens;
      if (typeof r.billable_usd === "number") {
        billable += r.billable_usd;
        hasBillable = true;
      }
    }
    return { inp, out, billable, hasBillable };
  }, [daily.data]);

  const hasPricing = !!pricing.data;

  // Download the CSV by fetching it and triggering an anchor with the `download`
  // attribute. This forces a real file save instead of inline rendering, which
  // is what window.open() would do when the host's API layer drops or alters
  // the worker's Content-Disposition header.
  const downloadCsv = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    const url = `/api/plugins/claude-token-usage/api/export/monthly.csv?companyId=${encodeURIComponent(
      companyId,
    )}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const filename = `usage-${companyId}-${from}-${to}-monthly.csv`;
    let blobUrl: string | null = null;
    try {
      const res = await fetch(url, {
        credentials: "include",
        headers: { Accept: "text/csv" },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const csv = await res.text();
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      a.rel = "noopener";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      toast?.({
        title: "Download failed",
        body: String(err instanceof Error ? err.message : err),
        tone: "error",
      });
    } finally {
      // Revoke after a tick so the browser has time to start the download.
      if (blobUrl) setTimeout(() => URL.revokeObjectURL(blobUrl!), 1000);
      setDownloading(false);
    }
  }, [companyId, from, to, downloading, toast]);

  if (!companyId) {
    return (
      <div className="tu-root" style={styles.page}><ThemeStyles />
        <div style={styles.empty}>
          No company context available. Open this plugin from within a
          Paperclip company.
        </div>
      </div>
    );
  }

  return (
    <div className="tu-root" style={styles.page}><ThemeStyles />
      <div style={styles.header}>
        <h1 style={styles.title}>Token Usage</h1>
        <div style={styles.controls}>
          <label style={styles.mutedLabel}>From</label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            style={styles.input}
          />
          <label style={styles.mutedLabel}>To</label>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            style={styles.input}
          />
          <button style={styles.btn} onClick={refresh}>
            Refresh
          </button>
          <button
            style={styles.btnPrimary}
            onClick={downloadCsv}
            disabled={downloading}
          >
            {downloading ? "Preparing…" : "Download monthly CSV"}
          </button>
        </div>
      </div>

      <div style={styles.kpiRow}>
        <div style={styles.kpi}>
          <div style={styles.kpiLabel}>Input tokens</div>
          <div style={styles.kpiValue}>{fmtInt(totals.inp)}</div>
        </div>
        <div style={styles.kpi}>
          <div style={styles.kpiLabel}>Output tokens</div>
          <div style={styles.kpiValue}>{fmtInt(totals.out)}</div>
        </div>
        <div style={styles.kpi}>
          <div style={styles.kpiLabel}>Billable</div>
          <div style={styles.kpiValue}>
            {hasPricing && totals.hasBillable
              ? fmtUsd(totals.billable)
              : "—"}
          </div>
          {!hasPricing && (
            <a {...settingsLinkProps} style={styles.link}>
              Set pricing →
            </a>
          )}
        </div>
      </div>

      <CostsOverviewCard
        costs={costs.data}
        loading={costs.loading}
        ingest={ingest.data}
      />

      <div style={styles.sectionTitle}>Daily</div>
      {daily.loading ? (
        <div style={styles.empty}>Loading…</div>
      ) : (daily.data ?? []).length === 0 ? (
        <div style={styles.empty}>No usage in this range.</div>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Date</th>
              <th style={styles.th}>Input tokens</th>
              <th style={styles.th}>Output tokens</th>
              {hasPricing && <th style={styles.th}>Billable</th>}
            </tr>
          </thead>
          <tbody>
            {[...(daily.data ?? [])]
              .sort((a, b) => (a.day < b.day ? 1 : -1))
              .map((r) => (
                <tr key={r.day}>
                  <td style={styles.td}>{r.day}</td>
                  <td style={styles.td}>{fmtInt(r.input_tokens)}</td>
                  <td style={styles.td}>{fmtInt(r.output_tokens)}</td>
                  {hasPricing && (
                    <td style={styles.td}>{fmtUsd(r.billable_usd)}</td>
                  )}
                </tr>
              ))}
          </tbody>
        </table>
      )}

      <div style={styles.sectionTitle}>Monthly rollup</div>
      {monthly.loading ? (
        <div style={styles.empty}>Loading…</div>
      ) : (monthly.data ?? []).length === 0 ? (
        <div style={styles.empty}>No monthly data in this range.</div>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Month</th>
              <th style={styles.th}>Days</th>
              <th style={styles.th}>Input tokens</th>
              <th style={styles.th}>Output tokens</th>
              {hasPricing && <th style={styles.th}>Billable</th>}
            </tr>
          </thead>
          <tbody>
            {(monthly.data ?? []).map((r) => (
              <tr key={r.month}>
                <td style={styles.td}>{r.month}</td>
                <td style={styles.td}>{r.month_start} → {r.month_end}</td>
                <td style={styles.td}>{fmtInt(r.input_tokens)}</td>
                <td style={styles.td}>{fmtInt(r.output_tokens)}</td>
                {hasPricing && (
                  <td style={styles.td}>{fmtUsd(r.total_billed_usd)}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function SettingsPage(): JSX.Element {
  const host = useHostContext();
  const nav = useHostNavigation();
  const companyId = host?.companyId ?? "";
  const usageLinkProps = nav.linkProps(USAGE_HREF);
  const pricing = usePluginData<PricingConfig | null>("getPricing", {
    companyId,
  });
  const setPricing = usePluginAction("setPricing");
  const toast = usePluginToast();

  const [config, setConfig] = useState<PricingConfig>(DEFAULT_PRICING);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const normalized = normalizePricing(pricing.data);
    if (normalized) setConfig(normalized);
  }, [pricing.data]);

  const updateRate = (
    model: ModelKey,
    field: "input" | "output",
    value: string,
  ) => {
    const n = Number(value);
    setConfig((c) => ({
      ...c,
      pricing: {
        ...c.pricing,
        [model]: { ...c.pricing[model], [field]: isFinite(n) ? n : 0 },
      },
    }));
  };

  const save = async () => {
    setSaving(true);
    try {
      await setPricing({ companyId, config: config as unknown as Record<string, unknown> });
      toast?.({ title: "Pricing saved", tone: "success" });
      pricing.refresh();
    } catch (err) {
      toast?.({ title: "Save failed", body: String(err), tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  if (!companyId) {
    return (
      <div className="tu-root" style={styles.page}><ThemeStyles />
        <div style={styles.empty}>No company context available.</div>
      </div>
    );
  }

  const models: { key: ModelKey; label: string }[] = PRICED_MODEL_KEYS.map(
    (key) => ({ key, label: MODEL_LABELS[key] }),
  );

  const resetToDefaults = () => {
    setConfig((c) => ({
      ...c,
      pricing: JSON.parse(JSON.stringify(DEFAULT_PRICING.pricing)),
    }));
  };

  return (
    <div className="tu-root" style={styles.page}><ThemeStyles />
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <h1 style={styles.title}>Token Usage Settings</h1>
        <a {...usageLinkProps} style={styles.link}>
          Open usage dashboard →
        </a>
      </div>
      <p style={{ color: "var(--tu-muted)", fontSize: 13, marginTop: 4 }}>
        Pricing configured here is consumed by the dashboard at{" "}
        <a {...usageLinkProps} style={styles.link}>
          /{host?.companyPrefix ?? "$COMPANY_HANDLE"}/plugins/{PLUGIN_KEY}/{USAGE_ROUTE_SLUG}
        </a>
        . Rates are in USD per 1M tokens. Defaults match the current public
        Anthropic API list prices from{" "}
        <a
          href="https://platform.claude.com/docs/en/about-claude/pricing#model-pricing"
          target="_blank"
          rel="noreferrer"
          style={styles.link}
        >
          platform.claude.com/docs/en/about-claude/pricing
        </a>
        . The <code>[1m]</code> variants track usage routed through the 1M-token
        context window — for Opus 4.8 / 4.7 and Sonnet 4.6 the 1M window is
        currently included at standard pricing; if Anthropic introduces a
        long-context surcharge, edit those rows here.
      </p>

      <table style={{ ...styles.table, marginTop: 16 }}>
        <thead>
          <tr>
            <th style={styles.th}>Model</th>
            <th style={styles.th}>Input $/1M</th>
            <th style={styles.th}>Output $/1M</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr key={m.key}>
              <td style={styles.td}>{m.label}</td>
              <td style={styles.td}>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={config.pricing[m.key].input}
                  onChange={(e) =>
                    updateRate(m.key, "input", e.target.value)
                  }
                  style={{ ...styles.input, width: 120 }}
                  aria-label={`${m.label} input price per 1M tokens`}
                />
              </td>
              <td style={styles.td}>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={config.pricing[m.key].output}
                  onChange={(e) =>
                    updateRate(m.key, "output", e.target.value)
                  }
                  style={{ ...styles.input, width: 120 }}
                  aria-label={`${m.label} output price per 1M tokens`}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 20, display: "flex", gap: 12, alignItems: "center" }}>
        <label style={{ fontSize: 13, color: "var(--tu-fg)" }}>Margin %</label>
        <input
          type="number"
          step="0.1"
          min="0"
          value={config.margin.percent}
          onChange={(e) =>
            setConfig((c) => ({
              ...c,
              margin: { percent: Number(e.target.value) || 0 },
            }))
          }
          style={{ ...styles.input, width: 120 }}
        />
      </div>

      <div style={{ marginTop: 24, display: "flex", gap: 12 }}>
        <button
          style={styles.btnPrimary}
          onClick={save}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          style={styles.btn}
          onClick={resetToDefaults}
          disabled={saving}
          title="Restore the bundled Anthropic list prices for all 8 rows"
        >
          Reset to defaults
        </button>
      </div>
    </div>
  );
}

export default UsagePage;
