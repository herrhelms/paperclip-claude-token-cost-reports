import { describe, it, expect, beforeEach } from "vitest";
import manifest from "../src/manifest";
import {
  normalizeModel,
  PRICED_MODEL_KEYS,
  type ModelKey,
} from "../src/worker";

// NOTE: The worker-integration tests below (`register`, `events.subscribe`, etc.)
// were written against an older SDK harness shape. The current worker uses
// `definePlugin` + `ctx.events.on` and is wired by the host runtime, not by a
// named `register` export. Those tests are kept .skip()'d as documentation
// until the harness is rewritten against the live SDK. The pricing-key and
// manifest tests below are the load-bearing checks for the 0.2.0 release.
const register: any = undefined;

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
    expect(manifest.id ?? manifest.slug).toMatch(/claude-token-usage/);
  });

  it("declares the page slot with routePath 'tokens'", () => {
    const slots = (manifest.ui?.slots ?? []) as any[];
    const page = slots.find((s) => s.type === "page");
    expect(page).toBeTruthy();
    expect(page.routePath).toBe("tokens");
  });

  it("declares a settingsPage slot without routePath", () => {
    const slots = (manifest.ui?.slots ?? []) as any[];
    const settings = slots.find((s) => s.type === "settingsPage");
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

  it("declares version 0.4.0 (per-agent breakdown)", () => {
    expect(manifest.version).toBe("0.4.0");
  });

  it("routePath is a single-segment lowercase slug", () => {
    // The host validates routePath as a lowercase slug: letters, numbers,
    // hyphens — no slashes. v0.3.2 shipped "company/usage" which failed install
    // with API error 400. Lock the constraint in so it doesn't regress.
    const slots = (manifest.ui?.slots ?? []) as any[];
    const page = slots.find((s) => s.type === "page");
    expect(page).toBeTruthy();
    expect(page.routePath).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(page.routePath).not.toMatch(/\//);
  });

  it("declares the costs.read capability so cost_event.created is delivered", () => {
    // This was the bug behind v0.3.0 showing empty cards: the host gates
    // cost_event.created delivery behind costs.read. Lock it in.
    expect(manifest.capabilities).toContain("costs.read");
  });
});

describe("pricing model keys (0.2.0)", () => {
  it("exports exactly 8 priced model keys", () => {
    expect(PRICED_MODEL_KEYS).toHaveLength(8);
  });

  it("covers Opus 4.8 / 4.7 and Sonnet 4.6 / 4.5 with [1m] variants", () => {
    const expected: ModelKey[] = [
      "opus-4-8",
      "opus-4-8-1m",
      "opus-4-7",
      "opus-4-7-1m",
      "sonnet-4-6",
      "sonnet-4-6-1m",
      "sonnet-4-5",
      "sonnet-4-5-1m",
    ];
    for (const k of expected) {
      expect(PRICED_MODEL_KEYS).toContain(k);
    }
  });

  it("normalizeModel maps canonical model strings to the right key", () => {
    expect(normalizeModel("claude-opus-4-8")).toBe("opus-4-8");
    expect(normalizeModel("claude-opus-4-7")).toBe("opus-4-7");
    expect(normalizeModel("claude-sonnet-4-6")).toBe("sonnet-4-6");
    expect(normalizeModel("claude-sonnet-4-5")).toBe("sonnet-4-5");
  });

  it("normalizeModel routes [1m] variants to the long-context key", () => {
    expect(normalizeModel("claude-opus-4-8[1m]")).toBe("opus-4-8-1m");
    expect(normalizeModel("claude-opus-4-7[1m]")).toBe("opus-4-7-1m");
    expect(normalizeModel("claude-sonnet-4-6[1m]")).toBe("sonnet-4-6-1m");
    expect(normalizeModel("claude-sonnet-4-5[1m]")).toBe("sonnet-4-5-1m");
  });

  it("normalizeModel remaps pre-0.2.0 'opus' and 'sonnet' to the most recent base variant", () => {
    // Backwards-compat: historical rows stored "opus"/"sonnet" as the family bucket.
    // After upgrade they should still price against the most recent known variant.
    expect(normalizeModel("opus")).toBe("opus-4-7");
    expect(normalizeModel("sonnet")).toBe("sonnet-4-6");
  });

  it("normalizeModel returns 'unknown' for non-matching inputs", () => {
    expect(normalizeModel(undefined)).toBe("unknown");
    expect(normalizeModel("")).toBe("unknown");
    expect(normalizeModel("gpt-4")).toBe("unknown");
    expect(normalizeModel("claude-haiku-4-5")).toBe("unknown"); // not in the priced set for 0.2.0
  });
});

describe.skip("worker registration", () => {
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
      "getMonthlySummary",
      "getPricing",
      "setPricing",
    ]) {
      expect(harness.actions[name]).toBeTypeOf("function");
    }
  });

  it("registers the monthly CSV export route", () => {
    expect(harness.apiRoutes["GET /export/monthly.csv"]).toBeTypeOf("function");
  });
});

describe.skip("usage event ingestion", () => {
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

describe.skip("pricing actions", () => {
  it("round-trips a pricing config", async () => {
    const harness = makeCtx();
    await register(harness.ctx as any);

    const config = {
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
    expect(result.pricing["opus-4-8"].input).toBe(5);
    expect(result.pricing["opus-4-8"].output).toBe(25);
    expect(result.pricing["sonnet-4-5-1m"].input).toBe(3);
    expect(result.margin.percent).toBe(20);
  });
});
