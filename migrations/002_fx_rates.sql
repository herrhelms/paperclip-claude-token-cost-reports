-- claude-token-usage — daily FX rates (USD -> target currency)
-- One row per (day, currency). Stored at fetch time; queried at render time so
-- changing margin or currency later doesn't require re-snapshotting history.

CREATE TABLE plugin_claude_token_usage_1a4b97362d.fx_rates (
  day        TEXT NOT NULL,
  currency   TEXT NOT NULL,
  rate       NUMERIC(20, 10) NOT NULL,
  source     TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (day, currency)
);

CREATE INDEX fx_rates_currency_day_idx
  ON plugin_claude_token_usage_1a4b97362d.fx_rates (currency, day DESC);
