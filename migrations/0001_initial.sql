CREATE TABLE IF NOT EXISTS monitor_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  interval_minutes INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  last_run_at TEXT
);

CREATE TABLE IF NOT EXISTS monitor_rules (
  rule_id TEXT PRIMARY KEY,
  shop_name TEXT NOT NULL,
  shop_url TEXT NOT NULL,
  shop_token TEXT NOT NULL,
  product_key TEXT NOT NULL,
  product_name TEXT NOT NULL,
  notify_recovery INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS monitor_state (
  rule_id TEXT PRIMARY KEY,
  stock INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
