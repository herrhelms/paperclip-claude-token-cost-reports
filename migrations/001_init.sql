-- claude-token-usage — initial schema.
-- The host runs this in the plugin's private namespace
-- `plugin_claude_token_usage_1a4b97362d`
-- (derived from `plugin_<slug>_<sha256(id)[0:10]>` for id `claude-token-usage`).
-- All object refs must be fully qualified with that schema name.

CREATE TABLE plugin_claude_token_usage_1a4b97362d.usage_events (
  source_event_id TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  agent_id        TEXT,
  model           TEXT NOT NULL,
  input_tokens    BIGINT NOT NULL DEFAULT 0,
  output_tokens   BIGINT NOT NULL DEFAULT 0,
  occurred_at     TIMESTAMPTZ NOT NULL,
  day             TEXT NOT NULL
);

CREATE INDEX usage_events_company_day_idx
  ON plugin_claude_token_usage_1a4b97362d.usage_events (company_id, day);

CREATE INDEX usage_events_day_idx
  ON plugin_claude_token_usage_1a4b97362d.usage_events (day);

CREATE TABLE plugin_claude_token_usage_1a4b97362d.usage_daily (
  company_id     TEXT NOT NULL,
  day            TEXT NOT NULL,
  model          TEXT NOT NULL,
  input_tokens   BIGINT NOT NULL DEFAULT 0,
  output_tokens  BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, day, model)
);

CREATE INDEX usage_daily_company_idx
  ON plugin_claude_token_usage_1a4b97362d.usage_daily (company_id, day);

CREATE TABLE plugin_claude_token_usage_1a4b97362d.pricing_config (
  company_id TEXT PRIMARY KEY,
  json       TEXT NOT NULL
);
