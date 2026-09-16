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
  flash_first_match: 250, // MVP bonus for first correct answer
  flash_correct_match: 100, // Standard correct answer
  flash_participation: 5,   // Participation XP
};

// Preset Flash Cards
const FLASH_PRESETS = [
  {
    id: 'serum_price',
    title: '🧴 Glow Skincare Serum',
    subtitle: 'Match the Official Live Stream Price!',
    image: '🧴',
    options: [
      { id: '1', text: '$15 USD' },
      { id: '2', text: '$25 USD (Official)' },
      { id: '3', text: '$35 USD' }
    ],
    correctOption: '2',
    durationSeconds: 15
  },
  {
    id: 'cyber_headset',
    title: '🎧 Cyber Neon RGB Headset',
    subtitle: 'Match the Mystery Edition Color!',
    image: '🎧',
    options: [
      { id: '1', text: 'Cyber Cyan' },
      { id: '2', text: 'Neon Purple' },
      { id: '3', text: 'Matrix Green' }
    ],
    correctOption: '1',
    durationSeconds: 15
  },
  {
    id: 'sneaker_year',
    title: '👟 Future Runner Edition',
    subtitle: 'Match the Global Launch Year!',
    image: '👟',
    options: [
      { id: '1', text: '2023 Edition' },
      { id: '2', text: '2025 Edition' },
      { id: '3', text: '2026 Edition' }
    ],
    correctOption: '2',
    durationSeconds: 15
  },
  {
    id: 'flash_trivia_math',
    title: '⚡ Speed Math Challenge',
    subtitle: 'What is: 18 + 17 = ?',
    image: '⚡',
    options: [
      { id: '1', text: '33' },
      { id: '2', text: '35' },
      { id: '3', text: '37' }
    ],
    correctOption: '2',
    durationSeconds: 12
  }
];

class GameEngine {
  constructor(io) {
    this.io = io;             // Socket.io instance to push updates
    this.isRunning = false;
    this.creatorUsername = null;
    this.playerCache = {};    // In-memory cache: { tiktokId: { username, team, xp } }
    this.teamScores = { A: 0, B: 0, C: 0 };
    this.broadcastInterval = null;

    // Flash & Match state
    this.currentFlashRound = null;
    this.flashTimer = null;
    this.revealTimeout = null;
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
    if (this.broadcastInterval) clearInterval(this.broadcastInterval);
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
    if (this.revealTimeout) {
      clearTimeout(this.revealTimeout);
      this.revealTimeout = null;
    }
    this.endFlashRound();
    console.log('[GameEngine] Session stopped');
    this.io.emit('game:stopped');
  }

  // -------------------------------------------------------
  // Reset scores
  // -------------------------------------------------------
  reset() {
    this.teamScores = { A: 0, B: 0, C: 0 };
    this.playerCache = {};
    if (this.revealTimeout) {
      clearTimeout(this.revealTimeout);
      this.revealTimeout = null;
    }
    this.endFlashRound();
    this._broadcastState();
    console.log('[GameEngine] Scores reset');
  }

  // -------------------------------------------------------
  // FLASH & MATCH ROUND CONTROLS
  // -------------------------------------------------------
  getFlashPresets() {
    return FLASH_PRESETS;
  }

  startFlashRound(customConfig = null) {
    if (this.flashTimer) {
      clearInterval(this.flashTimer);
      this.flashTimer = null;
    }
    if (this.revealTimeout) {
      clearTimeout(this.revealTimeout);
      this.revealTimeout = null;
    }

    this.isRunning = true;
    if (!this.broadcastInterval) {
      this.broadcastInterval = setInterval(() => this._broadcastState(), 2000);
    }

    const config = customConfig || FLASH_PRESETS[0];
    const duration = config.durationSeconds || 15;

    this.currentFlashRound = {
      id: config.id || `round_${Date.now()}`,
      title: config.title || '⚡ Flash & Match Round',
      subtitle: config.subtitle || 'Match the right option in chat (1, 2, or 3)!',
      image: config.image || '🎁',
      options: config.options || [
        { id: '1', text: 'Option 1' },
        { id: '2', text: 'Option 2' },
        { id: '3', text: 'Option 3' }
      ],
      correctOption: String(config.correctOption || '1').toUpperCase(),
      totalDuration: duration,
      timeLeft: duration,
      status: 'ACTIVE',
      startTime: Date.now(),
      answeredUsers: new Set(), // ANTI-SPAM: 1 answer per user per round
      firstWinner: null,
      correctCount: 0,
      totalParticipants: 0,
      stats: { '1': 0, '2': 0, '3': 0 }
    };

    console.log(`[FlashEngine] ⚡ Flash Round Started: "${this.currentFlashRound.title}" (Correct: ${this.currentFlashRound.correctOption}, Duration: ${duration}s)`);

    // Emit round start event to overlays & dashboard
    this.io.emit('flash:round_started', this.getFlashState());

    // Countdown loop
    this.flashTimer = setInterval(() => {
      if (!this.currentFlashRound || this.currentFlashRound.status !== 'ACTIVE') {
        clearInterval(this.flashTimer);
        this.flashTimer = null;
        return;
      }

      this.currentFlashRound.timeLeft--;
      this.io.emit('flash:tick', {
        timeLeft: this.currentFlashRound.timeLeft,
        totalDuration: this.currentFlashRound.totalDuration,
        stats: this.currentFlashRound.stats,
        totalParticipants: this.currentFlashRound.totalParticipants
      });

      if (this.currentFlashRound.timeLeft <= 0) {
        this.endFlashRound();
      }
    }, 1000);

    return this.getFlashState();
  }

