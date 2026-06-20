-- 2.0.0 — drop the dead pricing_config table. It was declared in 001_init
-- but never used at runtime; 0.7.0+ stored pricing in ctx.state and 2.0.0
-- moves it to pricing_config_history. Idempotent.

DROP TABLE IF EXISTS plugin_claude_token_cost_reports_c7ca204bbe.pricing_config;
