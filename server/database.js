// =============================================================
// database.js
// Supabase client — single instance shared across the app.
// Tables:
//   players  (tiktok_id, username, nickname, total_xp, team)
//   xp_log   (player_id, event_type, xp_earned, creator, created_at)
// =============================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// -------------------------------------------------------
// Upsert a player (create or update username/nickname/team)
// -------------------------------------------------------
async function upsertPlayer(tiktokId, username, nickname, team = undefined) {
  const payload = {
    tiktok_id: tiktokId,
    username,
    nickname,
    updated_at: new Date().toISOString(),
  };

  if (team !== undefined && team !== null) {
    payload.team = team;
  }

  const { data, error } = await supabase
    .from('players')
    .upsert(payload, { onConflict: 'tiktok_id' })
    .select()
    .single();

  if (error) {
    console.error('[DB] upsertPlayer error:', error.message);
    return null;
  }
  return data;
}

// -------------------------------------------------------
// Add XP to a player
// -------------------------------------------------------
async function addXP(tiktokId, username, nickname, xpAmount, eventType, creatorUsername, team = undefined) {
  // Ensure player exists
  await upsertPlayer(tiktokId, username, nickname, team);

  // Increment XP using RPC
  const { error: rpcError } = await supabase.rpc('increment_xp', {
    p_tiktok_id: tiktokId,
    p_xp: xpAmount,
  });

  if (rpcError) {
    console.error('[DB] addXP RPC error:', rpcError.message);
    return;
  }

  // Log the event
  await supabase.from('xp_log').insert({
    tiktok_id: tiktokId,
    event_type: eventType,
    xp_earned: xpAmount,
    creator: creatorUsername,
    created_at: new Date().toISOString(),
  });
}

// -------------------------------------------------------
// Set team for a player
// -------------------------------------------------------
async function setPlayerTeam(tiktokId, username, nickname, team) {
  await upsertPlayer(tiktokId, username, nickname, team);
}

// -------------------------------------------------------
// Get top N players by total XP (global leaderboard)
// -------------------------------------------------------
async function getLeaderboard(limit = 10) {
  const { data, error } = await supabase
    .from('players')
    .select('username, nickname, total_xp, team')
    .order('total_xp', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[DB] getLeaderboard error:', error.message);
    return [];
  }
  return data;
}

// -------------------------------------------------------
// Get team scores (sum of XP per team)
// -------------------------------------------------------
async function getTeamScores() {
  const { data, error } = await supabase
    .from('players')
    .select('team, total_xp')
    .not('team', 'is', null);

  if (error) {
    console.error('[DB] getTeamScores error:', error.message);
    return { A: 0, B: 0, C: 0 };
  }

  const scores = { A: 0, B: 0, C: 0 };
  for (const row of data) {
    if (scores[row.team] !== undefined) {
      scores[row.team] += row.total_xp || 0;
    }
  }
  return scores;
}

// -------------------------------------------------------
// Get a single player by tiktok_id
// -------------------------------------------------------
async function getPlayer(tiktokId) {
  const { data, error } = await supabase
    .from('players')
    .select('*')
    .eq('tiktok_id', tiktokId)
    .single();

  if (error) return null;
  return data;
}

module.exports = {
  supabase,
  upsertPlayer,
  addXP,
  setPlayerTeam,
  getLeaderboard,
  getTeamScores,
  getPlayer,
};
