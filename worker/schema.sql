-- SABCO operations database (Cloudflare D1)

CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT NOT NULL,
  username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash            TEXT NOT NULL,
  salt                 TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('admin','engineer')),
  can_edit_stages      INTEGER NOT NULL DEFAULT 0,
  active               INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,           -- SHA-256 of the cookie token
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS projects (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL UNIQUE,
  color  TEXT NOT NULL DEFAULT '#185FA5',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS user_projects (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, project_id)
);

CREATE TABLE IF NOT EXISTS stages (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL UNIQUE,
  sort   INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS ops (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  created_at    TEXT NOT NULL,           -- ISO timestamp
  date          TEXT NOT NULL,           -- local day, YYYY-MM-DD
  stage         TEXT NOT NULL,           -- JSON array
  type          TEXT NOT NULL,           -- JSON array
  amount        REAL,
  amount_source TEXT,                    -- 'ai' | 'manual'
  thumb         TEXT                     -- JPEG data URL (~1000px)
);
CREATE INDEX IF NOT EXISTS ops_date ON ops(date);
CREATE INDEX IF NOT EXISTS ops_project ON ops(project_id);

INSERT OR IGNORE INTO projects (name, color) VALUES
  ('Ahmed Al Hosani', '#185FA5'),
  ('Al Khalidya', '#D9822B');

INSERT OR IGNORE INTO stages (name, sort) VALUES
  ('Substructure (Excavation + Foundation)', 1),
  ('Superstructure (Concrete + Columns + Slabs)', 2),
  ('Blockwork', 3),
  ('Plaster', 4),
  ('Finishing (Tiles + Paint + Ceiling + Joinery)', 5),
  ('MEP (Electrical + Plumbing + HVAC) manhole', 6),
  ('External Works (Interlock + Landscape)', 7),
  ('General waste collecting', 8);
