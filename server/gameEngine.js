// =============================================================
// gameEngine.js
// Core game logic — receives normalized events from the
// TikTok Connector and decides what happens in the game.
// Completely decoupled from TikTok API.
// =============================================================

const db = require('./database');

// XP awarded per event type
const XP_RULES = {
  comment: 2,
  gift_per_coin: 1,   // 1 XP per TikTok coin
  like: 0,            // likes don't award XP in this POC
  join: 1,
};

// Keywords for team assignment (case-insensitive)
const TEAM_KEYWORDS = {
  A: ['a', 'team a', 'equipo a', '1'],
  B: ['b', 'team b', 'equipo b', '2'],
  C: ['c', 'team c', 'equipo c', '3'],
};

class GameEngine {
  constructor(io) {
    this.io = io;             // Socket.io instance to push updates
    this.isRunning = false;
    this.creatorUsername = null;
    this.playerCache = {};    // In-memory cache: { tiktokId: { username, team, xp } }
    this.teamScores = { A: 0, B: 0, C: 0 };
    this.broadcastInterval = null;
  }

  // -------------------------------------------------------
  // Start a game session for a creator
  // -------------------------------------------------------
  async start(creatorUsername) {
    this.creatorUsername = creatorUsername;
    this.isRunning = true;
    this.playerCache = {};

    // Load current team scores from DB
    this.teamScores = await db.getTeamScores();

    // Broadcast state every 2 seconds
    this.broadcastInterval = setInterval(() => this._broadcastState(), 2000);

    console.log(`[GameEngine] Session started for @${creatorUsername}`);
    this._broadcastState();
  }

  // -------------------------------------------------------
  // Stop the session
  // -------------------------------------------------------
  stop() {
    this.isRunning = false;
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }
    console.log('[GameEngine] Session stopped');
    this.io.emit('game:stopped');
  }

  // -------------------------------------------------------
  // Reset scores (does NOT wipe the DB — only resets in-memory scores)
  // -------------------------------------------------------
  reset() {
    this.teamScores = { A: 0, B: 0, C: 0 };
    this.playerCache = {};
    this._broadcastState();
    console.log('[GameEngine] Scores reset');
  }

  // -------------------------------------------------------
  // Handle incoming COMMENT event
  // -------------------------------------------------------
  async onComment({ userId, username, nickname, comment }) {
    try {
      if (!this.isRunning) {
        console.log(`[GameEngine] ⚠️ Comment ignored from @${username} ("${comment}") - Game not started`);
        return;
      }

      const normalizedComment = comment.trim().toLowerCase();

      // Check for team assignment
      const assignedTeam = this._detectTeam(normalizedComment);

      // Get or init player cache
      if (!this.playerCache[userId]) {
        const dbPlayer = await db.getPlayer(userId);
        this.playerCache[userId] = {
          username,
          nickname,
          team: dbPlayer?.team || null,
          xp: dbPlayer?.total_xp || 0,
        };
      }

      const player = this.playerCache[userId];

      // Assign or CHANGE team if detected
      if (assignedTeam && player.team !== assignedTeam) {
        player.team = assignedTeam;
        await db.setPlayerTeam(userId, username, nickname, assignedTeam);
        console.log(`[GameEngine] 🚩 @${username} (${nickname}) assigned to Team ${assignedTeam}`);
        this.io.emit('player:team_assigned', { username, nickname, team: assignedTeam });
      }

      // Award XP for commenting
      const xp = XP_RULES.comment;
      player.xp += xp;
      if (player.team) this.teamScores[player.team] += xp;

      await db.addXP(userId, username, nickname, xp, 'comment', this.creatorUsername, player.team);

      console.log(`[GameEngine] ✨ +${xp} XP awarded to @${username} (Total: ${player.xp} XP, Team: ${player.team || 'None'})`);

      // Notify clients of new comment
      this.io.emit('game:comment', {
        username,
        nickname,
        comment,
        team: player.team,
        xp: player.xp,
      });

      // Trigger instant broadcast
      this._broadcastState();
    } catch (err) {
      console.error('[GameEngine] onComment error:', err);
    }
  }


  // -------------------------------------------------------
  // Handle incoming GIFT event
  // -------------------------------------------------------
  async onGift({ userId, username, nickname, giftName, coins, repeatCount }) {
    if (!this.isRunning) return;

    const totalCoins = coins * repeatCount;
    const xp = totalCoins * XP_RULES.gift_per_coin;

    if (!this.playerCache[userId]) {
      const dbPlayer = await db.getPlayer(userId);
      this.playerCache[userId] = {
        username,
        nickname,
        team: dbPlayer?.team || null,
        xp: dbPlayer?.total_xp || 0,
      };
    }

    const player = this.playerCache[userId];
    player.xp += xp;
    if (player.team) this.teamScores[player.team] += xp;

    await db.addXP(userId, username, nickname, xp, `gift:${giftName}`, this.creatorUsername, player.team);

    console.log(`[GameEngine] @${username} sent ${giftName} x${repeatCount} (+${xp} XP)`);
    this.io.emit('game:gift', { username, nickname, giftName, coins: totalCoins, xp: player.xp, team: player.team });
    this._broadcastState();
  }

  // -------------------------------------------------------
  // Handle incoming JOIN event
  // -------------------------------------------------------
  async onJoin({ userId, username, nickname }) {
    if (!this.isRunning) return;

    if (!this.playerCache[userId]) {
      const dbPlayer = await db.getPlayer(userId);
      this.playerCache[userId] = {
        username,
        nickname,
        team: dbPlayer?.team || null,
        xp: dbPlayer?.total_xp || 0,
      };
      await db.addXP(userId, username, nickname, XP_RULES.join, 'join', this.creatorUsername, this.playerCache[userId]?.team);
    }

    this.io.emit('game:join', { username, nickname });
    this._broadcastState();
  }

  // -------------------------------------------------------
  // Detect team from a comment string
  // -------------------------------------------------------
  _detectTeam(comment) {
    const c = comment.trim().toLowerCase();

    // Single letter or number exact match
    if (c === 'a' || c === '1') return 'A';
    if (c === 'b' || c === '2') return 'B';
    if (c === 'c' || c === '3') return 'C';

    // Phrases
    if (c.includes('team a') || c.includes('equipo a') || c.includes('vamos a') || c.startsWith('a ') || c.endsWith(' a')) return 'A';
    if (c.includes('team b') || c.includes('equipo b') || c.includes('vamos b') || c.startsWith('b ') || c.endsWith(' b')) return 'B';
    if (c.includes('team c') || c.includes('equipo c') || c.includes('vamos c') || c.startsWith('c ') || c.endsWith(' c')) return 'C';

    return null;
  }

  // -------------------------------------------------------
  // Broadcast current game state to all connected clients
  // -------------------------------------------------------
  async _broadcastState() {
    const leaderboard = await db.getLeaderboard(10);
    const teamScores = await db.getTeamScores();
    this.teamScores = teamScores;

    this.io.emit('game:state', {
      isRunning: this.isRunning,
      teamScores,
      leaderboard,
    });
  }
}

module.exports = GameEngine;
