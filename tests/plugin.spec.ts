import { describe, it, expect } from "vitest";
import manifest from "../src/manifest";
import {
  isPricingConfig,
  isPlausibleFxRate,
  isIsoDate,
  csvCell,
  normalizeModel,
  PRICED_MODEL_KEYS,
  priceFor,
  slugifyForFilename,
  subscriptionDivisor,
  SUBSCRIPTION_DIVISORS,
  SUPPORTED_PROVIDERS,
  upgradePricingConfig,
  type ModelKey,
  type PricingConfig,
} from "../src/worker";

// These tests cover the pure functions that carry the load-bearing math and
// shape decisions: pricing, normalization, model recognition, slug rules, and
// the subscription divisor. End-to-end behavior is verified via the worker
// bridge from the host CLI in CI; this file targets logic that doesn't
// require a worker harness.

// ---- Manifest sanity ------------------------------------------------------

describe("manifest", () => {
  it("declares apiVersion 1", () => {
    expect(manifest.apiVersion).toBe(1);
  });

  it("uses the expected slug", () => {
    expect(manifest.id).toMatch(/claude-token-cost-reports/);
  });

  it("declares the page slot with routePath 'monthly-report-claude'", () => {
    const slots = (manifest.ui?.slots ?? []) as Array<{
      type: string;
      routePath?: string;
    }>;
    const page = slots.find((s) => s.type === "page");
    expect(page).toBeTruthy();
    expect(page?.routePath).toBe("monthly-report-claude");
  });

  it("declares a settingsPage slot without routePath", () => {
    const slots = (manifest.ui?.slots ?? []) as Array<{
      type: string;
      routePath?: string;
    }>;
    const settings = slots.find((s) => s.type === "settingsPage");
    expect(settings).toBeTruthy();
    expect(settings?.routePath).toBeUndefined();
  });

  it("routePath is a single-segment lowercase slug", () => {
    const slots = (manifest.ui?.slots ?? []) as Array<{
      type: string;
      routePath?: string;
    }>;
    const page = slots.find((s) => s.type === "page");
    expect(page?.routePath).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(page?.routePath).not.toMatch(/\//);
  });

  it("declares all capabilities the worker actually exercises", () => {
    const caps = manifest.capabilities ?? [];
    for (const required of [
      "events.subscribe",
      "database.namespace.migrate",
      "database.namespace.read",
      "database.namespace.write",
      "api.routes.register",
      "ui.page.register",
      "plugin.state.read",
      "plugin.state.write",
      "jobs.schedule",
      "instance.settings.register",
      "costs.read",
      "agents.read",
      "http.outbound",
      "companies.read",
    ]) {
      expect(caps).toContain(required);
    }
  });

  it("registers the daily rollup and FX fetcher jobs", () => {
    const jobs = (manifest.jobs ?? []) as Array<{ jobKey: string; schedule: string }>;
    expect(jobs.map((j) => j.jobKey)).toEqual(
      expect.arrayContaining(["rollup-daily", "fetch-fx-daily"]),
    );
  });

  it("registers cost_events as the only core-read table", () => {
    expect(manifest.database?.coreReadTables ?? []).toEqual(["cost_events"]);
  });
});

// ---- Model normalization --------------------------------------------------

describe("normalizeModel", () => {
  it("returns 'unknown' for non-strings", () => {
    expect(normalizeModel(undefined)).toBe("unknown");
    expect(normalizeModel(null)).toBe("unknown");
    expect(normalizeModel(42)).toBe("unknown");
  });

  it("preserves canonical priced keys verbatim", () => {
    for (const k of PRICED_MODEL_KEYS) {
      expect(normalizeModel(k)).toBe(k);
    }
  });

  it("remaps legacy bare-family keys to the most recent variant", () => {
    expect(normalizeModel("opus")).toBe("opus-4-7");
    expect(normalizeModel("sonnet")).toBe("sonnet-4-6");
  });

  it("derives version from common dot/dash/underscore-separated families", () => {
    expect(normalizeModel("claude-opus-4-8-20260101")).toBe("opus-4-8");
    expect(normalizeModel("Claude.Sonnet.4.6")).toBe("sonnet-4-6");
    expect(normalizeModel("opus_4_7")).toBe("opus-4-7");
  });

  it("detects the [1m] long-context marker", () => {
    expect(normalizeModel("claude-opus-4-8[1m]")).toBe("opus-4-8-1m");
    expect(normalizeModel("Opus 4.8 1m")).toBe("opus-4-8-1m");
    expect(normalizeModel("sonnet-4-6-1m")).toBe("sonnet-4-6-1m");
  });

  it("falls back to 'unknown' for models with no recognizable family", () => {
    expect(normalizeModel("haiku-4-0")).toBe("unknown");
    expect(normalizeModel("claude-instant")).toBe("unknown");
  });
});

// ---- Pricing math ---------------------------------------------------------

const FULL_PRICING: PricingConfig = {
  pricing: {
    "opus-4-8": { input: 5, output: 25 },
    "opus-4-8-1m": { input: 5, output: 25 },
    "opus-4-7": { input: 5, output: 25 },
    "opus-4-7-1m": { input: 5, output: 25 },
    "sonnet-4-6": { input: 3, output: 15 },
    "sonnet-4-6-1m": { input: 3, output: 15 },
    "sonnet-4-5": { input: 3, output: 15 },
    "sonnet-4-5-1m": { input: 3, output: 15 },
  },
  margin: { percent: 0 },
  subscription: { preset: "off", divisor: 1 },
};

describe("priceFor", () => {
  it("returns zero for 'unknown' model regardless of tokens", () => {
    const { inputCost, outputCost } = priceFor("unknown" as ModelKey, 1_000_000, 1_000_000, FULL_PRICING);
    expect(inputCost).toBe(0);
    expect(outputCost).toBe(0);
  });

  it("computes cost as tokens / 1M × rate", () => {
    const { inputCost, outputCost } = priceFor("opus-4-8", 2_000_000, 1_000_000, FULL_PRICING);
    expect(inputCost).toBeCloseTo(10, 8); // 2M × $5 = $10
    expect(outputCost).toBeCloseTo(25, 8); // 1M × $25 = $25
  });

  it("returns zero when a model is missing from the rate table", () => {
    const sparse = { ...FULL_PRICING, pricing: { ...FULL_PRICING.pricing } } as PricingConfig;
    delete (sparse.pricing as Record<string, unknown>)["opus-4-8"];
    const { inputCost, outputCost } = priceFor("opus-4-8", 1_000_000, 1_000_000, sparse);
    expect(inputCost).toBe(0);
    expect(outputCost).toBe(0);
  });
});

describe("subscriptionDivisor", () => {
  it("defaults to 1 when pricing or subscription is absent", () => {
    expect(subscriptionDivisor(null)).toBe(1);
    expect(subscriptionDivisor(undefined)).toBe(1);
    expect(subscriptionDivisor({ ...FULL_PRICING, subscription: undefined })).toBe(1);
  });

  it("returns 1 for 'off' even if divisor is set non-1", () => {
    const cfg: PricingConfig = {
      ...FULL_PRICING,
      subscription: { preset: "off", divisor: 99 },
    };
    expect(subscriptionDivisor(cfg)).toBe(1);
  });

  it("returns the per-preset divisor for pro and max", () => {
    const pro: PricingConfig = {
      ...FULL_PRICING,
      subscription: { preset: "pro", divisor: SUBSCRIPTION_DIVISORS.pro },
    };
    const max: PricingConfig = {
      ...FULL_PRICING,
      subscription: { preset: "max", divisor: SUBSCRIPTION_DIVISORS.max },
    };
    expect(subscriptionDivisor(pro)).toBe(5);
    expect(subscriptionDivisor(max)).toBe(20);
  });

  it("falls back to 1 when divisor is non-finite or non-positive", () => {
    const broken: PricingConfig = {
      ...FULL_PRICING,
      subscription: { preset: "max", divisor: -1 },
    };
    expect(subscriptionDivisor(broken)).toBe(1);
  });
});

describe("isPricingConfig", () => {
  it("accepts the canonical PricingConfig shape", () => {
    expect(isPricingConfig(FULL_PRICING)).toBe(true);
  });

  it("rejects partial pricing tables", () => {
    const partial = { ...FULL_PRICING, pricing: { "opus-4-8": { input: 5, output: 25 } } };
    expect(isPricingConfig(partial)).toBe(false);
  });

  it("rejects missing margin", () => {
    const noMargin = { ...FULL_PRICING } as Partial<PricingConfig>;
    delete noMargin.margin;
    expect(isPricingConfig(noMargin)).toBe(false);
  });

  it("tolerates missing subscription (legacy pre-0.7.0 configs)", () => {
    const noSub = { ...FULL_PRICING } as PricingConfig;
    delete noSub.subscription;
    expect(isPricingConfig(noSub)).toBe(true);
  });
});

describe("upgradePricingConfig", () => {
  it("returns a copy of DEFAULT_PRICING for arbitrary garbage", () => {
    const out = upgradePricingConfig({ random: "garbage" });
    expect(out.pricing["opus-4-8"]).toEqual({ input: 5, output: 25 });
    expect(out.margin).toEqual({ percent: 0 });
  });

  it("carries forward legacy bare opus/sonnet keys to the most recent variant", () => {
    const legacy = {
      pricing: {
        opus: { input: 8, output: 40 },
        sonnet: { input: 4, output: 20 },
      },
      margin: { percent: 12 },
    };
    const out = upgradePricingConfig(legacy);
    expect(out.pricing["opus-4-7"]).toEqual({ input: 8, output: 40 });
    expect(out.pricing["sonnet-4-6"]).toEqual({ input: 4, output: 20 });
    expect(out.margin.percent).toBe(12);
  });

  it("does not clobber explicitly-set new keys with legacy ones", () => {
    const mixed = {
      pricing: {
        opus: { input: 99, output: 99 },
        "opus-4-7": { input: 7, output: 35 },
      },
      margin: { percent: 0 },
    };
    const out = upgradePricingConfig(mixed);
    // opus-4-7 was explicitly set, so the legacy `opus` mapping is ignored.
    expect(out.pricing["opus-4-7"]).toEqual({ input: 7, output: 35 });
  });
});

// ---- Filename slugger -----------------------------------------------------

describe("slugifyForFilename", () => {
  it("lowercases and replaces non-alphanumerics with hyphens", () => {
    expect(slugifyForFilename("Alarm-Direct Social")).toBe("alarm-direct-social");
    expect(slugifyForFilename("Acme & Co.")).toBe("acme-co");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugifyForFilename("  ¡¡Hello!! ")).toBe("hello");
  });

  it("collapses repeated separators", () => {
    expect(slugifyForFilename("foo___bar...baz   qux")).toBe("foo-bar-baz-qux");
  });

  it("caps the result at 40 chars", () => {
    const long = "a".repeat(80);
    expect(slugifyForFilename(long)).toHaveLength(40);
  });

  it("returns an empty string when nothing survives", () => {
    expect(slugifyForFilename("////")).toBe("");
    expect(slugifyForFilename("")).toBe("");
  });
});

