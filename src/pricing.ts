// src/pricing.ts
//
// Pure pricing primitives — no SDK imports, no DB access, no I/O.
// Worker handlers compose these with ctx.db queries; tests import them
// directly. Type-level break from the 1.x ModelKey union: `model` is
// just `string` and `pricing` is keyed by any operator-supplied string.

export interface RateRow {
  input: number;          // USD per 1M input tokens
  output: number;         // USD per 1M output tokens
  display_name?: string;  // Optional UI label (e.g. "Opus 4.6 [1m]"); falls back to the key
}

export interface PricingConfig {
  pricing: Record<string, RateRow>;
  margin: { percent: number };
  // 1.x subscription preset becomes one knob. Default 1.0 = no adjustment.
  // ÷5 (Claude Pro) is set as 0.2; ÷20 (Claude Max) as 0.05.
  effective_input_rate_multiplier?: number;
}

export interface PricingSnapshot {
  effective_from: string;   // ISO 8601 UTC
  config: PricingConfig;
  created_at?: string;
  created_by?: string | null;
  note?: string | null;
}

// Verbose validator: returns the first error encountered as a human-
// readable string, or null when the config is valid. The worker uses
// this to throw precise errors for setPricing; isValidPricingConfig
// below is the type-guard wrapper for places that just need a boolean.
export function validatePricingConfig(v: unknown): string | null {
  if (!v || typeof v !== "object") {
    return "config must be an object";
  }
  const c = v as Record<string, unknown>;
  const p = c.pricing as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") {
    return "config.pricing must be an object (the rate-row table)";
  }
  for (const [key, row] of Object.entries(p)) {
    if (typeof key !== "string" || key.length === 0) {
      return `row key must be a non-empty string (got ${JSON.stringify(key)})`;
    }
    if (!row || typeof row !== "object") {
      return `row '${key}': value must be an object with input + output rates`;
    }
    const r = row as Record<string, unknown>;
    if (typeof r.input !== "number" || !Number.isFinite(r.input)) {
      return `row '${key}': input must be a finite number (got ${JSON.stringify(r.input)})`;
    }
    if (r.input < 0) {
      return `row '${key}': input must be >= 0 (got ${r.input})`;
    }
    if (typeof r.output !== "number" || !Number.isFinite(r.output)) {
      return `row '${key}': output must be a finite number (got ${JSON.stringify(r.output)})`;
    }
    if (r.output < 0) {
      return `row '${key}': output must be >= 0 (got ${r.output})`;
    }
    if (r.display_name !== undefined && typeof r.display_name !== "string") {
      return `row '${key}': display_name must be a string when present`;
    }
  }
  const margin = c.margin as Record<string, unknown> | undefined;
  if (!margin) {
    return "margin object is required (e.g. { percent: 5 })";
  }
  if (typeof margin.percent !== "number" || !Number.isFinite(margin.percent)) {
    return `margin.percent must be a finite number (got ${JSON.stringify(margin.percent)})`;
  }
  if (margin.percent < 0 || margin.percent > 500) {
    return `margin.percent must be in [0, 500] (got ${margin.percent})`;
  }
  const mult = c.effective_input_rate_multiplier;
  if (mult !== undefined) {
    if (typeof mult !== "number" || !Number.isFinite(mult)) {
      return `effective_input_rate_multiplier must be a finite number when present (got ${JSON.stringify(mult)})`;
    }
    if (mult <= 0 || mult > 1) {
      return `effective_input_rate_multiplier must be in (0, 1] (got ${mult})`;
    }
  }
  return null;
}

// Free-form validator. No fixed key set — every row that exists is
// checked for { input: finite number >= 0, output: finite number >= 0,
// optional display_name: string }. Margin must be finite in [0, 500].
// Multiplier (if present) must be finite in (0, 1].
export function isValidPricingConfig(v: unknown): v is PricingConfig {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  const p = c.pricing as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") return false;
  for (const [key, row] of Object.entries(p)) {
    if (typeof key !== "string" || key.length === 0) return false;
    const r = row as Record<string, unknown>;
    if (typeof r.input !== "number" || !Number.isFinite(r.input) || r.input < 0) return false;
    if (typeof r.output !== "number" || !Number.isFinite(r.output) || r.output < 0) return false;
    if (r.display_name !== undefined && typeof r.display_name !== "string") return false;
  }
  const margin = c.margin as Record<string, unknown> | undefined;
  if (
    !margin ||
    typeof margin.percent !== "number" ||
    !Number.isFinite(margin.percent) ||
    margin.percent < 0 ||
    margin.percent > 500
  ) {
    return false;
  }
  const mult = c.effective_input_rate_multiplier;
  if (mult !== undefined) {
    if (typeof mult !== "number" || !Number.isFinite(mult) || mult <= 0 || mult > 1) return false;
  }
  return true;
}

// Find the snapshot whose effective_from is the greatest <= occurredAt.
// Falls back to the earliest snapshot if the event predates all of them
// (operator's best-available rate for very old events). Returns null only
// when the snapshots array is empty.
export function findActiveSnapshot(
  snapshots: ReadonlyArray<PricingSnapshot>,
  occurredAt: string,
): PricingSnapshot | null {
  if (snapshots.length === 0) return null;
  // Snapshots arrive sorted DESC by effective_from (Task 4's loader does this).
  // The first row whose effective_from <= occurredAt is the active one.
  for (const s of snapshots) {
    if (s.effective_from <= occurredAt) return s;
  }
  return snapshots[snapshots.length - 1]; // earliest fallback
}

// Look up the rate for a raw_model in a snapshot's pricing table.
// Returns undefined when the model has no row — caller treats as unpriceable.
export function lookupRate(snapshot: PricingSnapshot, rawModel: string): RateRow | undefined {
  return snapshot.config.pricing[rawModel];
}

// Default seed pricing for a fresh install. Operators can edit/add/delete
// any row after install. Rates fetched from
// platform.claude.com/docs/en/about-claude/pricing on 2026-06-20.
// Keys mirror the host's emitted strings rather than the 1.x normalized form.
export const DEFAULT_SEED_PRICING: PricingConfig = {
  pricing: {
    "claude-opus-4-8":      { input: 5, output: 25, display_name: "Opus 4.8" },
    "claude-opus-4-8[1m]":  { input: 5, output: 25, display_name: "Opus 4.8 [1m]" },
    "claude-opus-4-7":      { input: 5, output: 25, display_name: "Opus 4.7" },
    "claude-opus-4-7[1m]":  { input: 5, output: 25, display_name: "Opus 4.7 [1m]" },
    "claude-opus-4-6":      { input: 5, output: 25, display_name: "Opus 4.6" },
    "claude-opus-4-6[1m]":  { input: 5, output: 25, display_name: "Opus 4.6 [1m]" },
    "claude-opus-4-5":      { input: 5, output: 25, display_name: "Opus 4.5" },
    "claude-sonnet-4-6":    { input: 3, output: 15, display_name: "Sonnet 4.6" },
    "claude-sonnet-4-6[1m]": { input: 3, output: 15, display_name: "Sonnet 4.6 [1m]" },
    "claude-sonnet-4-5":    { input: 3, output: 15, display_name: "Sonnet 4.5" },
    "claude-sonnet-4-5[1m]": { input: 3, output: 15, display_name: "Sonnet 4.5 [1m]" },
    "claude-haiku-4-5":     { input: 1, output: 5,  display_name: "Haiku 4.5" },
  },
  margin: { percent: 0 },
  effective_input_rate_multiplier: 1,
};
