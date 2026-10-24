-- =============================================================
-- Supabase SQL Setup — Sales Copilot
-- Run this once in the Supabase SQL Editor (safe to re-run).
-- Independent from supabase_setup.sql (game tables).
--
-- Every table has user_id so more users can be added later.
-- The server generates all ids (UUID).
--
-- Access: RLS is enabled with NO public policies, so the anon key
-- (which is not secret) cannot read this private data. Set
-- SUPABASE_SERVICE_ROLE_KEY on the server (Render env vars) — the
-- service role bypasses RLS. Without it, the copilot falls back to a
-- local JSON file (data/copilot-store.json), which the free Render
-- instance loses on every redeploy/restart.
-- =============================================================

-- 1. CONTEXT PROFILES (who I am, company, products, goals, tone)
CREATE TABLE IF NOT EXISTS copilot_contexts (
  id          UUID PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  text        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_copilot_contexts_user ON copilot_contexts(user_id, updated_at DESC);

-- 2. DOCUMENTS (extracted text of uploaded PDF / DOCX / TXT / MD)
CREATE TABLE IF NOT EXISTS copilot_documents (
  id          UUID PRIMARY KEY,
  user_id     TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  mime_type   TEXT,
  size_bytes  INT,
  char_count  INT,
  text        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_copilot_documents_user ON copilot_documents(user_id, created_at DESC);

-- 3. CONTACTS
CREATE TABLE IF NOT EXISTS copilot_contacts (
  id              UUID PRIMARY KEY,
  user_id         TEXT NOT NULL,
  name            TEXT NOT NULL,
  company         TEXT NOT NULL DEFAULT '',
  tags            JSONB NOT NULL DEFAULT '[]',   -- ["journalist","KOL",...]
  channels        JSONB NOT NULL DEFAULT '[]',   -- [{"channel":"LINE","handle":"@tammy"}]
  preferences     JSONB NOT NULL DEFAULT '{}',   -- {"language":"th","tone":"...","best_time":"..."}
  notes           TEXT NOT NULL DEFAULT '',
  follow_up_date  DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_copilot_contacts_user ON copilot_contacts(user_id, name);

-- 4. SESSIONS (live meetings: kind='meeting'; reply assistant drafts: kind='reply')
CREATE TABLE IF NOT EXISTS copilot_sessions (
  id           UUID PRIMARY KEY,
  user_id      TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'meeting',
  title        TEXT NOT NULL DEFAULT '',
  contact_id   UUID REFERENCES copilot_contacts(id) ON DELETE SET NULL,
  context_id   UUID,
  settings     JSONB NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'live',  -- live | ended
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at     TIMESTAMPTZ,
  transcript   JSONB NOT NULL DEFAULT '[]',
  summaries    JSONB NOT NULL DEFAULT '{}',
  suggestions  JSONB NOT NULL DEFAULT '[]',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_copilot_sessions_user ON copilot_sessions(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_copilot_sessions_contact ON copilot_sessions(contact_id);

-- 5. CONTACT EVENTS (birthday, wedding, illness, promotion, custom)
CREATE TABLE IF NOT EXISTS copilot_events (
  id          UUID PRIMARY KEY,
  user_id     TEXT NOT NULL,
  contact_id  UUID NOT NULL REFERENCES copilot_contacts(id) ON DELETE CASCADE,
  type        TEXT NOT NULL DEFAULT 'custom',
  label       TEXT NOT NULL DEFAULT '',
  date        DATE NOT NULL,                 -- birthday/wedding repeat every year
  note        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_copilot_events_user ON copilot_events(user_id, contact_id);

-- 6. MORNING SUMMARY SETTINGS (one row per brand / product / keyword / site / language)
CREATE TABLE IF NOT EXISTS copilot_monitor_keywords (
  id          UUID PRIMARY KEY,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,                 -- brand | product | keyword | site | language
  value       TEXT NOT NULL,
  brand       TEXT,                          -- optional: group a product/keyword under a brand
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_copilot_monitor_keywords_user ON copilot_monitor_keywords(user_id);

-- 7. MORNING SUMMARY REPORTS
CREATE TABLE IF NOT EXISTS copilot_monitor_reports (
  id           UUID PRIMARY KEY,
  user_id      TEXT NOT NULL,
  report_date  DATE NOT NULL,
  status       TEXT NOT NULL DEFAULT 'running',  -- running | done | error
  trigger      TEXT NOT NULL DEFAULT 'manual',   -- manual | auto
  groups       JSONB NOT NULL DEFAULT '[]',
  settings     JSONB NOT NULL DEFAULT '{}',
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_copilot_monitor_reports_user ON copilot_monitor_reports(user_id, report_date DESC);

-- 8. Row Level Security: on, no public policies (server uses the service role key)
ALTER TABLE copilot_contexts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE copilot_documents         ENABLE ROW LEVEL SECURITY;
ALTER TABLE copilot_contacts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE copilot_sessions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE copilot_events            ENABLE ROW LEVEL SECURITY;
ALTER TABLE copilot_monitor_keywords  ENABLE ROW LEVEL SECURITY;
ALTER TABLE copilot_monitor_reports   ENABLE ROW LEVEL SECURITY;