describe("SUPPORTED_PROVIDERS filter", () => {
  it("accepts 'anthropic' and 'claude'", () => {
    expect(SUPPORTED_PROVIDERS.has("anthropic")).toBe(true);
    expect(SUPPORTED_PROVIDERS.has("claude")).toBe(true);
  });

  it("rejects sibling provider strings", () => {
    expect(SUPPORTED_PROVIDERS.has("openai")).toBe(false);
    expect(SUPPORTED_PROVIDERS.has("gemini")).toBe(false);
    expect(SUPPORTED_PROVIDERS.has("")).toBe(false);
  });
});

describe("isIsoDate", () => {
  it("accepts canonical YYYY-MM-DD", () => {
    expect(isIsoDate("2026-06-20")).toBe(true);
    expect(isIsoDate("2000-01-01")).toBe(true);
  });

  it("rejects non-strings", () => {
    expect(isIsoDate(undefined)).toBe(false);
    expect(isIsoDate(null)).toBe(false);
    expect(isIsoDate(20260620)).toBe(false);
  });

  it("rejects shapes that aren't YYYY-MM-DD", () => {
    expect(isIsoDate("")).toBe(false);
    expect(isIsoDate("2026/06/20")).toBe(false);
    expect(isIsoDate("26-06-20")).toBe(false);
    expect(isIsoDate("2026-6-20")).toBe(false);
  });

  it("rejects values containing quotes or CRLF (header-injection vector)", () => {
    expect(isIsoDate('2026-06-20"')).toBe(false);
    expect(isIsoDate("2026-06-20\r\nX-Foo: bar")).toBe(false);
    expect(isIsoDate("2026-06-20\nA")).toBe(false);
  });
});