  endFlashRound() {
    if (this.flashTimer) {
      clearInterval(this.flashTimer);
      this.flashTimer = null;
    }
    if (this.revealTimeout) {
      clearTimeout(this.revealTimeout);
      this.revealTimeout = null;
    }

    if (!this.currentFlashRound) return null;

    this.currentFlashRound.status = 'ENDED';
    const finalState = this.getFlashState();

    console.log(`[FlashEngine] 🏁 Flash Round Ended! First Winner: ${finalState.firstWinner?.nickname || 'None'} | Participants: ${finalState.totalParticipants}`);

    this.io.emit('flash:round_ended', finalState);
    this._broadcastState();

    // Cleanly transition to IDLE after 6 seconds of showing the correct reveal
    this.revealTimeout = setTimeout(() => {
      if (this.currentFlashRound && this.currentFlashRound.status === 'ENDED') {
        this.currentFlashRound = null;
        this.io.emit('flash:idle');
        this._broadcastState();
      }
      this.revealTimeout = null;
    }, 6000);

    return finalState;
  }

  getFlashState() {
    if (!this.currentFlashRound) {
      return { status: 'IDLE' };
    }
    return {
      id: this.currentFlashRound.id,
      title: this.currentFlashRound.title,
      subtitle: this.currentFlashRound.subtitle,
      image: this.currentFlashRound.image,
      options: this.currentFlashRound.options,
      correctOption: this.currentFlashRound.correctOption,
      totalDuration: this.currentFlashRound.totalDuration,
      timeLeft: this.currentFlashRound.timeLeft,
      status: this.currentFlashRound.status,
      firstWinner: this.currentFlashRound.firstWinner,
      correctCount: this.currentFlashRound.correctCount,
      totalParticipants: this.currentFlashRound.totalParticipants,
      stats: this.currentFlashRound.stats
    };
  }

