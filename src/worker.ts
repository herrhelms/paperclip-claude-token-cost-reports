import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginApiResponse,
} from "@paperclipai/plugin-sdk";
import type {
  PluginContext,
  PluginEvent,
} from "@paperclipai/plugin-sdk";

// Model keys are stable identifiers stored in usage_events.model / usage_daily.model.
// Format: `<family>-<major>-<minor>[-1m]`. The `-1m` suffix marks the 1M-token-context variant.
// "unknown" is the catch-all for anything normalizeModel can't classify.
export type ModelKey =
  | "opus-4-8"
  | "opus-4-8-1m"
  | "opus-4-7"
  | "opus-4-7-1m"
  | "sonnet-4-6"
  | "sonnet-4-6-1m"
  | "sonnet-4-5"
  | "sonnet-4-5-1m"
  | "unknown";

export const PRICED_MODEL_KEYS: ReadonlyArray<Exclude<ModelKey, "unknown">> = [
  "opus-4-8",
  "opus-4-8-1m",
  "opus-4-7",
  "opus-4-7-1m",
  "sonnet-4-6",
  "sonnet-4-6-1m",
  "sonnet-4-5",
  "sonnet-4-5-1m",
];

type PricingRates = Record<Exclude<ModelKey, "unknown">, { input: number; output: number }>;

export interface PricingConfig {
  pricing: PricingRates;
  margin: { percent: number };
}

interface DailyRow {
  company_id: string;
  day: string;
  model: ModelKey;
  input_tokens: number;
  output_tokens: number;
}

// Defaults pulled from https://platform.claude.com/docs/en/about-claude/pricing#model-pricing.
// Per the "Long context pricing" section: Opus 4.8 / 4.7 / Sonnet 4.6 INCLUDE the 1M context window
// at standard pricing — no surcharge for >200k requests. We mirror those rates for the [1m] variants.
// Sonnet 4.5 is not listed as 1M-included on the current page; its [1m] default mirrors the base
// rate so the line item exists if the operator's data uses it. Operator can override either.
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

const LEGACY_MODEL_REMAP: Record<string, ModelKey> = {
  // Pre-0.2.0 stored values used coarse family-only buckets. Map to the most recent listed
  // variant so historical rows can still be priced after upgrade.
  opus: "opus-4-7",
  sonnet: "sonnet-4-6",
};

export function normalizeModel(raw: unknown): ModelKey {
  if (typeof raw !== "string") return "unknown";
  const s = raw.toLowerCase().trim();
  const remap = LEGACY_MODEL_REMAP[s];
  if (remap) return remap;
  if (s in DEFAULT_PRICING.pricing) return s as ModelKey;
  // Long-context marker: explicit [1m] in name OR contains "1m"/"-1m-" alongside the version.
  const hasLongContext = /\[1m\]|(-|_| )1m(\b|-)/.test(s);
  const familyMatch = s.match(/(opus|sonnet)/);
  if (!familyMatch) return "unknown";
  const family = familyMatch[1];
  const versionMatch = s.match(/(\d+)[._-]?(\d+)/);
  if (!versionMatch) return "unknown";
  const major = versionMatch[1];
  const minor = versionMatch[2];
  const candidateBase = `${family}-${major}-${minor}` as ModelKey;
  const candidate1m = `${candidateBase}-1m` as ModelKey;
  if (hasLongContext && candidate1m in DEFAULT_PRICING.pricing) return candidate1m;
  if (candidateBase in DEFAULT_PRICING.pricing) return candidateBase;
  return "unknown";
}

function toDay(iso: string): string {
  return iso.slice(0, 10);
}

function monthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function monthEnd(start: Date): Date {
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
}

function fmtDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function monthKey(d: Date): string {
  // YYYY-MM — used as the bucket key so all rollups land on the same calendar month.
  return d.toISOString().slice(0, 7);
}

function q(ctx: PluginContext, table: string): string {
  return `${ctx.db.namespace}.${table}`;
}

function pricingScope(companyId: string) {
  return {
    scopeKind: "company" as const,
    scopeId: companyId,
    stateKey: "pricing-config",
  };
}

function isPricingConfig(v: unknown): v is PricingConfig {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  const p = c.pricing as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") return false;
  for (const k of PRICED_MODEL_KEYS) {
    const r = p[k] as Record<string, unknown> | undefined;
    if (!r || typeof r.input !== "number" || typeof r.output !== "number") return false;
  }
  const margin = c.margin as Record<string, unknown> | undefined;
  return !!margin && typeof margin.percent === "number";
}

