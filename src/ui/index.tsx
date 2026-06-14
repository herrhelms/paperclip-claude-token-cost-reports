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

// Host theme integration: the Paperclip app defines shadcn-style CSS variables
// on :root (--background, --foreground, --card, --border, --muted,
// --muted-foreground, --primary, --primary-foreground, --accent, --destructive,
// --ring). The plugin UI runs same-origin so we reference them directly and
// inherit the host's light/dark theme automatically. No more custom palette,
// no media queries, no class-based dark-mode overrides.
// The host stores tokens as direct oklch() values (confirmed by inspecting
// /assets/index-*.css), so we reference them as var(--token), not
// hsl(var(--token)). The dark theme is toggled by a parent class on the host
// root; the cascade flows into our subtree automatically.
const THEME_CSS = `
.tu-root {
  color: var(--foreground);
  color-scheme: light dark;
}
.tu-root input[type="number"],
.tu-root input[type="date"] {
  color-scheme: light dark;
}
`;

// Style tokens mapped to host CSS variables so the page tracks Paperclip's
// theme. Card shape (border radius, padding, border weight) mirrors the host's
// shadcn-style cards seen elsewhere in the app.
const styles = {
  page: {
    padding: "24px",
    fontFamily:
      "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    color: "var(--foreground)",
    maxWidth: 1200,
    margin: "0 auto",
    display: "flex",
    flexDirection: "column" as const,
    gap: 20,
  } as React.CSSProperties,
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap" as const,
    gap: 12,
  } as React.CSSProperties,
  headerLeft: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
  } as React.CSSProperties,
  title: {
    fontSize: 22,
    fontWeight: 600,
    margin: 0,
    color: "var(--foreground)",
    letterSpacing: -0.2,
  } as React.CSSProperties,
  subtitle: {
    fontSize: 13,
    color: "var(--muted-foreground)",
    margin: 0,
  } as React.CSSProperties,
  controls: {
    display: "flex",
    gap: 8,
    alignItems: "center",
    flexWrap: "wrap" as const,
  } as React.CSSProperties,
  input: {
    padding: "6px 10px",
    border: "1px solid var(--border)",
    borderRadius: 8,
    fontSize: 13,
    background: "var(--background)",
    color: "var(--foreground)",
  } as React.CSSProperties,
  btn: {
    padding: "6px 12px",
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--background)",
    color: "var(--foreground)",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
  } as React.CSSProperties,
  btnPrimary: {
    padding: "6px 14px",
    border: "1px solid var(--primary)",
    borderRadius: 8,
    background: "var(--primary)",
    color: "var(--primary-foreground)",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
  } as React.CSSProperties,
  btnGhost: {
    padding: "6px 10px",
    border: "1px solid transparent",
    borderRadius: 8,
    background: "transparent",
    color: "var(--foreground)",
    cursor: "pointer",
    fontSize: 13,
  } as React.CSSProperties,
  btnIcon: {
    width: 32,
    height: 32,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--background)",
    color: "var(--foreground)",
    cursor: "pointer",
    padding: 0,
    fontSize: 14,
    lineHeight: 1,
  } as React.CSSProperties,

  // Card shells
  card: {
    border: "1px solid var(--border)",
    borderRadius: 12,
    background: "var(--card)",
    color: "var(--foreground)",
    padding: 20,
  } as React.CSSProperties,
  cardHeader: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: 16,
    gap: 12,
    flexWrap: "wrap" as const,
  } as React.CSSProperties,
  sectionTitle: {
    fontSize: 14,
    fontWeight: 600,
    margin: 0,
    color: "var(--foreground)",
  } as React.CSSProperties,

  // KPI grid
  kpiRow: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: 12,
  } as React.CSSProperties,
  kpi: {
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: 16,
    background: "var(--card)",
    color: "var(--foreground)",
  } as React.CSSProperties,
  kpiLabel: {
    fontSize: 11,
    color: "var(--muted-foreground)",
    textTransform: "uppercase" as const,
    letterSpacing: 0.6,
    fontWeight: 600,
  } as React.CSSProperties,
  kpiValue: {
    fontSize: 26,
    fontWeight: 700,
    marginTop: 6,
    color: "var(--foreground)",
    fontVariantNumeric: "tabular-nums" as const,
    letterSpacing: -0.5,
  } as React.CSSProperties,
  kpiSub: {
    fontSize: 12,
    color: "var(--muted-foreground)",
    marginTop: 4,
  } as React.CSSProperties,

  // Per-model rows
  modelRow: {
    display: "grid",
    gridTemplateColumns: "minmax(120px, 160px) 1fr minmax(120px, auto)",
    gap: 12,
    alignItems: "center",
    paddingBlock: 6,
  } as React.CSSProperties,
  modelLabel: {
    fontSize: 13,
    fontWeight: 500,
    color: "var(--foreground)",
  } as React.CSSProperties,
  modelNums: {
    fontSize: 12,
    color: "var(--muted-foreground)",
    fontVariantNumeric: "tabular-nums" as const,
    textAlign: "right" as const,
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  chartTrack: {
    height: 10,
    width: "100%",
    background: "var(--muted)",
    borderRadius: 999,
    overflow: "hidden" as const,
    display: "flex",
  } as React.CSSProperties,
  chartFillInput: {
    height: "100%",
    background: "var(--primary)",
  } as React.CSSProperties,
  chartFillOutput: {
    height: "100%",
    background: "var(--primary)",
    opacity: 0.45,
  } as React.CSSProperties,

  // Skeleton blocks for loading state
  skeleton: {
    background: "var(--muted)",
    borderRadius: 6,
    height: 14,
    width: "100%",
    opacity: 0.6,
  } as React.CSSProperties,

  // Table (used by SettingsPage)
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: 13,
    color: "var(--foreground)",
  } as React.CSSProperties,
  th: {
    textAlign: "left" as const,
    padding: "8px 10px",
    borderBottom: "1px solid var(--border)",
    color: "var(--muted-foreground)",
    fontWeight: 600,
    fontSize: 12,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  } as React.CSSProperties,
  td: {
    padding: "10px",
    borderBottom: "1px solid var(--border)",
    color: "var(--foreground)",
  } as React.CSSProperties,

  empty: {
    padding: 24,
    textAlign: "center" as const,
    color: "var(--muted-foreground)",
    border: "1px dashed var(--border)",
    borderRadius: 12,
    background: "var(--card)",
  } as React.CSSProperties,
  link: {
    color: "var(--primary)",
    textDecoration: "underline",
    textUnderlineOffset: 3,
    fontSize: 13,
  } as React.CSSProperties,
  mutedLabel: {
    fontSize: 12,
    color: "var(--muted-foreground)",
  } as React.CSSProperties,
};