  // -------------------------------------------------------
  // Handle incoming COMMENT event
  // -------------------------------------------------------
  async onComment({ userId, username, nickname, comment } = {}) {
    try {
      if (!userId) return;
      username = username || String(userId);
      nickname = nickname || username;
      const rawComment = (comment != null) ? String(comment) : '';

      const isFlashActive = (this.currentFlashRound && this.currentFlashRound.status === 'ACTIVE');
      if (!this.isRunning && !isFlashActive) {
        return;
      }

      // 1. Synchronous in-memory player cache (prevents async race conditions)
      if (!this.playerCache[userId]) {
        this.playerCache[userId] = {
          username,
          nickname,
          team: null,
          xp: 0,
        };
        // Reconcile with DB asynchronously without blocking current event tick
        db.getPlayer(userId).then(dbPlayer => {
          if (dbPlayer && this.playerCache[userId]) {
            if (dbPlayer.team && !this.playerCache[userId].team) {
              this.playerCache[userId].team = dbPlayer.team;
            }
            if (dbPlayer.total_xp > this.playerCache[userId].xp) {
              this.playerCache[userId].xp = dbPlayer.total_xp;
            }
          }
        }).catch(() => {});
      }

      const player = this.playerCache[userId];
      player.username = username;
      player.nickname = nickname;

      // 2. Team detection & assignment
      const assignedTeam = this._detectTeam(rawComment);
      if (assignedTeam && player.team !== assignedTeam) {
        player.team = assignedTeam;
        db.setPlayerTeam(userId, username, nickname, assignedTeam).catch(() => {});
        console.log(`[GameEngine] 🚩 @${username} (${nickname}) assigned to Team ${assignedTeam}`);
        this.io.emit('player:team_assigned', { username, nickname, team: assignedTeam });
      }

      // 3. Base participation XP
      let xpEarned = XP_RULES.comment;

      // 4. Flash & Match Round Evaluation (Synchronous to preserve arrival order)
      let flashResult = null;
      if (this.currentFlashRound && this.currentFlashRound.status === 'ACTIVE') {
        const detectedOption = this._detectFlashOption(rawComment);

        if (detectedOption) {
          // ANTI-SPAM: strictly 1 answer per user per round
          if (this.currentFlashRound.answeredUsers.has(userId)) {
            console.log(`[FlashEngine] 🛡️ Anti-Spam: Blocked duplicate round vote from @${username}`);
          } else {
            this.currentFlashRound.answeredUsers.add(userId);
            this.currentFlashRound.totalParticipants++;
            if (this.currentFlashRound.stats[detectedOption] !== undefined) {
              this.currentFlashRound.stats[detectedOption]++;
            }

            const isCorrect = (detectedOption === this.currentFlashRound.correctOption);

            if (isCorrect) {
              this.currentFlashRound.correctCount++;

              if (!this.currentFlashRound.firstWinner) {
                // FIRST MATCH MVP WINNER!
                this.currentFlashRound.firstWinner = {
                  userId,
                  username,
                  nickname,
                  team: player.team,
                  option: detectedOption
                };
                const matchXp = XP_RULES.flash_first_match;
                xpEarned += matchXp;

                console.log(`[FlashEngine] 🏆 FIRST MATCH! @${username} matched option [${detectedOption}] (+${matchXp} XP)`);

                this.io.emit('flash:first_match', {
                  username,
                  nickname,
                  team: player.team,
                  option: detectedOption,
                  bonusXp: matchXp,
                  roundTitle: this.currentFlashRound.title
                });
              } else {
                // Subsequent Correct Match
                const matchXp = XP_RULES.flash_correct_match;
                xpEarned += matchXp;

                console.log(`[FlashEngine] ✨ CORRECT MATCH: @${username} matched option [${detectedOption}] (+${matchXp} XP)`);

                this.io.emit('flash:correct_match', {
                  username,
                  nickname,
                  team: player.team,
                  option: detectedOption,
                  earnedXp: matchXp
                });
              }
            } else {
              // Incorrect answer (participation XP)
              xpEarned += XP_RULES.flash_participation;
              this.io.emit('flash:attempt', {
                username,
                nickname,
                team: player.team,
                option: detectedOption,
                isCorrect: false
              });
            }

            flashResult = { option: detectedOption, isCorrect };
          }
        }
      }

      // 5. Update local memory state
      player.xp += xpEarned;
      if (player.team && this.teamScores[player.team] !== undefined) {
        this.teamScores[player.team] += xpEarned;
      }

      // 6. DB persistence
      db.addXP(
        userId,
        username,
        nickname,
        xpEarned,
        flashResult ? `flash_${flashResult.isCorrect ? 'match' : 'try'}` : 'comment',
        this.creatorUsername,
        player.team
      ).catch(() => {});

      // 7. Notify clients
      this.io.emit('game:comment', {
        username,
        nickname,
        comment: rawComment,
        team: player.team,
        xp: player.xp,
        flashResult
      });

      this._broadcastState();
    } catch (err) {
      console.error('[GameEngine] onComment error:', err);
    }
  }

  // -------------------------------------------------------
  // Handle incoming GIFT event
  // -------------------------------------------------------
  async onGift({ userId, username, nickname, giftName, coins, repeatCount } = {}) {
    if (!this.isRunning || !userId) return;

    username = username || String(userId);
    nickname = nickname || username;
    const count = Number(repeatCount) || 1;
    const coinVal = Number(coins) || 0;
    const totalCoins = coinVal * count;
    const xp = totalCoins * XP_RULES.gift_per_coin;
    const name = giftName || 'Gift';

    if (!this.playerCache[userId]) {
      this.playerCache[userId] = {
        username,
        nickname,
        team: null,
        xp: 0,
      };
      db.getPlayer(userId).then(dbPlayer => {
        if (dbPlayer && this.playerCache[userId]) {
          if (dbPlayer.team && !this.playerCache[userId].team) {
            this.playerCache[userId].team = dbPlayer.team;
          }
          if (dbPlayer.total_xp > this.playerCache[userId].xp) {
            this.playerCache[userId].xp = dbPlayer.total_xp;
          }
        }
      }).catch(() => {});
    }

    const player = this.playerCache[userId];
    player.xp += xp;
    if (player.team && this.teamScores[player.team] !== undefined) {
      this.teamScores[player.team] += xp;
    }

    db.addXP(userId, username, nickname, xp, `gift:${name}`, this.creatorUsername, player.team).catch(() => {});

    console.log(`[GameEngine] @${username} sent ${name} x${count} (+${xp} XP)`);
    this.io.emit('game:gift', { username, nickname, giftName: name, coins: totalCoins, xp: player.xp, team: player.team });
    this._broadcastState();
  }

