import React, { useMemo, useState, useEffect, useCallback } from "react";
import {
  useHostContext,
  usePluginData,
  usePluginAction,
  usePluginToast,
} from "@paperclipai/plugin-sdk/ui";

type DailyRow = {
  day: string;
  input_tokens: number;
  output_tokens: number;
  billable_usd?: number | null;
};

type WeeklyRow = {
  week_start: string;
  week_end: string;
  input_tokens: number;
  output_tokens: number;
  input_cost_usd?: number | null;
  output_cost_usd?: number | null;
  total_billed_usd?: number | null;
};

type ModelKey = "opus" | "sonnet" | "haiku";

type PricingConfig = {
  pricing: Record<ModelKey, { input: number; output: number }>;
  marginPercent: number;
};

const DEFAULT_PRICING: PricingConfig = {
  pricing: {
    opus: { input: 15, output: 75 },
    sonnet: { input: 3, output: 15 },
    haiku: { input: 0.8, output: 4 },
  },
  marginPercent: 0,
};

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
};

function ThemeStyles(): JSX.Element {
  return <style>{THEME_CSS}</style>;
}

export function UsagePage(): JSX.Element {
  const host = useHostContext();
  const companyId = host?.companyId ?? "";
  const [from, setFrom] = useState(isoDateOffset(30));
  const [to, setTo] = useState(isoDateOffset(0));

  const daily = usePluginData<DailyRow[]>("getDailyUsage", {
    companyId,
    from,
    to,
  });
  const weekly = usePluginData<WeeklyRow[]>("getWeeklySummary", {
    companyId,
    from,
    to,
  });
  const pricing = usePluginData<PricingConfig | null>("getPricing", {
    companyId,
  });

  const refresh = useCallback(() => {
    daily.refetch?.();
    weekly.refetch?.();
    pricing.refetch?.();
  }, [daily, weekly, pricing]);

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

  const downloadCsv = useCallback(() => {
    const url = `/api/plugins/claude-token-usage/api/export/weekly.csv?companyId=${encodeURIComponent(
      companyId,
    )}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    window.open(url, "_blank");
  }, [companyId, from, to]);

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
          <button style={styles.btnPrimary} onClick={downloadCsv}>
            Download weekly CSV
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
            <a href="#settings" style={styles.link}>
              Set pricing →
            </a>
          )}
        </div>
      </div>

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

      <div style={styles.sectionTitle}>Weekly rollup</div>
      {weekly.loading ? (
        <div style={styles.empty}>Loading…</div>
      ) : (weekly.data ?? []).length === 0 ? (
        <div style={styles.empty}>No weekly data in this range.</div>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Week start</th>
              <th style={styles.th}>Week end</th>
              <th style={styles.th}>Input tokens</th>
              <th style={styles.th}>Output tokens</th>
              {hasPricing && <th style={styles.th}>Billable</th>}
            </tr>
          </thead>
          <tbody>
            {(weekly.data ?? []).map((r) => (
              <tr key={`${r.week_start}-${r.week_end}`}>
                <td style={styles.td}>{r.week_start}</td>
                <td style={styles.td}>{r.week_end}</td>
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
  const companyId = host?.companyId ?? "";
  const pricing = usePluginData<PricingConfig | null>("getPricing", {
    companyId,
  });
  const setPricing = usePluginAction<PricingConfig, { ok: boolean }>(
    "setPricing",
  );
  const toast = usePluginToast();

  const [config, setConfig] = useState<PricingConfig>(DEFAULT_PRICING);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (pricing.data) {
      setConfig(pricing.data);
    }
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
      await setPricing.run({ companyId, config } as unknown as PricingConfig);
      toast?.show?.("Pricing saved");
      pricing.refetch?.();
    } catch (err) {
      toast?.show?.(`Save failed: ${String(err)}`);
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

  const models: { key: ModelKey; label: string }[] = [
    { key: "opus", label: "Opus" },
    { key: "sonnet", label: "Sonnet" },
    { key: "haiku", label: "Haiku" },
  ];

  return (
    <div className="tu-root" style={styles.page}><ThemeStyles />
      <h1 style={styles.title}>Token Usage Settings</h1>
      <p style={{ color: "var(--tu-muted)", fontSize: 13 }}>
        Rates are in USD per 1M tokens. Defaults match current public
        Anthropic API list prices; edit before saving if they have shifted.
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
          value={config.marginPercent}
          onChange={(e) =>
            setConfig((c) => ({
              ...c,
              marginPercent: Number(e.target.value) || 0,
            }))
          }
          style={{ ...styles.input, width: 120 }}
        />
      </div>

      <div style={{ marginTop: 24 }}>
        <button
          style={styles.btnPrimary}
          onClick={save}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

export default UsagePage;
