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

const memoryStore = {
  players: {},
  xpLog: []
};

// -------------------------------------------------------
// Upsert a player (create or update username/nickname/team)
// -------------------------------------------------------
async function upsertPlayer(tiktokId, username, nickname, team = undefined) {
  if (!tiktokId) return null;

  // Initialize or update in-memory record
  if (!memoryStore.players[tiktokId]) {
    memoryStore.players[tiktokId] = {
      id: Date.now(),
      tiktok_id: tiktokId,
      username: username || String(tiktokId),
      nickname: nickname || username || String(tiktokId),
      total_xp: 0,
      team: team !== undefined ? team : null,
      updated_at: new Date().toISOString(),
    };
  } else {
    if (username) memoryStore.players[tiktokId].username = username;
    if (nickname) memoryStore.players[tiktokId].nickname = nickname;
    if (team !== undefined && team !== null) memoryStore.players[tiktokId].team = team;
    memoryStore.players[tiktokId].updated_at = new Date().toISOString();
  }

  const payload = {
    tiktok_id: tiktokId,
    username: username || String(tiktokId),
    nickname: nickname || username || String(tiktokId),
    updated_at: new Date().toISOString(),
  };

  if (team !== undefined && team !== null) {
    payload.team = team;
  }

  try {
    const { data, error } = await supabase
      .from('players')
      .upsert(payload, { onConflict: 'tiktok_id' })
      .select()
      .single();

    if (error) {
      return memoryStore.players[tiktokId];
    }
    if (data) {
      memoryStore.players[tiktokId] = { ...memoryStore.players[tiktokId], ...data };
    }
    return data || memoryStore.players[tiktokId];
  } catch (err) {
    return memoryStore.players[tiktokId];
  }
}

// -------------------------------------------------------
// Add XP to a player
// -------------------------------------------------------
async function addXP(tiktokId, username, nickname, xpAmount, eventType, creatorUsername, team = undefined) {
  if (!tiktokId) return;

  // Ensure player exists
  await upsertPlayer(tiktokId, username, nickname, team);

  // Accumulate XP in memory store
  if (memoryStore.players[tiktokId]) {
    memoryStore.players[tiktokId].total_xp = (memoryStore.players[tiktokId].total_xp || 0) + (xpAmount || 0);
  }

  memoryStore.xpLog.push({
    tiktok_id: tiktokId,
    event_type: eventType,
    xp_earned: xpAmount,
    creator: creatorUsername,
    created_at: new Date().toISOString(),
  });

  try {
    // Increment XP in Supabase using RPC
    const { error: rpcError } = await supabase.rpc('increment_xp', {
      p_tiktok_id: tiktokId,
      p_xp: xpAmount,
    });

    if (rpcError) {
      return;
    }

    // Log the event in Supabase
    await supabase.from('xp_log').insert({
      tiktok_id: tiktokId,
      event_type: eventType,
      xp_earned: xpAmount,
      creator: creatorUsername,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    // Remote connection issue caught gracefully; memory state is intact
  }
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
  try {
    const { data, error } = await supabase
      .from('players')
      .select('username, nickname, total_xp, team')
      .order('total_xp', { ascending: false })
      .limit(limit);

    if (!error && Array.isArray(data) && data.length > 0) {
      return data;
    }
  } catch (err) {
    // Fall back to memory store below
  }

  // Resilient memory fallback
  return Object.values(memoryStore.players)
    .map(p => ({
      username: p.username,
      nickname: p.nickname,
      total_xp: p.total_xp || 0,
      team: p.team || null,
    }))
    .sort((a, b) => b.total_xp - a.total_xp)
    .slice(0, limit);
}

// -------------------------------------------------------
// Get team scores (sum of XP per team)
// -------------------------------------------------------
async function getTeamScores() {
  try {
    const { data, error } = await supabase
      .from('players')
      .select('team, total_xp')
      .not('team', 'is', null);

    if (!error && Array.isArray(data)) {
      const scores = { A: 0, B: 0, C: 0 };
      for (const row of data) {
        if (scores[row.team] !== undefined) {
          scores[row.team] += row.total_xp || 0;
        }
      }
      return scores;
    }
  } catch (err) {
    // Fall back to memory store
  }

  // Resilient memory fallback
  const scores = { A: 0, B: 0, C: 0 };
  for (const p of Object.values(memoryStore.players)) {
    if (p.team && scores[p.team] !== undefined) {
      scores[p.team] += p.total_xp || 0;
    }
  }
  return scores;
}

// -------------------------------------------------------
// Get a single player by tiktok_id
// -------------------------------------------------------
async function getPlayer(tiktokId) {
  if (!tiktokId) return null;
  try {
    const { data, error } = await supabase
      .from('players')
      .select('*')
      .eq('tiktok_id', tiktokId)
      .single();

    if (!error && data) return data;
  } catch (err) {
    // Fall back to memory store
  }

  return memoryStore.players[tiktokId] || null;
}

module.exports = {
  supabase,
  memoryStore,
  upsertPlayer,
  addXP,
  setPlayerTeam,
  getLeaderboard,
  getTeamScores,
  getPlayer,
};