describe("csvCell", () => {
  it("returns values unchanged when they contain no special chars", () => {
    expect(csvCell("hello")).toBe("hello");
    expect(csvCell(42)).toBe("42");
    expect(csvCell("EUR")).toBe("EUR");
  });

  it("quotes and escapes when value contains a comma", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
  });

  it("quotes and doubles internal quotes", () => {
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
  });

  it("quotes when value contains CR or LF", () => {
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("line1\rline2")).toBe('"line1\rline2"');
  });
});

describe("isPlausibleFxRate", () => {
  it("accepts realistic rates", () => {
    expect(isPlausibleFxRate(0.92)).toBe(true); // USD->EUR
    expect(isPlausibleFxRate(0.79)).toBe(true); // USD->GBP
    expect(isPlausibleFxRate(157.4)).toBe(true); // USD->JPY
  });

  it("rejects rates that are zero, negative, or NaN", () => {
    expect(isPlausibleFxRate(0)).toBe(false);
    expect(isPlausibleFxRate(-1.2)).toBe(false);
    expect(isPlausibleFxRate(NaN)).toBe(false);
    expect(isPlausibleFxRate(Infinity)).toBe(false);
    expect(isPlausibleFxRate(-Infinity)).toBe(false);
  });

  it("rejects rates outside the sanity envelope", () => {
    expect(isPlausibleFxRate(0.001)).toBe(false);
    expect(isPlausibleFxRate(10_000)).toBe(false);
    expect(isPlausibleFxRate(1_000_000)).toBe(false);
  });

  it("rejects non-numbers", () => {
    expect(isPlausibleFxRate("0.92")).toBe(false);
    expect(isPlausibleFxRate(undefined)).toBe(false);
    expect(isPlausibleFxRate(null)).toBe(false);
  });
});

