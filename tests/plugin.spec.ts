import { describe, it, expect, beforeEach } from "vitest";
import manifest from "../src/manifest";
import { register } from "../src/worker";

type Handler = (event: any, ctx: any) => Promise<void> | void;
type ActionHandler = (input: any, ctx: any) => Promise<any> | any;
type ApiHandler = (req: any, ctx: any) => Promise<any> | any;

interface FakeRow {
  [key: string]: any;
}

class FakeDb {
  public tables: Record<string, FakeRow[]> = {
    usage_events: [],
    usage_daily: [],
    pricing_config: [],
  };
  public migrated = false;

  async migrate() {
    this.migrated = true;
  }

  async run(sql: string, params: any[] = []) {
    const lower = sql.toLowerCase();
    if (lower.includes("insert into usage_events")) {
      const [
        source_event_id,
        company_id,
        agent_id,
        model,
        input_tokens,
        output_tokens,
        occurred_at,
        day,
      ] = params;
      const exists = this.tables.usage_events.some(
        (r) => r.source_event_id === source_event_id,
      );
      if (exists) return { changes: 0 };
      this.tables.usage_events.push({
        source_event_id,
        company_id,
        agent_id,
        model,
        input_tokens,
        output_tokens,
        occurred_at,
        day,
      });
      return { changes: 1 };
    }
    if (lower.includes("delete from usage_daily")) {
      const [company_id, day] = params;
      this.tables.usage_daily = this.tables.usage_daily.filter(
        (r) => !(r.company_id === company_id && r.day === day),
      );
      return { changes: 1 };
    }
    if (lower.includes("insert into usage_daily")) {
      const [company_id, day, model, input_tokens, output_tokens] = params;
      this.tables.usage_daily.push({
        company_id,
        day,
        model,
        input_tokens,
        output_tokens,
      });
      return { changes: 1 };
    }
    if (lower.includes("insert into pricing_config")) {
      const [company_id, json] = params;
      this.tables.pricing_config = this.tables.pricing_config.filter(
        (r) => r.company_id !== company_id,
      );
      this.tables.pricing_config.push({ company_id, json });
      return { changes: 1 };
    }
    return { changes: 0 };
  }

  async all(sql: string, params: any[] = []) {
    const lower = sql.toLowerCase();
    if (lower.includes("from usage_events")) {
      const [company_id, day] = params;
      return this.tables.usage_events.filter(
        (r) =>
          (!company_id || r.company_id === company_id) &&
          (!day || r.day === day),
      );
    }
    if (lower.includes("from usage_daily")) {
      const [company_id, from, to] = params;
      return this.tables.usage_daily.filter(
        (r) =>
          r.company_id === company_id &&
          (!from || r.day >= from) &&
          (!to || r.day <= to),
      );
    }
    return [];
  }

  async get(sql: string, params: any[] = []) {
    const lower = sql.toLowerCase();
    if (lower.includes("from pricing_config")) {
      const [company_id] = params;
      return this.tables.pricing_config.find((r) => r.company_id === company_id);
    }
    return undefined;
  }
}

