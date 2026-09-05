-- =============================================================
-- Supabase SQL Setup — TikTok Game POC
-- Run this in the Supabase SQL Editor
-- =============================================================

-- 1. PLAYERS TABLE
-- Stores every viewer that has interacted.
-- XP persists across streams and creators.
CREATE TABLE IF NOT EXISTS players (
  id           BIGSERIAL PRIMARY KEY,
  tiktok_id    TEXT UNIQUE NOT NULL,
  username     TEXT NOT NULL,
  nickname     TEXT,
  total_xp     INT NOT NULL DEFAULT 0,
  team         CHAR(1),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast leaderboard queries
CREATE INDEX IF NOT EXISTS idx_players_xp ON players(total_xp DESC);

-- 2. XP LOG TABLE
-- Records every XP event for auditing / history.
CREATE TABLE IF NOT EXISTS xp_log (
  id           BIGSERIAL PRIMARY KEY,
  tiktok_id    TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  xp_earned    INT NOT NULL,
  creator      TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_xp_log_tiktok_id ON xp_log(tiktok_id);

-- 3. RPC FUNCTION — Atomic XP increment
-- Called by the server to safely add XP without race conditions.
CREATE OR REPLACE FUNCTION increment_xp(p_tiktok_id TEXT, p_xp INT)
RETURNS VOID AS $$
BEGIN
  UPDATE players
  SET total_xp = total_xp + p_xp,
      updated_at = NOW()
  WHERE tiktok_id = p_tiktok_id;
END;
$$ LANGUAGE plpgsql;

-- 4. Enable Row Level Security (recommended)
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE xp_log ENABLE ROW LEVEL SECURITY;

-- Allow all reads (leaderboard is public)
CREATE POLICY "Allow read players" ON players FOR SELECT USING (true);
CREATE POLICY "Allow read xp_log" ON xp_log FOR SELECT USING (true);

-- Allow inserts and updates from the server (using anon key)
CREATE POLICY "Allow insert players" ON players FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow update players" ON players FOR UPDATE USING (true);
CREATE POLICY "Allow insert xp_log" ON xp_log FOR INSERT WITH CHECK (true);
