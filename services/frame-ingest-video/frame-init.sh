#!/bin/sh
set -eu

database_path=/var/lib/sls/streams.db

if [ ! -f "$database_path" ] && [ -n "${SLS_API_KEY:-}" ]; then
  mkdir -p "$(dirname "$database_path")"
  key_hash=$(printf '%s' "$SLS_API_KEY" | sha256sum | awk '{print $1}')
  sqlite3 "$database_path" <<SQL
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS stream_ids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publisher TEXT NOT NULL,
  player TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(publisher, player)
);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  permissions TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used DATETIME,
  active BOOLEAN DEFAULT 1
);
CREATE TABLE IF NOT EXISTS access_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id INTEGER,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  response_code INTEGER,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
);
CREATE INDEX IF NOT EXISTS idx_stream_publisher ON stream_ids(publisher);
CREATE INDEX IF NOT EXISTS idx_stream_player ON stream_ids(player);
CREATE INDEX IF NOT EXISTS idx_api_key_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_access_logs_timestamp ON access_logs(timestamp);
INSERT INTO api_keys (key_hash, name, permissions)
VALUES ('$key_hash', 'FRAME Service Key', 'admin');
SQL
  chown -R 3001:3001 /var/lib/sls
  echo "[frame-ingest-video] Seeded deterministic SLS management key."
fi

exec "$@"