function makeCtx() {
  const db = new FakeDb();
  const events: Record<string, Handler> = {};
  const actions: Record<string, ActionHandler> = {};
  const apiRoutes: Record<string, ApiHandler> = {};
  const jobs: Record<string, { cron: string; handler: Handler }> = {};

  const ctx = {
    db,
    events: {
      subscribe: (name: string, fn: Handler) => {
        events[name] = fn;
      },
    },
    actions: {
      register: (name: string, fn: ActionHandler) => {
        actions[name] = fn;
      },
    },
    api: {
      register: (method: string, path: string, fn: ApiHandler) => {
        apiRoutes[`${method.toUpperCase()} ${path}`] = fn;
      },
    },
    jobs: {
      schedule: (name: string, cron: string, fn: Handler) => {
        jobs[name] = { cron, handler: fn };
      },
    },
    entities: {
      get: async () => null,
    },
    agents: {
      get: async () => null,
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };

  return { ctx, events, actions, apiRoutes, jobs, db };
}

describe("manifest", () => {
  it("declares apiVersion 1", () => {
    expect(manifest.apiVersion).toBe(1);
  });

  it("uses the expected slug", () => {
    expect(manifest.id ?? manifest.slug).toMatch(/hlmsvrs-token-usage/);
  });

  it("declares the page slot with routePath /usage", () => {
    const slots = manifest.surface ?? manifest.slots ?? [];
    const page = slots.find((s: any) => s.slot === "page");
    expect(page).toBeTruthy();
    expect(page.routePath).toBe("/usage");
  });

  it("declares a settingsPage slot without routePath", () => {
    const slots = manifest.surface ?? manifest.slots ?? [];
    const settings = slots.find((s: any) => s.slot === "settingsPage");
    expect(settings).toBeTruthy();
    expect(settings.routePath).toBeUndefined();
  });

  it("declares the capabilities the worker actually uses", () => {
    const caps = manifest.capabilities ?? [];
    for (const required of [
      "events.subscribe",
      "database.namespace.migrate",
      "database.namespace.read",
      "database.namespace.write",
      "api.routes.register",
      "ui.page.register",
      "plugin.state.write",
      "jobs.schedule",
    ]) {
      expect(caps).toContain(required);
    }
  });

  it("does not reference ctx.assets anywhere", () => {
    const text = JSON.stringify(manifest);
    expect(text).not.toMatch(/assets/);
  });
});

describe("worker registration", () => {
  let harness: ReturnType<typeof makeCtx>;

  beforeEach(async () => {
    harness = makeCtx();
    await register(harness.ctx as any);
  });

  it("subscribes to cost_event.created and agent.run.finished", () => {
    expect(harness.events["cost_event.created"]).toBeTypeOf("function");
    expect(harness.events["agent.run.finished"]).toBeTypeOf("function");
  });

  it("schedules a rollup-daily job on a */15 cron", () => {
    const job = harness.jobs["rollup-daily"];
    expect(job).toBeTruthy();
    expect(job.cron).toBe("*/15 * * * *");
  });

  it("registers the action handlers used by the UI", () => {
    for (const name of [
      "getDailyUsage",
      "getWeeklySummary",
      "getPricing",
      "setPricing",
    ]) {
      expect(harness.actions[name]).toBeTypeOf("function");
    }
  });

  it("registers the weekly CSV export route", () => {
    expect(harness.apiRoutes["GET /export/weekly.csv"]).toBeTypeOf("function");
  });
});

describe("usage event ingestion", () => {
  it("inserts one usage_events row per cost_event.created", async () => {
    const harness = makeCtx();
    await register(harness.ctx as any);

    await harness.events["cost_event.created"](
      {
        id: "evt-1",
        payload: {
          companyId: "co-1",
          agentId: "ag-1",
          model: "claude-opus",
          inputTokens: 1000,
          outputTokens: 500,
          occurredAt: "2026-06-13T10:00:00Z",
        },
      },
      harness.ctx as any,
    );

    expect(harness.db.tables.usage_events).toHaveLength(1);
    const row = harness.db.tables.usage_events[0];
    expect(row.company_id).toBe("co-1");
    expect(row.input_tokens).toBe(1000);
    expect(row.output_tokens).toBe(500);
    expect(row.day).toBe("2026-06-13");
  });

  it("is idempotent on duplicate source_event_id", async () => {
    const harness = makeCtx();
    await register(harness.ctx as any);

    const event = {
      id: "evt-dup",
      payload: {
        companyId: "co-1",
        agentId: "ag-1",
        model: "claude-sonnet",
        inputTokens: 10,
        outputTokens: 20,
        occurredAt: "2026-06-13T10:00:00Z",
      },
    };

    await harness.events["cost_event.created"](event, harness.ctx as any);
    await harness.events["cost_event.created"](event, harness.ctx as any);

    expect(harness.db.tables.usage_events).toHaveLength(1);
  });
});

describe("pricing actions", () => {
  it("round-trips a pricing config", async () => {
    const harness = makeCtx();
    await register(harness.ctx as any);

    const config = {
      pricing: {
        opus: { input: 15, output: 75 },
        sonnet: { input: 3, output: 15 },
        haiku: { input: 0.8, output: 4 },
      },
      margin: { percent: 20 },
    };

    await harness.actions.setPricing(
      { companyId: "co-1", config },
      harness.ctx as any,
    );

    const result = await harness.actions.getPricing(
      { companyId: "co-1" },
      harness.ctx as any,
    );

    expect(result).toBeTruthy();
    expect(result.pricing.opus.input).toBe(15);
    expect(result.margin.percent).toBe(20);
  });
});
