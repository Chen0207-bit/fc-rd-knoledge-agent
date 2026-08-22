CREATE TABLE IF NOT EXISTS papers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  authors TEXT NOT NULL DEFAULT '[]',
  abstract TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  pdf_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  library_state TEXT NOT NULL DEFAULT 'in' CHECK(library_state IN ('in','removed')),
  group_name TEXT NOT NULL DEFAULT '未分类',
  reviewer_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT,
  UNIQUE(source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_papers_status_created ON papers(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_papers_library_group ON papers(library_state, group_name);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT '未分类',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ip_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  source_refs TEXT NOT NULL DEFAULT '[]',
  markdown TEXT NOT NULL,
  model TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT '未分类',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