function ThemeStyles(): JSX.Element {
  return <style>{THEME_CSS}</style>;
}


// ---- Page-level helpers (month anchor, range math) ----

type MonthAnchor = { year: number; month: number };

function todayMonth(): MonthAnchor {
  const d = new Date();
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
}

function monthLabel(a: MonthAnchor): string {
  return new Date(Date.UTC(a.year, a.month, 1)).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function monthBounds(a: MonthAnchor): { from: string; to: string } {
  const start = new Date(Date.UTC(a.year, a.month, 1));
  const end = new Date(Date.UTC(a.year, a.month + 1, 0));
  return {
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
  };
}

function prevMonth(a: MonthAnchor): MonthAnchor {
  const d = new Date(Date.UTC(a.year, a.month - 1, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
}

function nextMonth(a: MonthAnchor): MonthAnchor {
  const d = new Date(Date.UTC(a.year, a.month + 1, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
}

function isFutureMonth(a: MonthAnchor): boolean {
  const cur = todayMonth();
  return a.year > cur.year || (a.year === cur.year && a.month > cur.month);
}

// Per-model shape returned by the worker's getPerModelForRange handler.
type PerModelRow = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  billable_usd: number | null;
};
type PerModelResponse = { priced: boolean; rows: PerModelRow[] };

// Daily shape returned by getDailyUsage. The worker wraps rows in { priced, rows },
// not a bare array — the previous UI read the wrapper as the array and silently
// produced zeros. This page reads .rows.
type DailyResponse = { priced: boolean; rows: DailyRow[] };

// Mirrors HostNavigationLinkProps loosely — the SDK marks href as optional.
type SettingsLinkProps = {
  href?: string;
  onClick: (event: React.MouseEvent<HTMLAnchorElement>) => void;
};

// ---- Sub-components ----

function KpiCard(props: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  loading?: boolean;
}) {
  return (
    <div style={styles.kpi}>
      <div style={styles.kpiLabel}>{props.label}</div>
      <div style={styles.kpiValue}>
        {props.loading ? (
          <div style={{ ...styles.skeleton, height: 24, width: "60%" }} />
        ) : (
          props.value
        )}
      </div>
      {props.sub ? <div style={styles.kpiSub}>{props.sub}</div> : null}
    </div>
  );
}

function PerModelCard(props: {
  loading: boolean;
  rows: PerModelRow[] | null;
  priced: boolean;
  settingsLinkProps: SettingsLinkProps;
}) {
  if (props.loading) {
    return (
      <section style={styles.card}>
        <div style={styles.cardHeader}>
          <h2 style={styles.sectionTitle}>By model</h2>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ ...styles.skeleton, height: 22 }} />
          ))}
        </div>
      </section>
    );
  }
  const rows = props.rows ?? [];
  if (rows.length === 0) {
    return (
      <section style={styles.card}>
        <div style={styles.cardHeader}>
          <h2 style={styles.sectionTitle}>By model</h2>
        </div>
        <div style={{ color: "var(--muted-foreground)", fontSize: 13 }}>
          No model usage recorded for this period.
        </div>
      </section>
    );
  }
  const maxTotal = Math.max(...rows.map((r) => r.total_tokens), 1);
  return (
    <section style={styles.card}>
      <div style={styles.cardHeader}>
        <h2 style={styles.sectionTitle}>By model</h2>
        <span style={styles.mutedLabel}>Input · Output</span>
      </div>
      <div>
        {rows.map((r) => {
          const totalPct = (r.total_tokens / maxTotal) * 100;
          const inputShare =
            r.total_tokens > 0 ? r.input_tokens / r.total_tokens : 0;
          const inputPct = totalPct * inputShare;
          const outputPct = totalPct * (1 - inputShare);
          const label =
            (MODEL_LABELS as Record<string, string>)[r.model] ?? r.model;
          return (
            <div key={r.model} style={styles.modelRow}>
              <div style={styles.modelLabel}>{label}</div>
              <div style={styles.chartTrack} aria-hidden>
                <div
                  style={{ ...styles.chartFillInput, width: `${inputPct}%` }}
                />
                <div
                  style={{ ...styles.chartFillOutput, width: `${outputPct}%` }}
                />
              </div>
              <div style={styles.modelNums}>
                {fmtTokens(r.total_tokens)} tok
                {props.priced && r.billable_usd !== null
                  ? ` · ${fmtUsd(r.billable_usd)}`
                  : ""}
              </div>
            </div>
          );
        })}
      </div>
      {!props.priced ? (
        <div style={{ marginTop: 12, fontSize: 12 }}>
          <a {...props.settingsLinkProps} style={styles.link}>
            Set pricing →
          </a>{" "}
          to show billable USD.
        </div>
      ) : null}
    </section>
  );
}

