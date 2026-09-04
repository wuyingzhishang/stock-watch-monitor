CREATE TABLE IF NOT EXISTS app_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL DEFAULT 4,
  revision INTEGER NOT NULL DEFAULT 0,
  selected_shop_id TEXT,
  interval_minutes INTEGER NOT NULL DEFAULT 5,
  keep_last_stock INTEGER NOT NULL DEFAULT 1,
  notify_recovery INTEGER NOT NULL DEFAULT 1,
  notify_only_monitored INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shops (
  shop_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  custom_name INTEGER NOT NULL DEFAULT 0,
  url TEXT NOT NULL,
  shop_token TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  favorite INTEGER NOT NULL DEFAULT 0,
  remote_name TEXT,
  categories_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  shop_id TEXT NOT NULL,
  product_key TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '未分类',
  price REAL NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  monitored INTEGER NOT NULL DEFAULT 0,
  favorite INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, product_key),
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_products_monitored ON products(monitored, shop_id);
CREATE INDEX IF NOT EXISTS idx_products_shop_order ON products(shop_id, sort_order);

CREATE TABLE IF NOT EXISTS activity (
  activity_id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT,
  icon TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at DESC);

CREATE TABLE IF NOT EXISTS inventory_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT,
  product_key TEXT,
  product_name TEXT NOT NULL,
  message TEXT NOT NULL,
  tone TEXT NOT NULL DEFAULT 'red',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_inventory_events_created ON inventory_events(created_at DESC);

CREATE TABLE IF NOT EXISTS notification_log (
  notification_id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT,
  channel TEXT NOT NULL,
  message TEXT NOT NULL,
  success INTEGER NOT NULL DEFAULT 0,
  status_code INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (shop_id) REFERENCES shops(shop_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notification_log_created ON notification_log(created_at DESC);
