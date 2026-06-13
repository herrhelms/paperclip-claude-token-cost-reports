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

type ModelKey = "opus" | "sonnet" | "haiku" | "unknown";

interface PricingConfig {
  pricing: {
    opus: { input: number; output: number };
    sonnet: { input: number; output: number };
    haiku: { input: number; output: number };
  };
  margin: { percent: number };
}

interface DailyRow {
  company_id: string;
  day: string;
  model: ModelKey;
  input_tokens: number;
  output_tokens: number;
}

const DEFAULT_PRICING: PricingConfig = {
  pricing: {
    opus: { input: 15, output: 75 },
    sonnet: { input: 3, output: 15 },
    haiku: { input: 0.8, output: 4 },
  },
  margin: { percent: 0 },
};

function normalizeModel(raw: unknown): ModelKey {
  if (typeof raw !== "string") return "unknown";
  const m = raw.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return "unknown";
}

function toDay(iso: string): string {
  return iso.slice(0, 10);
}

function isoWeekStart(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  if (day !== 1) d.setUTCDate(d.getUTCDate() - (day - 1));
  return d;
}

function isoWeekEnd(start: Date): Date {
  const e = new Date(start);
  e.setUTCDate(e.getUTCDate() + 6);
  return e;
}

function fmtDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function q(ctx: PluginContext, table: string): string {
  return `${ctx.db.namespace}.${table}`;
}

async function loadPricing(ctx: PluginContext, companyId: string): Promise<PricingConfig | null> {
  const rows = await ctx.db.query<{ json: string }>(
    `SELECT json FROM ${q(ctx, "pricing_config")} WHERE company_id = $1`,
    [companyId],
  );
  if (!rows.length) return null;
  try {
    return JSON.parse(rows[0].json) as PricingConfig;
  } catch {
    return null;
  }
}

function priceFor(
  model: ModelKey,
  input: number,
  output: number,
  cfg: PricingConfig,
): { inputCost: number; outputCost: number } {
  if (model === "unknown") return { inputCost: 0, outputCost: 0 };
  const rate = cfg.pricing[model];
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
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const sourceEventId = String((event as unknown as { id?: string }).id ?? payload.id ?? "");
  if (!sourceEventId) return;

  const companyId =
    (payload.companyId as string) ?? (payload.company_id as string) ?? "";
  const agentId =
    (payload.agentId as string) ?? (payload.agent_id as string) ?? null;
  const model = payload.model;
  const inputTokens = Number(payload.inputTokens ?? payload.input_tokens ?? 0);
  const outputTokens = Number(payload.outputTokens ?? payload.output_tokens ?? 0);
  const occurredAt = String(
    payload.occurredAt ?? payload.occurred_at ?? new Date(0).toISOString(),
  );

  if (!companyId || (!inputTokens && !outputTokens)) {
    // Nothing useful to record; skip silently.
    return;
  }

  await ctx.db.execute(
    `INSERT INTO ${q(ctx, "usage_events")}
       (source_event_id, company_id, agent_id, model, input_tokens, output_tokens, occurred_at, day)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (source_event_id) DO NOTHING`,
    [
      sourceEventId,
      companyId,
      agentId,
      normalizeModel(model),
      inputTokens || 0,
      outputTokens || 0,
      occurredAt,
      toDay(occurredAt),
    ],
  );

  await rollupCompanyDay(ctx, companyId, toDay(occurredAt));
}

function buildWeeklyRows(
  daily: DailyRow[],
  pricing: PricingConfig | null,
): Array<{
  week_start: string;
  week_end: string;
  input_tokens: number;
  output_tokens: number;
  input_cost_usd: number | null;
  output_cost_usd: number | null;
  total_billed_usd: number | null;
}> {
  const buckets = new Map<
    string,
    {
      week_start: string;
      week_end: string;
      input_tokens: number;
      output_tokens: number;
      input_cost_usd: number;
      output_cost_usd: number;
    }
  >();

  for (const row of daily) {
    const start = isoWeekStart(new Date(row.day + "T00:00:00Z"));
    const key = fmtDay(start);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        week_start: key,
        week_end: fmtDay(isoWeekEnd(start)),
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
    .sort((a, b) => a.week_start.localeCompare(b.week_start))
    .map((b) => ({
      week_start: b.week_start,
      week_end: b.week_end,
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

async function buildWeeklyCsv(ctx: PluginContext, companyId: string, from: string, to: string): Promise<string> {
  const pricing = await loadPricing(ctx, companyId);
  const daily = await readDaily(ctx, companyId, from, to);
  const weekly = buildWeeklyRows(daily, pricing);
  const header =
    "week_start,week_end,input_tokens,output_tokens,input_cost_usd,output_cost_usd,total_billed_usd";
  const lines = weekly.map((w) =>
    [
      w.week_start,
      w.week_end,
      w.input_tokens,
      w.output_tokens,
      w.input_cost_usd ?? "",
      w.output_cost_usd ?? "",
      w.total_billed_usd ?? "",
    ].join(","),
  );
  return [header, ...lines].join("\n") + "\n";
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

    ctx.actions.register("getDailyUsage", async (params) => {
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

    ctx.actions.register("getWeeklySummary", async (params) => {
      const companyId = String(params.companyId ?? "");
      const from = String(params.from ?? "");
      const to = String(params.to ?? "");
      if (!companyId || !from || !to) throw new Error("companyId, from, to are required");
      const pricing = await loadPricing(ctx, companyId);
      const daily = await readDaily(ctx, companyId, from, to);
      return {
        priced: !!pricing,
        rows: buildWeeklyRows(daily, pricing),
      };
    });

    ctx.actions.register("getPricing", async (params) => {
      const companyId = String(params.companyId ?? "");
      if (!companyId) throw new Error("companyId is required");
      const existing = await loadPricing(ctx, companyId);
      return {
        config: existing ?? DEFAULT_PRICING,
        seeded: !existing,
      };
    });

    ctx.actions.register("setPricing", async (params) => {
      const companyId = String(params.companyId ?? "");
      const config = params.config as PricingConfig | undefined;
      if (!companyId || !config) throw new Error("companyId and config are required");
      const json = JSON.stringify(config);
      await ctx.db.execute(
        `INSERT INTO ${q(ctx, "pricing_config")} (company_id, json) VALUES ($1, $2)
         ON CONFLICT (company_id) DO UPDATE SET json = EXCLUDED.json`,
        [companyId, json],
      );
      return { ok: true };
    });
  },

  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    if (input.routeKey !== "export-weekly-csv") {
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
    const csv = await buildWeeklyCsv(ctx, companyId, from, to);
    return {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="usage-${companyId}-${from}-${to}.csv"`,
      },
      body: csv,
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