// Upgrade older persisted configs (pre-0.2.0) to the new keyed shape, preserving
// any operator-set values where possible. Anything we can't map falls back to defaults.
function upgradePricingConfig(raw: unknown): PricingConfig {
  const out: PricingConfig = JSON.parse(JSON.stringify(DEFAULT_PRICING));
  if (!raw || typeof raw !== "object") return out;
  const c = raw as Record<string, unknown>;
  const p = (c.pricing ?? {}) as Record<string, unknown>;
  for (const k of PRICED_MODEL_KEYS) {
    const row = p[k] as { input?: unknown; output?: unknown } | undefined;
    if (row && typeof row.input === "number" && typeof row.output === "number") {
      out.pricing[k] = { input: row.input, output: row.output };
    }
  }
  // Legacy mappings: a pre-0.2.0 config had flat opus/sonnet/haiku keys.
  // Copy those forward to their remapped variants only if the operator hasn't already
  // overridden the new key, so we don't clobber explicit upgrades.
  const legacyOpus = (p.opus ?? {}) as { input?: unknown; output?: unknown };
  if (typeof legacyOpus.input === "number" && typeof legacyOpus.output === "number") {
    if (out.pricing["opus-4-7"].input === DEFAULT_PRICING.pricing["opus-4-7"].input) {
      out.pricing["opus-4-7"] = { input: legacyOpus.input, output: legacyOpus.output };
    }
  }
  const legacySonnet = (p.sonnet ?? {}) as { input?: unknown; output?: unknown };
  if (typeof legacySonnet.input === "number" && typeof legacySonnet.output === "number") {
    if (out.pricing["sonnet-4-6"].input === DEFAULT_PRICING.pricing["sonnet-4-6"].input) {
      out.pricing["sonnet-4-6"] = { input: legacySonnet.input, output: legacySonnet.output };
    }
  }
  const m = c.margin as { percent?: unknown } | undefined;
  if (m && typeof m.percent === "number") out.margin.percent = m.percent;
  return out;
}

async function loadPricing(ctx: PluginContext, companyId: string): Promise<PricingConfig | null> {
  const raw = await ctx.state.get(pricingScope(companyId));
  if (raw === undefined || raw === null) return null;
  // Accept both the current shape and the pre-0.2.0 shape via the upgrade path.
  if (isPricingConfig(raw)) return raw;
  return upgradePricingConfig(raw);
}

function priceFor(
  model: ModelKey,
  input: number,
  output: number,
  cfg: PricingConfig,
): { inputCost: number; outputCost: number } {
  if (model === "unknown") return { inputCost: 0, outputCost: 0 };
  const rate = cfg.pricing[model];
  if (!rate) return { inputCost: 0, outputCost: 0 };
  const inputCost = (input / 1_000_000) * rate.input;
  const outputCost = (output / 1_000_000) * rate.output;
  return { inputCost, outputCost };
}

async function rollupCompanyDay(ctx: PluginContext, companyId: string, day: string): Promise<void> {
  const rows = await ctx.db.query<{
    model: ModelKey;
    input_tokens: number;
    output_tokens: number;
  }>(
    `SELECT model,
            SUM(input_tokens)  AS input_tokens,
            SUM(output_tokens) AS output_tokens
       FROM ${q(ctx, "usage_events")}
      WHERE company_id = $1 AND day = $2
      GROUP BY model`,
    [companyId, day],
  );

  await ctx.db.execute(
    `DELETE FROM ${q(ctx, "usage_daily")} WHERE company_id = $1 AND day = $2`,
    [companyId, day],
  );

  for (const r of rows) {
    await ctx.db.execute(
      `INSERT INTO ${q(ctx, "usage_daily")} (company_id, day, model, input_tokens, output_tokens)
       VALUES ($1, $2, $3, $4, $5)`,
      [companyId, day, r.model, Number(r.input_tokens) || 0, Number(r.output_tokens) || 0],
    );
  }
}