function DailyChartCard(props: {
  loading: boolean;
  rows: DailyRow[];
  from: string;
  to: string;
}) {
  if (props.loading) {
    return (
      <section style={styles.card}>
        <div style={styles.cardHeader}>
          <h2 style={styles.sectionTitle}>Daily volume</h2>
        </div>
        <div style={{ ...styles.skeleton, height: 120, borderRadius: 8 }} />
      </section>
    );
  }
  // Build a dense day-by-day series from `from` to `to`, filling zero where the
  // rollup table has no row. Iterating bounded by `to` ensures we don't draw a
  // gap when usage only landed on some days.
  const byDay = new Map<string, number>();
  for (const r of props.rows) {
    const total = (Number(r.input_tokens) || 0) + (Number(r.output_tokens) || 0);
    byDay.set(r.day, (byDay.get(r.day) ?? 0) + total);
  }
  const days: { day: string; total: number }[] = [];
  const cursor = new Date(props.from + "T00:00:00Z");
  const end = new Date(props.to + "T00:00:00Z");
  while (cursor.getTime() <= end.getTime() && days.length < 366) {
    const day = cursor.toISOString().slice(0, 10);
    days.push({ day, total: byDay.get(day) ?? 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const totalsZero = days.every((d) => d.total === 0);
  if (totalsZero) {
    return (
      <section style={styles.card}>
        <div style={styles.cardHeader}>
          <h2 style={styles.sectionTitle}>Daily volume</h2>
        </div>
        <div style={{ color: "var(--muted-foreground)", fontSize: 13 }}>
          No usage recorded for this period yet.
        </div>
      </section>
    );
  }
  const maxTotal = Math.max(1, ...days.map((d) => d.total));
  const W = 1000;
  const H = 120;
  const gap = 2;
  const colW = Math.max(1, (W - gap * (days.length - 1)) / days.length);
  return (
    <section style={styles.card}>
      <div style={styles.cardHeader}>
        <h2 style={styles.sectionTitle}>Daily volume</h2>
        <span style={styles.mutedLabel}>
          peak {fmtTokens(maxTotal)} tok/day
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height: 120, display: "block" }}
        role="img"
        aria-label="Daily token volume across the selected period"
      >
        {days.map((d, i) => {
          if (d.total <= 0) return null;
          const h = Math.max(2, (d.total / maxTotal) * (H - 4));
          const x = i * (colW + gap);
          const y = H - h;
          return (
            <rect
              key={d.day}
              x={x}
              y={y}
              width={colW}
              height={h}
              rx={Math.min(1.5, colW / 2)}
              ry={Math.min(1.5, colW / 2)}
              fill="var(--primary)"
            >
              <title>{`${d.day}: ${fmtInt(d.total)} tokens`}</title>
            </rect>
          );
        })}
      </svg>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 8,
          fontSize: 11,
          color: "var(--muted-foreground)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span>{props.from}</span>
        <span>{props.to}</span>
      </div>
    </section>
  );
}

export function UsagePage(): JSX.Element {
  const host = useHostContext();
  const nav = useHostNavigation();
  const toast = usePluginToast();
  const companyId = host?.companyId ?? "";
  const settingsHref = useSettingsHref();
  const settingsLinkProps = nav.linkProps(settingsHref);

  const [mode, setMode] = useState<"month" | "custom">("month");
  const [anchor, setAnchor] = useState<MonthAnchor>(() => todayMonth());
  const [customFrom, setCustomFrom] = useState(isoDateOffset(30));
  const [customTo, setCustomTo] = useState(isoDateOffset(0));
  const [downloading, setDownloading] = useState(false);
  const [backfilling, setBackfilling] = useState(false);

  const backfillFromCostEvents = usePluginAction("backfillFromCostEvents");

  const { from, to } = useMemo(
    () =>
      mode === "month"
        ? monthBounds(anchor)
        : { from: customFrom, to: customTo },
    [mode, anchor, customFrom, customTo],
  );

  const daily = usePluginData<DailyResponse>("getDailyUsage", {
    companyId,
    from,
    to,
  });
  const perModel = usePluginData<PerModelResponse>("getPerModelForRange", {
    companyId,
    from,
    to,
  });
  const pricing = usePluginData<unknown>("getPricing", { companyId });

  const pricingConfig = useMemo(
    () => normalizePricing(pricing.data),
    [pricing.data],
  );
  const hasPricing = !!pricingConfig;

  const dailyRows: DailyRow[] = useMemo(() => {
    const d = daily.data;
    // Tolerate the historical bare-array shape too, in case a caller swaps the
    // worker out from under us. Never crash on a wrong-shape response.
    if (Array.isArray(d)) return d as DailyRow[];
    if (d && typeof d === "object" && Array.isArray((d as DailyResponse).rows)) {
      return (d as DailyResponse).rows;
    }
    return [];
  }, [daily.data]);

  const totals = useMemo(() => {
    let inp = 0;
    let out = 0;
    let billable = 0;
    let hasBillable = false;
    for (const r of dailyRows) {
      inp += Number(r.input_tokens) || 0;
      out += Number(r.output_tokens) || 0;
      if (typeof r.billable_usd === "number") {
        billable += r.billable_usd;
        hasBillable = true;
      }
    }
    return { inp, out, billable, hasBillable };
  }, [dailyRows]);

  // Download the CSV by fetching it and triggering an anchor with the `download`
  // attribute. This forces a real save instead of inline render, which is what
  // window.open() does when the host's API layer drops Content-Disposition.
  const downloadCsv = useCallback(async () => {
    if (downloading || !companyId) return;
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
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
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
      if (blobUrl) setTimeout(() => URL.revokeObjectURL(blobUrl!), 1000);
      setDownloading(false);
    }
  }, [companyId, from, to, downloading, toast]);

  // Backfill historical cost_events into usage_events, then refresh.
  // Useful right after installing the plugin: the live subscription only
  // catches events going forward, but anything in public.cost_events for
  // this company and range can be ingested retroactively.
  const runBackfill = useCallback(async () => {
    if (backfilling || !companyId) return;
    setBackfilling(true);
    try {
      const result = (await backfillFromCostEvents({
        companyId,
        from,
        to,
      })) as { scanned: number; inserted: number; daysRolledUp: number };
      toast?.({
        title: "Backfill complete",
        body: `${result.inserted} new events ingested · ${result.daysRolledUp} day(s) re-rolled-up · scanned ${result.scanned}`,
        tone: "success",
      });
      daily.refresh();
      perModel.refresh();
    } catch (err) {
      toast?.({
        title: "Backfill failed",
        body: String(err instanceof Error ? err.message : err),
        tone: "error",
      });
    } finally {
      setBackfilling(false);
    }
  }, [backfillFromCostEvents, backfilling, companyId, daily, from, perModel, to, toast]);

  if (!companyId) {
    return (
      <div className="tu-root" style={styles.page}>
        <ThemeStyles />
        <div style={styles.empty}>
          No company context. Open this plugin from inside a Paperclip company.
        </div>
      </div>
    );
  }

  const canStepForward = !isFutureMonth(nextMonth(anchor));
  const isLoading = daily.loading || perModel.loading;

  return (
    <div className="tu-root" style={styles.page}>
      <ThemeStyles />

      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <h1 style={styles.title}>Token Usage</h1>
          <p style={styles.subtitle}>
            Claude tokens consumed by this company. Used for client billing.
          </p>
        </div>
        <div style={styles.controls}>
          <button
            type="button"
            style={styles.btnPrimary}
            onClick={downloadCsv}
            disabled={downloading}
          >
            {downloading ? "Preparing…" : "Download monthly CSV"}
          </button>
        </div>
      </div>

      {/* Time scope */}
      <div style={styles.controls}>
        {mode === "month" ? (
          <>
            <button
              type="button"
              aria-label="Previous month"
              style={styles.btnIcon}
              onClick={() => setAnchor(prevMonth(anchor))}
            >
              ◀
            </button>
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                minWidth: 140,
                textAlign: "center",
              }}
            >
              {monthLabel(anchor)}
            </div>
            <button
              type="button"
              aria-label="Next month"
              style={{
                ...styles.btnIcon,
                opacity: canStepForward ? 1 : 0.4,
                cursor: canStepForward ? "pointer" : "not-allowed",
              }}
              onClick={() => canStepForward && setAnchor(nextMonth(anchor))}
              disabled={!canStepForward}
            >
              ▶
            </button>
            <button
              type="button"
              style={styles.btnGhost}
              onClick={() => setMode("custom")}
            >
              Custom range
            </button>
          </>
        ) : (
          <>
            <label style={styles.mutedLabel}>From</label>
            <input
              type="date"
              style={styles.input}
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
            />
            <label style={styles.mutedLabel}>To</label>
            <input
              type="date"
              style={styles.input}
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
            />
            <button
              type="button"
              style={styles.btnGhost}
              onClick={() => setMode("month")}
            >
              ← Back to month view
            </button>
          </>
        )}
        <div style={{ marginLeft: "auto" }}>
          <button
            type="button"
            style={styles.btn}
            onClick={runBackfill}
            disabled={backfilling}
            title="Scan the host's cost_events table for this period and ingest anything missing"
          >
            {backfilling ? "Backfilling…" : "Backfill from history"}
          </button>
        </div>
      </div>

      {/* KPI row */}
      <div style={styles.kpiRow}>
        <KpiCard
          label="Total tokens"
          value={fmtTokens(totals.inp + totals.out)}
          loading={isLoading}
        />
        <KpiCard
          label="Input"
          value={fmtTokens(totals.inp)}
          loading={isLoading}
        />
        <KpiCard
          label="Output"
          value={fmtTokens(totals.out)}
          loading={isLoading}
        />
        <KpiCard
          label="Billable"
          value={
            hasPricing && totals.hasBillable ? fmtUsd(totals.billable) : "—"
          }
          loading={isLoading}
          sub={
            !hasPricing ? (
              <a {...settingsLinkProps} style={styles.link}>
                Set pricing →
              </a>
            ) : undefined
          }
        />
      </div>

      {/* By model */}
      <PerModelCard
        loading={perModel.loading}
        rows={perModel.data?.rows ?? null}
        priced={!!perModel.data?.priced}
        settingsLinkProps={settingsLinkProps}
      />

      {/* Daily chart */}
      <DailyChartCard
        loading={daily.loading}
        rows={dailyRows}
        from={from}
        to={to}
      />

      {/* Pricing footer */}
      <section style={{ ...styles.card, padding: "12px 16px" }}>
        <div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
          {hasPricing && pricingConfig ? (
            <>
              Pricing configured. Opus 4.8 $
              {pricingConfig.pricing["opus-4-8"].input}/$
              {pricingConfig.pricing["opus-4-8"].output} per 1M tokens; margin{" "}
              {pricingConfig.margin.percent}%.{" "}
              <a {...settingsLinkProps} style={styles.link}>
                Edit rates →
              </a>
            </>
          ) : (
            <>
              Pricing not configured.{" "}
              <a {...settingsLinkProps} style={styles.link}>
                Set pricing →
              </a>{" "}
              to enable billable totals and the monthly CSV cost columns.
            </>
          )}
        </div>
      </section>
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
          /{host?.companyPrefix ?? "$COMPANY_HANDLE"}/{USAGE_ROUTE_SLUG}
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
                  step="0.1"
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
                  step="0.1"
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
