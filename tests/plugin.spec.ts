import { describe, it, expect } from "vitest";
import manifest from "../src/manifest";
import {
  isPlausibleFxRate,
  isIsoDate,
  csvCell,
  priceFor,
  slugifyForFilename,
  SUPPORTED_PROVIDERS,
} from "../src/worker";
import type { PricingConfig } from "../src/pricing";

// These tests cover the pure functions that carry the load-bearing math and
// shape decisions: pricing, slug rules, and CSV/FX/date guards. End-to-end
// behavior is verified via the worker bridge from the host CLI in CI; this
// file targets logic that doesn't require a worker harness.

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

// ---- Pricing math (free-form) --------------------------------------------

describe("priceFor (free-form)", () => {
  const cfg: PricingConfig = {
    pricing: {
      "claude-opus-4-6[1m]": { input: 5, output: 25 },
    },
    margin: { percent: 0 },
  };

  it("returns zero when raw_model has no rate row", () => {
    const { inputCost, outputCost } = priceFor("claude-opus-4-7[1m]", 1_000_000, 1_000_000, cfg);
    expect(inputCost).toBe(0);
    expect(outputCost).toBe(0);
  });

  it("computes cost via tokens / 1M × rate", () => {
    const { inputCost, outputCost } = priceFor("claude-opus-4-6[1m]", 2_000_000, 1_000_000, cfg);
    expect(inputCost).toBeCloseTo(10, 8);   // 2M × $5 = $10
    expect(outputCost).toBeCloseTo(25, 8);  // 1M × $25 = $25
  });

  it("applies effective_input_rate_multiplier to input only (Pro/Max subscription analog)", () => {
    const withMult: PricingConfig = {
      ...cfg,
      effective_input_rate_multiplier: 0.2, // ÷5
    };
    const { inputCost, outputCost } = priceFor("claude-opus-4-6[1m]", 2_000_000, 1_000_000, withMult);
    expect(inputCost).toBeCloseTo(2, 8);   // 10 × 0.2
    expect(outputCost).toBeCloseTo(25, 8); // unchanged
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

// ---- 2.x pricing primitives ----------------------------------------------

import {
  isValidPricingConfig,
  findActiveSnapshot,
  lookupRate,
  DEFAULT_SEED_PRICING,
  type PricingSnapshot,
  type RateRow,
} from "../src/pricing";

describe("isValidPricingConfig (free-form)", () => {
  it("accepts the seed config", () => {
    expect(isValidPricingConfig(DEFAULT_SEED_PRICING)).toBe(true);
  });

  it("accepts a config with zero rows (operator deleted everything)", () => {
    expect(isValidPricingConfig({ pricing: {}, margin: { percent: 0 } })).toBe(true);
  });

  it("accepts arbitrary operator-defined keys", () => {
    expect(isValidPricingConfig({
      pricing: { "some-future-model-xyz": { input: 1, output: 2 } },
      margin: { percent: 5 },
    })).toBe(true);
  });

  it("rejects non-numeric or negative rates", () => {
    expect(isValidPricingConfig({
      pricing: { "x": { input: -1, output: 2 } },
      margin: { percent: 0 },
    })).toBe(false);
    expect(isValidPricingConfig({
      pricing: { "x": { input: "5", output: 2 } as unknown as RateRow },
      margin: { percent: 0 },
    })).toBe(false);
    expect(isValidPricingConfig({
      pricing: { "x": { input: NaN, output: 2 } },
      margin: { percent: 0 },
    })).toBe(false);
  });

  it("rejects empty-string keys", () => {
    expect(isValidPricingConfig({
      pricing: { "": { input: 1, output: 2 } },
      margin: { percent: 0 },
    })).toBe(false);
  });

  it("rejects non-string display_name", () => {
    expect(isValidPricingConfig({
      pricing: { "x": { input: 1, output: 2, display_name: 5 } as unknown as RateRow },
      margin: { percent: 0 },
    })).toBe(false);
  });

  it("rejects margin.percent outside [0, 500] or NaN", () => {
    expect(isValidPricingConfig({ pricing: {}, margin: { percent: -1 } })).toBe(false);
    expect(isValidPricingConfig({ pricing: {}, margin: { percent: 501 } })).toBe(false);
    expect(isValidPricingConfig({ pricing: {}, margin: { percent: NaN } })).toBe(false);
  });

  it("rejects effective_input_rate_multiplier outside (0, 1]", () => {
    expect(isValidPricingConfig({
      pricing: {},
      margin: { percent: 0 },
      effective_input_rate_multiplier: 0,
    })).toBe(false);
    expect(isValidPricingConfig({
      pricing: {},
      margin: { percent: 0 },
      effective_input_rate_multiplier: 1.5,
    })).toBe(false);
    expect(isValidPricingConfig({
      pricing: {},
      margin: { percent: 0 },
      effective_input_rate_multiplier: 0.2,
    })).toBe(true);
  });
});

describe("findActiveSnapshot", () => {
  const mkSnap = (effective_from: string): PricingSnapshot => ({
    effective_from,
    config: { pricing: {}, margin: { percent: 0 } },
  });

  it("returns null when there are no snapshots", () => {
    expect(findActiveSnapshot([], "2026-04-01T00:00:00Z")).toBeNull();
  });

  it("returns the only snapshot in the N=1 case regardless of event time", () => {
    const one = mkSnap("2026-06-01T00:00:00Z");
    expect(findActiveSnapshot([one], "1990-01-01T00:00:00Z")).toBe(one);
    expect(findActiveSnapshot([one], "2030-01-01T00:00:00Z")).toBe(one);
  });

  it("returns the greatest effective_from <= occurredAt (snapshots sorted DESC)", () => {
    const april = mkSnap("2026-04-01T00:00:00Z");
    const june = mkSnap("2026-06-01T00:00:00Z");
    const dec = mkSnap("2026-12-01T00:00:00Z");
    const desc = [dec, june, april];
    expect(findActiveSnapshot(desc, "2026-04-15T00:00:00Z")).toBe(april);
    expect(findActiveSnapshot(desc, "2026-07-15T00:00:00Z")).toBe(june);
    expect(findActiveSnapshot(desc, "2026-12-15T00:00:00Z")).toBe(dec);
  });

  it("falls back to the earliest snapshot for events that predate all", () => {
    const april = mkSnap("2026-04-01T00:00:00Z");
    const june = mkSnap("2026-06-01T00:00:00Z");
    const desc = [june, april];
    expect(findActiveSnapshot(desc, "2025-01-01T00:00:00Z")).toBe(april);
  });
});

describe("lookupRate", () => {
  const snap: PricingSnapshot = {
    effective_from: "1970-01-01T00:00:00Z",
    config: {
      pricing: { "claude-opus-4-6[1m]": { input: 5, output: 25 } },
      margin: { percent: 0 },
    },
  };

  it("returns the row for an exact match", () => {
    expect(lookupRate(snap, "claude-opus-4-6[1m]")).toEqual({ input: 5, output: 25 });
  });

  it("returns undefined for an unmatched raw_model — no fuzzy fallback", () => {
    expect(lookupRate(snap, "claude-opus-4-7[1m]")).toBeUndefined();
    expect(lookupRate(snap, "claude-opus-4-6")).toBeUndefined();
    expect(lookupRate(snap, "")).toBeUndefined();
  });
});