async function ingestEvent(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const e = event as unknown as Record<string, unknown>;
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  const sourceEventId = String(
    e.eventId ?? (e as { id?: string }).id ?? payload.eventId ?? payload.id ?? "",
  );
  const companyId = String(e.companyId ?? payload.companyId ?? payload.company_id ?? "");
  const occurredAt = String(
    e.occurredAt ??
      payload.occurredAt ??
      payload.occurred_at ??
      new Date().toISOString(),
  );
  const agentId =
    (payload.agentId as string | undefined) ??
    (payload.agent_id as string | undefined) ??
    (e.actorType === "agent" ? ((e.actorId as string) ?? null) : null);
  const model = payload.model;
  const rawModel = typeof model === "string" ? model : null;
  const inputTokens = Number(payload.inputTokens ?? payload.input_tokens ?? 0);
  const outputTokens = Number(payload.outputTokens ?? payload.output_tokens ?? 0);
  const cachedInputTokens = Number(
    payload.cachedInputTokens ?? payload.cached_input_tokens ?? 0,
  );
  // Costs page tracks provider + source (subscription vs api) per event. Default to
  // anthropic + api when the producer omits them so legacy callers still group.
  const provider = String(
    payload.provider ?? payload.providerKey ?? "anthropic",
  ).toLowerCase();
  const source = String(
    payload.source ?? payload.billing ?? payload.billingMode ?? "api",
  ).toLowerCase();
  const costCentsRaw =
    payload.costCents ??
    payload.cost_cents ??
    (typeof payload.costUsd === "number"
      ? Math.round((payload.costUsd as number) * 100)
      : typeof payload.cost_usd === "number"
        ? Math.round((payload.cost_usd as number) * 100)
        : undefined);
  const costCents =
    typeof costCentsRaw === "number" && isFinite(costCentsRaw)
      ? Math.round(costCentsRaw)
      : null;

  // Always log so the operator can see what's arriving and diagnose silently-dropped events.
  ctx.logger.info("usage event received", {
    eventType: e.eventType ?? event.eventType,
    sourceEventId,
    companyId,
    agentId,
    rawModel,
    provider,
    source,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costCents,
    occurredAt,
    payloadKeys: Object.keys(payload),
  });

  if (!sourceEventId || !companyId) {
    ctx.logger.warn("usage event skipped: missing id or company", {
      sourceEventId,
      companyId,
    });
    return;
  }
  if (!inputTokens && !outputTokens && !cachedInputTokens) {
    // Zero-token events do exist (manual credits, refunds, etc.) — record nothing.
    return;
  }

  const totalInput = inputTokens + cachedInputTokens;

  await ctx.db.execute(
    `INSERT INTO ${q(ctx, "usage_events")}
       (source_event_id, company_id, agent_id, model, raw_model, provider, source,
        input_tokens, output_tokens, cached_input_tokens, cost_cents, occurred_at, day)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (source_event_id) DO NOTHING`,
    [
      sourceEventId,
      companyId,
      agentId,
      normalizeModel(model),
      rawModel,
      provider,
      source,
      totalInput,
      outputTokens || 0,
      cachedInputTokens || 0,
      costCents,
      occurredAt,
      toDay(occurredAt),
    ],
  );

  await rollupCompanyDay(ctx, companyId, toDay(occurredAt));
}

function buildMonthlyRows(
  daily: DailyRow[],
  pricing: PricingConfig | null,
): Array<{
  month: string;
  month_start: string;
  month_end: string;
  input_tokens: number;
  output_tokens: number;
  input_cost_usd: number | null;
  output_cost_usd: number | null;
  total_billed_usd: number | null;
}> {
  const buckets = new Map<
    string,
    {
      month: string;
      month_start: string;
      month_end: string;
      input_tokens: number;
      output_tokens: number;
      input_cost_usd: number;
      output_cost_usd: number;
    }
  >();

  for (const row of daily) {
    const start = monthStart(new Date(row.day + "T00:00:00Z"));
    const key = monthKey(start);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        month: key,
        month_start: fmtDay(start),
        month_end: fmtDay(monthEnd(start)),
        input_tokens: 0,
        output_tokens: 0,
        input_cost_usd: 0,
        output_cost_usd: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.input_tokens += Number(row.input_tokens) || 0;
    bucket.output_tokens += Number(row.output_tokens) || 0;
    if (pricing) {
      const { inputCost, outputCost } = priceFor(
        row.model,
        Number(row.input_tokens) || 0,
        Number(row.output_tokens) || 0,
        pricing,
      );
      bucket.input_cost_usd += inputCost;
      bucket.output_cost_usd += outputCost;
    }
  }

  const marginMultiplier = pricing ? 1 + (pricing.margin.percent || 0) / 100 : 1;

  return Array.from(buckets.values())
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((b) => ({
      month: b.month,
      month_start: b.month_start,
      month_end: b.month_end,
      input_tokens: b.input_tokens,
      output_tokens: b.output_tokens,
      input_cost_usd: pricing ? Number(b.input_cost_usd.toFixed(4)) : null,
      output_cost_usd: pricing ? Number(b.output_cost_usd.toFixed(4)) : null,
      total_billed_usd: pricing
        ? Number(((b.input_cost_usd + b.output_cost_usd) * marginMultiplier).toFixed(4))
        : null,
    }));
}

async function readDaily(
  ctx: PluginContext,
  companyId: string,
  from: string,
  to: string,
): Promise<DailyRow[]> {
  return ctx.db.query<DailyRow>(
    `SELECT company_id, day, model, input_tokens, output_tokens
       FROM ${q(ctx, "usage_daily")}
      WHERE company_id = $1 AND day >= $2 AND day <= $3
      ORDER BY day DESC`,
    [companyId, from, to],
  );
}

