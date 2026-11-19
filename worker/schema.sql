CREATE TABLE IF NOT EXISTS ops (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,          -- ISO timestamp
  date          TEXT NOT NULL,          -- local day, YYYY-MM-DD
  project       TEXT NOT NULL,
  stage         TEXT NOT NULL,          -- JSON array
  type          TEXT NOT NULL,          -- JSON array
  amount        REAL,
  amount_source TEXT,                   -- 'ai' | 'manual'
  thumb         TEXT                    -- small JPEG data URL
);
CREATE INDEX IF NOT EXISTS ops_date ON ops(date);