  // -------------------------------------------------------
  // Handle incoming JOIN event
  // -------------------------------------------------------
  async onJoin({ userId, username, nickname } = {}) {
    if (!this.isRunning || !userId) return;

    username = username || String(userId);
    nickname = nickname || username;

    if (!this.playerCache[userId]) {
      this.playerCache[userId] = {
        username,
        nickname,
        team: null,
        xp: 0,
      };
      db.addXP(userId, username, nickname, XP_RULES.join, 'join', this.creatorUsername, null).catch(() => {});
    }

    this.io.emit('game:join', { username, nickname });
    this._broadcastState();
  }

  // -------------------------------------------------------
  // SIMULATE CHAT MATCH TRAFFIC (FOR RECORDING DEMOS)
  // -------------------------------------------------------
  async simulateFlashChat(count = 6) {
    if (!this.currentFlashRound || this.currentFlashRound.status !== 'ACTIVE') {
      this.startFlashRound();
    }

    const demoUsers = [
      { id: 'sim_1', username: 'mimi_thailand', nickname: 'Mimi 🌸' },
      { id: 'sim_2', username: 'somchai_bkk', nickname: 'Somchai 🇹🇭' },
      { id: 'sim_3', username: 'lucas_stream', nickname: 'Lucas ⚡' },
      { id: 'sim_4', username: 'tammy_agency', nickname: 'Tammy 👑' },
      { id: 'sim_5', username: 'franco_dev', nickname: 'Franco 🎮' },
      { id: 'sim_6', username: 'alex_gamer', nickname: 'Alex 🚀' },
    ];

    const correct = this.currentFlashRound.correctOption;
    const optionsPool = ['1', '2', '3'];

    console.log(`[FlashEngine] 🎲 Simulating ${count} chat matches in real-time...`);

    for (let i = 0; i < Math.min(count, demoUsers.length); i++) {
      setTimeout(async () => {
        if (!this.currentFlashRound || this.currentFlashRound.status !== 'ACTIVE') return;
        const user = demoUsers[i];
        const chosen = (i === 1 || Math.random() < 0.6) ? correct : optionsPool[Math.floor(Math.random() * optionsPool.length)];
        
        await this.onComment({
          userId: user.id,
          username: user.username,
          nickname: user.nickname,
          comment: chosen
        });
      }, i * 650);
    }
  }

  // -------------------------------------------------------
  // Helper: Detect Flash Option from Comment (1/2/3 or A/B/C)
  // -------------------------------------------------------
  _detectFlashOption(comment) {
    if (comment == null) return null;
    const c = String(comment).trim().toLowerCase();
    if (c === '1' || c === 'a' || c.startsWith('1 ') || c.startsWith('a ') || c.includes('opcion 1') || c.includes('option 1')) return '1';
    if (c === '2' || c === 'b' || c.startsWith('2 ') || c.startsWith('b ') || c.includes('opcion 2') || c.includes('option 2')) return '2';
    if (c === '3' || c === 'c' || c.startsWith('3 ') || c.startsWith('c ') || c.includes('opcion 3') || c.includes('option 3')) return '3';
    return null;
  }

  // -------------------------------------------------------
  // Detect team from a comment string
  // -------------------------------------------------------
  _detectTeam(comment) {
    if (comment == null) return null;
    const c = String(comment).trim().toLowerCase();

    // Single letter or number exact match
    if (c === 'a' || c === 'team a' || c === 'equipo a') return 'A';
    if (c === 'b' || c === 'team b' || c === 'equipo b') return 'B';
    if (c === 'c' || c === 'team c' || c === 'equipo c') return 'C';

    // Phrases
    if (c.includes('team a') || c.includes('equipo a') || c.includes('vamos a')) return 'A';
    if (c.includes('team b') || c.includes('equipo b') || c.includes('vamos b')) return 'B';
    if (c.includes('team c') || c.includes('equipo c') || c.includes('vamos c')) return 'C';

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
      flashState: this.getFlashState()
    });
  }
}

module.exports = GameEngine;