async function buildMonthlyCsv(ctx: PluginContext, companyId: string, from: string, to: string): Promise<string> {
  const pricing = await loadPricing(ctx, companyId);
  const daily = await readDaily(ctx, companyId, from, to);
  const monthly = buildMonthlyRows(daily, pricing);
  const header =
    "month,month_start,month_end,input_tokens,output_tokens,input_cost_usd,output_cost_usd,total_billed_usd";
  const lines = monthly.map((m) =>
    [
      m.month,
      m.month_start,
      m.month_end,
      m.input_tokens,
      m.output_tokens,
      m.input_cost_usd ?? "",
      m.output_cost_usd ?? "",
      m.total_billed_usd ?? "",
    ].join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}

// ---------- Costs overview (mirrors the host /costs page card) ----------

const ROLLING_WINDOWS: ReadonlyArray<{ key: "5h" | "24h" | "7d"; ms: number }> = [
  { key: "5h",  ms:        5 * 3600 * 1000 },
  { key: "24h", ms:       24 * 3600 * 1000 },
  { key: "7d",  ms: 7 * 24 * 3600 * 1000 },
];

interface CostsRollingWindow {
  windowKey: "5h" | "24h" | "7d";
  tokens: number;
  costUsd: number | null;
}

interface CostsSubscriptionSummary {
  runs: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  subscriptionTokens: number;
  apiTokens: number;
  subscriptionShare: number;       // 0..1
}

interface CostsModelRow {
  rawModel: string;                 // e.g. "claude-opus-4-7[1m]"
  normalizedKey: ModelKey;          // e.g. "opus-4-7-1m"
  provider: string;                 // e.g. "anthropic"
  source: string;                   // e.g. "subscription" | "api"
  tokens: number;
  tokenShare: number;               // 0..1 across all rows
  costUsd: number | null;
}

// Per-agent breakdown (mirrors the host /costs page's "What each agent consumed" section).
// One row per agent, with a nested per-(rawModel,source) sub-list.
interface CostsAgentModelRow {
  rawModel: string;                 // e.g. "claude-opus-4-7[1m]"
  normalizedKey: ModelKey;
  provider: string;
  source: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  agentTokenShare: number;          // 0..1 within this agent's total
  costUsd: number | null;
}

interface CostsAgentRow {
  agentId: string;                  // raw event agent id (may be a UUID or a slug)
  agentName: string;                // resolved via ctx.agents.list; falls back to "Agent <short-id>"
  agentTitle: string | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  apiRuns: number;
  subscriptionRuns: number;
  costUsd: number | null;
  models: CostsAgentModelRow[];
}

interface CostsOverview {
  asOf: string;
  windowStart: string;              // start of the longest window (7d)
  rollingWindows: CostsRollingWindow[];
  subscription: CostsSubscriptionSummary;
  perModel: CostsModelRow[];
  perAgent: CostsAgentRow[];        // What each agent consumed in the 7d horizon.
  priced: boolean;                  // false → cost columns are null
  quotaNote: string;                // Claude CLI quota is host-local; we can't surface it.
}

function priceTokens(
  normalizedKey: ModelKey,
  input: number,
  output: number,
  pricing: PricingConfig | null,
): number | null {
  if (!pricing) return null;
  const { inputCost, outputCost } = priceFor(normalizedKey, input, output, pricing);
  const total = inputCost + outputCost;
  const marginMultiplier = 1 + (pricing.margin.percent || 0) / 100;
  return Number((total * marginMultiplier).toFixed(4));
}

async function buildCostsOverview(
  ctx: PluginContext,
  companyId: string,
): Promise<CostsOverview> {
  const pricing = await loadPricing(ctx, companyId);
  // Use the longest window as the read horizon so a single query feeds every bucket.
  const horizonMs = ROLLING_WINDOWS[ROLLING_WINDOWS.length - 1].ms;
  const now = new Date();
  const since = new Date(now.getTime() - horizonMs);

  const events = await ctx.db.query<{
    agent_id: string | null;
    raw_model: string | null;
    model: ModelKey;
    provider: string | null;
    source: string | null;
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    cost_cents: number | null;
    occurred_at: string;
  }>(
    `SELECT agent_id, raw_model, model, provider, source,
            input_tokens, output_tokens, cached_input_tokens, cost_cents,
            occurred_at
       FROM ${q(ctx, "usage_events")}
      WHERE company_id = $1 AND occurred_at >= $2`,
    [companyId, since.toISOString()],
  );

  // Rolling windows.
  const rollingWindows: CostsRollingWindow[] = ROLLING_WINDOWS.map(({ key, ms }) => {
    const start = new Date(now.getTime() - ms).getTime();
    let tokens = 0;
    let costUsd = 0;
    let hasCost = false;
    for (const e of events) {
      const t = new Date(e.occurred_at).getTime();
      if (t < start) continue;
      const inp = Number(e.input_tokens) || 0;
      const out = Number(e.output_tokens) || 0;
      tokens += inp + out;
      const priced = priceTokens(e.model, inp, out, pricing);
      if (priced !== null) {
        costUsd += priced;
        hasCost = true;
      }
    }
    return {
      windowKey: key,
      tokens,
      costUsd: hasCost ? Number(costUsd.toFixed(4)) : null,
    };
  });

  // Subscription summary — 7d horizon, mirrors the host card's "runs · total · in · out" line.
  let runs = 0;
  let subTokens = 0;
  let apiTokens = 0;
  let totalIn = 0;
  let totalOut = 0;
  for (const e of events) {
    runs++;
    const inp = Number(e.input_tokens) || 0;
    const out = Number(e.output_tokens) || 0;
    totalIn += inp;
    totalOut += out;
    const src = (e.source || "api").toLowerCase();
    if (src === "subscription") subTokens += inp + out;
    else apiTokens += inp + out;
  }
  const totalTokens = subTokens + apiTokens;
  const subscriptionShare = totalTokens > 0 ? subTokens / totalTokens : 0;

  // Per-model breakdown — group by raw_model (with [1m] suffix preserved).
  const perModelMap = new Map<
    string,
    {
      rawModel: string;
      normalizedKey: ModelKey;
      provider: string;
      source: string;
      tokens: number;
      input: number;
      output: number;
    }
  >();
  for (const e of events) {
    const rawModel = e.raw_model || e.model || "unknown";
    const provider = (e.provider || "anthropic").toLowerCase();
    const source = (e.source || "api").toLowerCase();
    const key = `${rawModel}|${provider}|${source}`;
    let bucket = perModelMap.get(key);
    if (!bucket) {
      bucket = {
        rawModel,
        normalizedKey: e.model,
        provider,
        source,
        tokens: 0,
        input: 0,
        output: 0,
      };
      perModelMap.set(key, bucket);
    }
    const inp = Number(e.input_tokens) || 0;
    const out = Number(e.output_tokens) || 0;
    bucket.input += inp;
    bucket.output += out;
    bucket.tokens += inp + out;
  }
  const perModelRaw = Array.from(perModelMap.values()).sort((a, b) => b.tokens - a.tokens);
  const grandTokens = perModelRaw.reduce((sum, r) => sum + r.tokens, 0);
  const perModel: CostsModelRow[] = perModelRaw.map((r) => ({
    rawModel: r.rawModel,
    normalizedKey: r.normalizedKey,
    provider: r.provider,
    source: r.source,
    tokens: r.tokens,
    tokenShare: grandTokens > 0 ? r.tokens / grandTokens : 0,
    costUsd: priceTokens(r.normalizedKey, r.input, r.output, pricing),
  }));

  // ---------- Per-agent breakdown (mirrors host /costs "What each agent consumed") ----------
  // Group events by agent_id, then within each agent group by (rawModel, source).
  // Run counts increment per-event so we can show "0 api · N subscription" like the host does.
  type AgentBucket = {
    agentId: string;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    apiRuns: number;
    subscriptionRuns: number;
    costAccumUsd: number;
    hasCost: boolean;
    models: Map<string, {
      rawModel: string;
      normalizedKey: ModelKey;
      provider: string;
      source: string;
      tokens: number;
      input: number;
      output: number;
    }>;
  };
  const perAgentMap = new Map<string, AgentBucket>();
  for (const e of events) {
    if (!e.agent_id) continue;
    const agentId = e.agent_id;
    let agent = perAgentMap.get(agentId);
    if (!agent) {
      agent = {
        agentId,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        apiRuns: 0,
        subscriptionRuns: 0,
        costAccumUsd: 0,
        hasCost: false,
        models: new Map(),
      };
      perAgentMap.set(agentId, agent);
    }
    const inp = Number(e.input_tokens) || 0;
    const out = Number(e.output_tokens) || 0;
    const src = (e.source || "api").toLowerCase();
    agent.inputTokens += inp;
    agent.outputTokens += out;
    agent.totalTokens += inp + out;
    if (src === "subscription") agent.subscriptionRuns++;
    else agent.apiRuns++;
    const priced = priceTokens(e.model, inp, out, pricing);
    if (priced !== null) {
      agent.costAccumUsd += priced;
      agent.hasCost = true;
    }
    const rawModel = e.raw_model || e.model || "unknown";
    const provider = (e.provider || "anthropic").toLowerCase();
    const modelKey = `${rawModel}|${provider}|${src}`;
    let m = agent.models.get(modelKey);
    if (!m) {
      m = {
        rawModel,
        normalizedKey: e.model,
        provider,
        source: src,
        tokens: 0,
        input: 0,
        output: 0,
      };
      agent.models.set(modelKey, m);
    }
    m.input += inp;
    m.output += out;
    m.tokens += inp + out;
  }

  // Resolve agent_id → display name. Single ctx.agents.list call covers the whole company.
  // Falls back to "Agent <short-id>" when the id isn't in the company (e.g. terminated agents).
  type AgentLite = { id: string; name?: string | null; title?: string | null };
  let agentDirectory = new Map<string, AgentLite>();
  try {
    const agents = (await ctx.agents.list({ companyId })) as unknown as AgentLite[];
    for (const a of agents) agentDirectory.set(a.id, a);
  } catch (err) {
    // agents.read not granted, or transient host error. Names just won't resolve;
    // costs still render with fallback labels.
    ctx.logger?.warn?.("ctx.agents.list failed; per-agent names will fall back to ids", {
      error: String(err instanceof Error ? err.message : err),
    });
  }

  const perAgent: CostsAgentRow[] = Array.from(perAgentMap.values())
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((a) => {
      const directoryHit = agentDirectory.get(a.agentId);
      const shortId = a.agentId.length > 8 ? a.agentId.slice(0, 8) : a.agentId;
      const models = Array.from(a.models.values())
        .sort((m1, m2) => m2.tokens - m1.tokens)
        .map((m) => ({
          rawModel: m.rawModel,
          normalizedKey: m.normalizedKey,
          provider: m.provider,
          source: m.source,
          tokens: m.tokens,
          inputTokens: m.input,
          outputTokens: m.output,
          agentTokenShare: a.totalTokens > 0 ? m.tokens / a.totalTokens : 0,
          costUsd: priceTokens(m.normalizedKey, m.input, m.output, pricing),
        }));
      return {
        agentId: a.agentId,
        agentName: directoryHit?.name || `Agent ${shortId}`,
        agentTitle: directoryHit?.title || null,
        totalTokens: a.totalTokens,
        inputTokens: a.inputTokens,
        outputTokens: a.outputTokens,
        apiRuns: a.apiRuns,
        subscriptionRuns: a.subscriptionRuns,
        costUsd: a.hasCost ? Number(a.costAccumUsd.toFixed(4)) : null,
        models,
      };
    });

  return {
    asOf: now.toISOString(),
    windowStart: since.toISOString(),
    rollingWindows,
    subscription: {
      runs,
      totalTokens,
      inputTokens: totalIn,
      outputTokens: totalOut,
      subscriptionTokens: subTokens,
      apiTokens,
      subscriptionShare,
    },
    perModel,
    perAgent,
    priced: !!pricing,
    quotaNote:
      "Claude CLI subscription quota windows (Current session / Current week) are host-local — not exposed via the cost_event.created bus, so this card omits them.",
  };
}

let capturedCtx: PluginContext | null = null;

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    capturedCtx = ctx;
    ctx.logger.info("claude-token-usage starting up", {
      namespace: ctx.db.namespace,
    });

    ctx.events.on("cost_event.created", async (event) => {
      await ingestEvent(ctx, event);
    });

    ctx.events.on("agent.run.finished", async (event) => {
      await ingestEvent(ctx, event);
    });

    ctx.jobs.register("rollup-daily", async (job) => {
      ctx.logger.info("rollup-daily run", { runId: job.runId, trigger: job.trigger });
      const today = fmtDay(new Date());
      const companies = await ctx.db.query<{ company_id: string }>(
        `SELECT DISTINCT company_id FROM ${q(ctx, "usage_events")} WHERE day = $1`,
        [today],
      );
      for (const c of companies) {
        await rollupCompanyDay(ctx, c.company_id, today);
      }
    });

    // Read-only fetchers used by the UI's usePluginData(...) hooks live on
    // ctx.data.register, NOT ctx.actions.register. The host wires data and
    // actions through separate registries; usePluginData calls into the data
    // registry while usePluginAction calls into the actions registry. The
    // earlier mismatch caused every getter (pricing, daily, monthly, costs,
    // ingest) to silently no-op in the UI, falling back to default state.
    ctx.data.register("getDailyUsage", async (params) => {
      const companyId = String(params.companyId ?? "");
      const from = String(params.from ?? "");
      const to = String(params.to ?? "");
      if (!companyId || !from || !to) throw new Error("companyId, from, to are required");

      const pricing = await loadPricing(ctx, companyId);
      const rows = await readDaily(ctx, companyId, from, to);

      const byDay = new Map<string, {
        day: string;
        input_tokens: number;
        output_tokens: number;
        billable_usd: number;
      }>();
      const marginMultiplier = pricing ? 1 + (pricing.margin.percent || 0) / 100 : 1;

      for (const r of rows) {
        let bucket = byDay.get(r.day);
        if (!bucket) {
          bucket = { day: r.day, input_tokens: 0, output_tokens: 0, billable_usd: 0 };
          byDay.set(r.day, bucket);
        }
        bucket.input_tokens += Number(r.input_tokens) || 0;
        bucket.output_tokens += Number(r.output_tokens) || 0;
        if (pricing) {
          const { inputCost, outputCost } = priceFor(
            r.model,
            Number(r.input_tokens) || 0,
            Number(r.output_tokens) || 0,
            pricing,
          );
          bucket.billable_usd += (inputCost + outputCost) * marginMultiplier;
        }
      }

      return {
        priced: !!pricing,
        rows: Array.from(byDay.values())
          .sort((a, b) => b.day.localeCompare(a.day))
          .map((r) => ({
            day: r.day,
            input_tokens: r.input_tokens,
            output_tokens: r.output_tokens,
            billable_usd: pricing ? Number(r.billable_usd.toFixed(4)) : null,
          })),
      };
    });

    ctx.data.register("getMonthlySummary", async (params) => {
      const companyId = String(params.companyId ?? "");
      const from = String(params.from ?? "");
      const to = String(params.to ?? "");
      if (!companyId || !from || !to) throw new Error("companyId, from, to are required");
      const pricing = await loadPricing(ctx, companyId);
      const daily = await readDaily(ctx, companyId, from, to);
      return {
        priced: !!pricing,
        rows: buildMonthlyRows(daily, pricing),
      };
    });

    // Per-model breakdown for the period. Feeds the dashboard's "By model"
    // chart: one row per model that appears in usage_daily for the range,
    // sorted by total_tokens desc. Drops "unknown" if it contributed zero.
    // Billable USD is filled when pricing is configured; null otherwise.
    ctx.data.register("getPerModelForRange", async (params) => {
      const companyId = String(params.companyId ?? "");
      const from = String(params.from ?? "");
      const to = String(params.to ?? "");
      if (!companyId || !from || !to) throw new Error("companyId, from, to are required");
      const pricing = await loadPricing(ctx, companyId);
      const daily = await readDaily(ctx, companyId, from, to);

      const byModel = new Map<ModelKey, { input_tokens: number; output_tokens: number; billable_usd: number }>();
      const marginMultiplier = pricing ? 1 + (pricing.margin.percent || 0) / 100 : 1;

      for (const r of daily) {
        const inp = Number(r.input_tokens) || 0;
        const out = Number(r.output_tokens) || 0;
        let bucket = byModel.get(r.model);
        if (!bucket) {
          bucket = { input_tokens: 0, output_tokens: 0, billable_usd: 0 };
          byModel.set(r.model, bucket);
        }
        bucket.input_tokens += inp;
        bucket.output_tokens += out;
        if (pricing) {
          const { inputCost, outputCost } = priceFor(r.model, inp, out, pricing);
          bucket.billable_usd += (inputCost + outputCost) * marginMultiplier;
        }
      }

      const rows = Array.from(byModel.entries())
        .map(([model, b]) => ({
          model,
          input_tokens: b.input_tokens,
          output_tokens: b.output_tokens,
          total_tokens: b.input_tokens + b.output_tokens,
          billable_usd: pricing ? Number(b.billable_usd.toFixed(4)) : null,
        }))
        .filter((r) => r.total_tokens > 0)
        .sort((a, b) => b.total_tokens - a.total_tokens);

      return { priced: !!pricing, rows };
    });

    ctx.data.register("getCostsOverview", async (params) => {
      const companyId = String(params.companyId ?? "");
      if (!companyId) throw new Error("companyId is required");
      return buildCostsOverview(ctx, companyId);
    });

    // Diagnostic: lets the UI confirm whether cost_event.created is actually
    // flowing to the worker. If totalEvents is 0 the host probably hasn't
    // granted `costs.read` — surface that to the operator instead of silently
    // showing empty cards.
    ctx.data.register("getIngestStats", async (params) => {
      const companyId = String(params.companyId ?? "");
      if (!companyId) throw new Error("companyId is required");
      const now = new Date();
      const since24h = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
      const [totalRow] = await ctx.db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM ${q(ctx, "usage_events")} WHERE company_id = $1`,
        [companyId],
      );
      const [recentRow] = await ctx.db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM ${q(ctx, "usage_events")}
          WHERE company_id = $1 AND occurred_at >= $2`,
        [companyId, since24h],
      );
      const [lastRow] = await ctx.db.query<{ occurred_at: string | null }>(
        `SELECT MAX(occurred_at) AS occurred_at FROM ${q(ctx, "usage_events")}
          WHERE company_id = $1`,
        [companyId],
      );
      const declaredCapabilities = ctx.manifest?.capabilities ?? [];
      const hasCostsRead = declaredCapabilities.includes("costs.read");
      return {
        asOf: now.toISOString(),
        totalEvents: totalRow?.n ?? 0,
        last24hEvents: recentRow?.n ?? 0,
        lastEventAt: lastRow?.occurred_at ?? null,
        hasCostsReadCapability: hasCostsRead,
        diagnosticHint:
          (totalRow?.n ?? 0) === 0
            ? hasCostsRead
              ? "No events ingested yet. cost_event.created subscriptions can take a few minutes to attach after install; if this persists check the host plugin logs."
              : "costs.read capability is NOT declared in the running manifest. Reinstall the plugin so the host re-evaluates capabilities."
            : null,
      };
    });

    ctx.data.register("getPricing", async (params) => {
      const companyId = String(params.companyId ?? "");
      if (!companyId) throw new Error("companyId is required");
      const existing = await loadPricing(ctx, companyId);
      // Return the bare PricingConfig — never wrap; UI binds to .pricing/.margin directly.
      return existing ?? DEFAULT_PRICING;
    });

    ctx.actions.register("setPricing", async (params) => {
      const companyId = String(params.companyId ?? "");
      const config = params.config as PricingConfig | undefined;
      if (!companyId || !config) throw new Error("companyId and config are required");
      if (!isPricingConfig(config)) {
        throw new Error("config does not match the PricingConfig shape");
      }
      await ctx.state.set(pricingScope(companyId), config);
      ctx.logger.info("pricing saved", { companyId });
      return { ok: true };
    });

    // Backfill: read the host's historical cost_events for the company over a
    // date range and ingest them into our usage_events table. Idempotent —
    // source_event_id is prefixed `cost_event:<id>` so re-running the same range
    // is a no-op via ON CONFLICT DO NOTHING. After ingest, every affected day
    // is re-rolled-up so the dashboard catches up immediately.
    //
    // Token math mirrors the live ingest path: input_tokens + cached_input_tokens
    // both land in `input_tokens` because pricing applies the same rate to both
    // and the operator doesn't care about cache attribution at the bill level.
    ctx.actions.register("backfillFromCostEvents", async (params) => {
      const companyId = String(params.companyId ?? "");
      const from = String(params.from ?? "");
      const to = String(params.to ?? "");
      if (!companyId || !from || !to) throw new Error("companyId, from, to are required");
      // Range is inclusive of the to-date. Use a half-open window in the SQL
      // so a row with occurred_at=23:59:59 on `to` still lands inside.
      const fromIso = `${from}T00:00:00Z`;
      const toIso = `${to}T23:59:59.999Z`;

      type Row = {
        id: string;
        company_id: string;
        agent_id: string | null;
        model: string;
        input_tokens: number | string | null;
        cached_input_tokens: number | string | null;
        output_tokens: number | string | null;
        occurred_at: string;
      };

      const rows = await ctx.db.query<Row>(
        `SELECT id::text             AS id,
                company_id::text     AS company_id,
                agent_id::text       AS agent_id,
                model,
                input_tokens,
                cached_input_tokens,
                output_tokens,
                occurred_at::text    AS occurred_at
           FROM public.cost_events
          WHERE company_id = $1::uuid
            AND occurred_at >= $2::timestamptz
            AND occurred_at <= $3::timestamptz`,
        [companyId, fromIso, toIso],
      );

      let inserted = 0;
      const affectedDays = new Set<string>();

      for (const r of rows) {
        const inp = Number(r.input_tokens) || 0;
        const cached = Number(r.cached_input_tokens) || 0;
        const out = Number(r.output_tokens) || 0;
        if (!inp && !cached && !out) continue;
        const day = String(r.occurred_at).slice(0, 10);
        const result = await ctx.db.execute(
          `INSERT INTO ${q(ctx, "usage_events")}
             (source_event_id, company_id, agent_id, model, input_tokens, output_tokens, occurred_at, day)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (source_event_id) DO NOTHING`,
          [
            `cost_event:${r.id}`,
            r.company_id,
            r.agent_id,
            normalizeModel(r.model),
            inp + cached,
            out,
            r.occurred_at,
            day,
          ],
        );
        if (result.rowCount > 0) inserted++;
        affectedDays.add(day);
      }

      for (const day of affectedDays) {
        await rollupCompanyDay(ctx, companyId, day);
      }

      ctx.logger.info("backfill complete", {
        companyId,
        from,
        to,
        scanned: rows.length,
        inserted,
        daysRolledUp: affectedDays.size,
      });
      return {
        scanned: rows.length,
        inserted,
        daysRolledUp: affectedDays.size,
        days: Array.from(affectedDays).sort(),
      };
    });
  },

  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    if (input.routeKey !== "export-monthly-csv") {
      return { status: 404, body: { error: "unknown route" } };
    }
    const ctx = capturedCtx;
    const companyId = input.companyId;
    const from = String(
      Array.isArray(input.query.from) ? input.query.from[0] : input.query.from ?? "",
    );
    const to = String(
      Array.isArray(input.query.to) ? input.query.to[0] : input.query.to ?? "",
    );
    if (!companyId || !from || !to) {
      return {
        status: 400,
        headers: { "content-type": "text/plain" },
        body: "companyId, from, to are required",
      };
    }
    if (!ctx) return { status: 500, body: { error: "worker not initialized" } };
    const csv = await buildMonthlyCsv(ctx, companyId, from, to);
    return {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="usage-${companyId}-${from}-${to}-monthly.csv"`,
      },
      body: csv,
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
