ALTER TABLE monitor_config ADD COLUMN config_hash TEXT;
ALTER TABLE monitor_config ADD COLUMN last_success_at TEXT;
ALTER TABLE monitor_config ADD COLUMN last_success_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE monitor_config ADD COLUMN ready_notified_at TEXT;