describe("isPricingConfig margin bounds", () => {
  // Helper to build a known-valid config with a custom margin
  const buildConfig = (marginPercent: unknown): unknown => ({
    pricing: Object.fromEntries(
      PRICED_MODEL_KEYS.map((k) => [k, { input: 1, output: 2 }]),
    ),
    margin: { percent: marginPercent },
  });

  it("accepts margin.percent of 0", () => {
    expect(isPricingConfig(buildConfig(0))).toBe(true);
  });

  it("accepts margin.percent of 500 (boundary)", () => {
    expect(isPricingConfig(buildConfig(500))).toBe(true);
  });

  it("rejects margin.percent of NaN", () => {
    expect(isPricingConfig(buildConfig(NaN))).toBe(false);
  });

  it("rejects negative margin.percent", () => {
    expect(isPricingConfig(buildConfig(-1))).toBe(false);
    expect(isPricingConfig(buildConfig(-50))).toBe(false);
  });

  it("rejects margin.percent above the 500 cap", () => {
    expect(isPricingConfig(buildConfig(501))).toBe(false);
    expect(isPricingConfig(buildConfig(1000))).toBe(false);
    expect(isPricingConfig(buildConfig(1e308))).toBe(false);
  });

  it("rejects Infinity margin.percent", () => {
    expect(isPricingConfig(buildConfig(Infinity))).toBe(false);
    expect(isPricingConfig(buildConfig(-Infinity))).toBe(false);
  });
});
