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
  guess_winner: 250,
  guess_top3: 100, 
  guess_participation: 5,
  blur_winner: 300,
  blur_participation: 5,
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

    // Guess the Weight state
    this.currentGuessRound = null;
    this.guessTimer = null;
    this.guessRevealTimeout = null;

    // Blur to Guess state
    this.currentBlurRound = null;
    this.blurTimer = null;
    this.blurRevealTimeout = null;

    // Active minigame mode
    this.activeMode = null; // 'flash' | 'guess' | 'blur' | null

    // LIVE Stream Mode: 'game' | 'attacker' | 'fortune'
    this.liveMode = 'game';

    // Fortune Teller state
    this.fortuneQueue = [];
    this.fortuneConfig = {
      apiKey: process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.CLAUDE_API_KEY || '',
      model: 'gpt-4o-mini',
      prompt: 'You are an intuitive, mystical numerology fortune teller on TikTok LIVE. Interpret the 5 chosen numbers and give a warm, insightful, inspiring reading answering the user question. IMPORTANT: Always respond in the EXACT same language as the viewer question (e.g. if the question is in Thai, reply in natural, polite Thai; if in English, reply in English). Keep it concise (2-3 sentences max), mysterious yet encouraging, so the host can easily read it out loud in real time.'
    };
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
    this.activeMode = null;
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }
    if (this.revealTimeout) {
      clearTimeout(this.revealTimeout);
      this.revealTimeout = null;
    }
    this.endFlashRound();
    if (this.guessTimer) clearInterval(this.guessTimer);
    if (this.guessRevealTimeout) clearTimeout(this.guessRevealTimeout);
    this.currentGuessRound = null;
    if (this.blurTimer) clearInterval(this.blurTimer);
    if (this.blurRevealTimeout) clearTimeout(this.blurRevealTimeout);
    this.currentBlurRound = null;
    console.log('[GameEngine] Session stopped');
    this.io.emit('game:stopped');
  }

  // -------------------------------------------------------
  // Reset scores
  // -------------------------------------------------------
  reset() {
    this.teamScores = { A: 0, B: 0, C: 0 };
    this.playerCache = {};
    this.activeMode = null;
    if (this.revealTimeout) {
      clearTimeout(this.revealTimeout);
      this.revealTimeout = null;
    }
    this.endFlashRound();
    if (this.guessTimer) clearInterval(this.guessTimer);
    if (this.guessRevealTimeout) clearTimeout(this.guessRevealTimeout);
    this.currentGuessRound = null;
    if (this.blurTimer) clearInterval(this.blurTimer);
    if (this.blurRevealTimeout) clearTimeout(this.blurRevealTimeout);
    this.currentBlurRound = null;
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

    // Cancel other modes
    if (this.guessTimer) clearInterval(this.guessTimer);
    if (this.guessRevealTimeout) clearTimeout(this.guessRevealTimeout);
    if (this.currentGuessRound) {
      this.currentGuessRound = null;
      this.io.emit('guess:idle');
    }
    if (this.blurTimer) clearInterval(this.blurTimer);
    if (this.blurRevealTimeout) clearTimeout(this.blurRevealTimeout);
    if (this.currentBlurRound) {
      this.currentBlurRound = null;
      this.io.emit('blur:idle');
    }
    this.activeMode = 'flash';

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
        if (this.activeMode === 'flash') this.activeMode = null;
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
  // GUESS THE WEIGHT ROUND CONTROLS
  // -------------------------------------------------------

  startGuessRound(customConfig = null) {
    if (this.guessTimer) clearInterval(this.guessTimer);
    if (this.guessRevealTimeout) clearTimeout(this.guessRevealTimeout);

    // Cancel other modes
    if (this.flashTimer) clearInterval(this.flashTimer);
    if (this.revealTimeout) clearTimeout(this.revealTimeout);
    if (this.currentFlashRound) {
      this.currentFlashRound = null;
      this.io.emit('flash:idle');
    }
    if (this.blurTimer) clearInterval(this.blurTimer);
    if (this.blurRevealTimeout) clearTimeout(this.blurRevealTimeout);
    if (this.currentBlurRound) {
      this.currentBlurRound = null;
      this.io.emit('blur:idle');
    }
    this.activeMode = 'guess';

    this.isRunning = true;
    if (!this.broadcastInterval) {
      this.broadcastInterval = setInterval(() => this._broadcastState(), 2000);
    }

    const duration = customConfig?.durationSeconds || 60;

    this.currentGuessRound = {
      title: customConfig?.title || 'Guess the Weight',
      subtitle: customConfig?.subtitle || 'Guess the exact number!',
      correctAnswer: customConfig?.correctAnswer || 150,
      status: 'ACTIVE',
      guesses: new Map(),
      totalDuration: duration,
      timeLeft: duration,
      winner: null,
      topGuessers: []
    };

    this.io.emit('guess:round_started', this.getGuessState());

    this.guessTimer = setInterval(() => {
      if (!this.currentGuessRound || this.currentGuessRound.status !== 'ACTIVE') {
        clearInterval(this.guessTimer);
        this.guessTimer = null;
        return;
      }
      this.currentGuessRound.timeLeft--;
      this.io.emit('guess:tick', {
        timeLeft: this.currentGuessRound.timeLeft,
        totalDuration: this.currentGuessRound.totalDuration,
        totalGuesses: this.currentGuessRound.guesses.size
      });

      if (this.currentGuessRound.timeLeft <= 0) {
        clearInterval(this.guessTimer);
        this.guessTimer = null;
      }
    }, 1000);

    return this.getGuessState();
  }

  lockGuessRound() {
    if (this.guessTimer) clearInterval(this.guessTimer);
    this.guessTimer = null;
    if (this.currentGuessRound) {
      this.currentGuessRound.status = 'LOCKED';
      this.io.emit('guess:locked', this.getGuessState());
    }
    return this.getGuessState();
  }

  revealGuessResult() {
    if (!this.currentGuessRound) return this.getGuessState();
    
    this.currentGuessRound.status = 'REVEALED';
    
    const allGuesses = Array.from(this.currentGuessRound.guesses.values());
    const correct = this.currentGuessRound.correctAnswer;
    
    allGuesses.sort((a, b) => {
      const diffA = Math.abs(a.guess - correct);
      const diffB = Math.abs(b.guess - correct);
      if (diffA === diffB) return a.timestamp - b.timestamp;
      return diffA - diffB;
    });

    const winner = allGuesses[0] || null;
    const top3 = allGuesses.slice(1, 4);

    this.currentGuessRound.winner = winner;
    this.currentGuessRound.topGuessers = top3;

    allGuesses.forEach(g => {
      let xp = XP_RULES.guess_participation;
      if (g === winner) xp = XP_RULES.guess_winner;
      else if (top3.includes(g)) xp = XP_RULES.guess_top3;
      g.xpAwarded = xp;
      
      db.addXP(g.userId || null, g.username, g.nickname, xp, 'guess_game', this.creatorUsername, g.team).catch(() => {});
      
      // Update cache and scores
      const uid = g.userId || Object.keys(this.playerCache).find(k => this.playerCache[k].username === g.username);
      if (uid && this.playerCache[uid]) {
        this.playerCache[uid].xp += xp;
        if (this.playerCache[uid].team && this.teamScores[this.playerCache[uid].team] !== undefined) {
          this.teamScores[this.playerCache[uid].team] += xp;
        }
      }
    });

    const finalState = this.getGuessState();
    this.io.emit('guess:revealed', finalState);

    this.guessRevealTimeout = setTimeout(() => {
      if (this.currentGuessRound && this.currentGuessRound.status === 'REVEALED') {
        this.currentGuessRound = null;
        if (this.activeMode === 'guess') this.activeMode = null;
        this.io.emit('guess:idle');
        this._broadcastState();
      }
      this.guessRevealTimeout = null;
    }, 8000);

    return finalState;
  }

  getGuessState() {
    if (!this.currentGuessRound) return { status: 'IDLE' };
    
    const state = {
      title: this.currentGuessRound.title,
      subtitle: this.currentGuessRound.subtitle,
      status: this.currentGuessRound.status,
      totalDuration: this.currentGuessRound.totalDuration,
      timeLeft: this.currentGuessRound.timeLeft,
      totalGuesses: this.currentGuessRound.guesses.size,
      winner: this.currentGuessRound.winner,
      topGuessers: this.currentGuessRound.topGuessers
    };

    if (this.currentGuessRound.status === 'REVEALED') {
      state.correctAnswer = this.currentGuessRound.correctAnswer;
    }
    return state;
  }

  async simulateGuessChat(count = 6) {
    if (!this.currentGuessRound || this.currentGuessRound.status !== 'ACTIVE') {
      this.startGuessRound({ correctAnswer: 150 });
    }

    const demoUsers = [
      { id: 'sim_1', username: 'mimi_thailand', nickname: 'Mimi 🌸' },
      { id: 'sim_2', username: 'somchai_bkk', nickname: 'Somchai 🇹🇭' },
      { id: 'sim_3', username: 'lucas_stream', nickname: 'Lucas ⚡' },
      { id: 'sim_4', username: 'tammy_agency', nickname: 'Tammy 👑' },
      { id: 'sim_5', username: 'franco_dev', nickname: 'Franco 🎮' },
      { id: 'sim_6', username: 'alex_gamer', nickname: 'Alex 🚀' },
    ];

    const guesses = [130, 145, 148, 152, 160, 175];

    for (let i = 0; i < Math.min(count, demoUsers.length); i++) {
      setTimeout(async () => {
        if (!this.currentGuessRound || this.currentGuessRound.status !== 'ACTIVE') return;
        const user = demoUsers[i];
        await this.onComment({
          userId: user.id,
          username: user.username,
          nickname: user.nickname,
          comment: String(guesses[i])
        });
      }, i * 650);
    }
  }

  // -------------------------------------------------------
  // BLUR TO GUESS ROUND CONTROLS
  // -------------------------------------------------------

  startBlurRound(customConfig = null) {
    if (this.blurTimer) clearInterval(this.blurTimer);
    if (this.blurRevealTimeout) clearTimeout(this.blurRevealTimeout);

    // Cancel other modes
    if (this.flashTimer) clearInterval(this.flashTimer);
    if (this.revealTimeout) clearTimeout(this.revealTimeout);
    if (this.currentFlashRound) {
      this.currentFlashRound = null;
      this.io.emit('flash:idle');
    }
    if (this.guessTimer) clearInterval(this.guessTimer);
    if (this.guessRevealTimeout) clearTimeout(this.guessRevealTimeout);
    if (this.currentGuessRound) {
      this.currentGuessRound = null;
      this.io.emit('guess:idle');
    }
    this.activeMode = 'blur';

    this.isRunning = true;
    if (!this.broadcastInterval) {
      this.broadcastInterval = setInterval(() => this._broadcastState(), 2000);
    }

    const duration = customConfig?.durationSeconds || 60;

    this.currentBlurRound = {
      imageUrl: customConfig?.imageUrl || '',
      answer: (customConfig?.answer || '').toLowerCase().trim(),
      title: customConfig?.title || '🔍 Blur to Guess',
      status: 'ACTIVE',
      totalDuration: duration,
      timeLeft: duration,
      startBlur: 20,
      currentBlur: 20,
      winner: null,
      participants: new Set(),
      totalAttempts: 0
    };

    this.io.emit('blur:round_started', this.getBlurState());

    this.blurTimer = setInterval(() => {
      if (!this.currentBlurRound || this.currentBlurRound.status !== 'ACTIVE') {
        clearInterval(this.blurTimer);
        this.blurTimer = null;
        return;
      }

      this.currentBlurRound.timeLeft--;
      this.currentBlurRound.currentBlur = this.currentBlurRound.startBlur * (this.currentBlurRound.timeLeft / this.currentBlurRound.totalDuration);
      
      this.io.emit('blur:tick', {
        timeLeft: this.currentBlurRound.timeLeft,
        totalDuration: this.currentBlurRound.totalDuration,
        blurLevel: this.currentBlurRound.currentBlur,
        totalAttempts: this.currentBlurRound.totalAttempts
      });

      if (this.currentBlurRound.timeLeft <= 0) {
        this.endBlurRound();
      }
    }, 1000);

    return this.getBlurState();
  }

  endBlurRound() {
    if (this.blurTimer) clearInterval(this.blurTimer);
    this.blurTimer = null;

    if (!this.currentBlurRound) return null;

    if (this.currentBlurRound.status !== 'WON') {
      this.currentBlurRound.status = 'ENDED';
    }
    const finalState = this.getBlurState();

    this.io.emit('blur:round_ended', finalState);

    this.blurRevealTimeout = setTimeout(() => {
      if (this.currentBlurRound && (this.currentBlurRound.status === 'ENDED' || this.currentBlurRound.status === 'WON')) {
        this.currentBlurRound = null;
        if (this.activeMode === 'blur') this.activeMode = null;
        this.io.emit('blur:idle');
        this._broadcastState();
      }
      this.blurRevealTimeout = null;
    }, 6000);

    return finalState;
  }

  getBlurState() {
    if (!this.currentBlurRound) return { status: 'IDLE' };
    
    const state = {
      imageUrl: this.currentBlurRound.imageUrl,
      title: this.currentBlurRound.title,
      status: this.currentBlurRound.status,
      totalDuration: this.currentBlurRound.totalDuration,
      timeLeft: this.currentBlurRound.timeLeft,
      blurLevel: this.currentBlurRound.currentBlur,
      winner: this.currentBlurRound.winner,
      totalAttempts: this.currentBlurRound.totalAttempts
    };

    if (this.currentBlurRound.status === 'ENDED' || this.currentBlurRound.status === 'WON') {
      state.answer = this.currentBlurRound.answer;
    }
    
    return state;
  }

  async simulateBlurChat(count = 5) {
    if (!this.currentBlurRound || this.currentBlurRound.status !== 'ACTIVE') {
      this.startBlurRound({
        title: '🧴 Mystery Glow Serum',
        answer: 'serum',
        imageUrl: 'https://images.unsplash.com/photo-1620916566398-39f1143ab7be?w=600&auto=format&fit=crop&q=80',
        durationSeconds: 30
      });
    }

    const demoUsers = [
      { id: 'sim_1', username: 'mimi_thailand', nickname: 'Mimi 🌸', comment: 'lipstick' },
      { id: 'sim_2', username: 'somchai_bkk', nickname: 'Somchai 🇹🇭', comment: 'perfume bottle' },
      { id: 'sim_3', username: 'lucas_stream', nickname: 'Lucas ⚡', comment: 'face cream' },
      { id: 'sim_4', username: 'tammy_agency', nickname: 'Tammy 👑', comment: 'serum' },
      { id: 'sim_5', username: 'alex_gamer', nickname: 'Alex 🚀', comment: 'glow serum' },
    ];

    for (let i = 0; i < Math.min(count, demoUsers.length); i++) {
      setTimeout(async () => {
        if (!this.currentBlurRound || this.currentBlurRound.status !== 'ACTIVE') return;
        const user = demoUsers[i];
        await this.onComment({
          userId: user.id,
          username: user.username,
          nickname: user.nickname,
          comment: user.comment
        });
      }, (i + 1) * 1200);
    }
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

      const isSim = String(userId).startsWith('sim_');
      const isFlashActive = (this.currentFlashRound && this.currentFlashRound.status === 'ACTIVE');
      const isFortuneActive = (this.liveMode === 'fortune');
      if (!this.isRunning && !isFlashActive && !isFortuneActive && !isSim) {
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

      // 3. Fortune Teller Detection
      let fortuneDetected = false;
      const fortuneData = this._detectFortuneComment(rawComment);
      if (fortuneData && (this.liveMode === 'fortune' || isSim)) {
        if (this.liveMode !== 'fortune') {
          this.setLiveMode('fortune');
        }
        fortuneDetected = true;
        this.handleFortuneSubmission({
          userId,
          username,
          nickname,
          numbers: fortuneData.numbers,
          question: fortuneData.question,
          rawComment
        }).catch(err => console.error('[FortuneEngine] Error handling fortune:', err));
      }

      // 4. Base participation XP
      let xpEarned = XP_RULES.comment;

      // 5. Flash & Match Round Evaluation (Synchronous to preserve arrival order)
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

      // Guess the Weight detection
      if (this.currentGuessRound && this.currentGuessRound.status === 'ACTIVE') {
        const guessNum = parseFloat(rawComment.replace(/[^0-9.\-]/g, ''));
        if (!isNaN(guessNum) && !this.currentGuessRound.guesses.has(userId)) {
          this.currentGuessRound.guesses.set(userId, {
            userId, username, nickname, guess: guessNum, team: player.team, timestamp: Date.now()
          });
          xpEarned += XP_RULES.guess_participation;
          console.log(`[GuessEngine] 🎯 @${username} guessed: ${guessNum}`);
          this.io.emit('guess:new_guess', {
            username, nickname, team: player.team,
            totalGuesses: this.currentGuessRound.guesses.size
          });
        }
      }

      // Blur to Guess detection
      if (this.currentBlurRound && this.currentBlurRound.status === 'ACTIVE') {
        this.currentBlurRound.participants.add(userId);
        this.currentBlurRound.totalAttempts++;
        const normalizedComment = rawComment.toLowerCase().trim();
        const answer = this.currentBlurRound.answer;
        // Check for match: exact match or comment includes the full answer
        if (normalizedComment === answer || normalizedComment.includes(answer)) {
          this.currentBlurRound.status = 'WON';
          this.currentBlurRound.winner = { userId, username, nickname, team: player.team };
          const winXp = XP_RULES.blur_winner;
          xpEarned += winXp;
          console.log(`[BlurEngine] 🏆 @${username} guessed correctly: "${rawComment}" (+${winXp} XP)`);
          this.io.emit('blur:winner', {
            username, nickname, team: player.team,
            answer: this.currentBlurRound.answer,
            bonusXp: winXp
          });
          // End the round since someone won
          this.endBlurRound();
        } else {
          this.io.emit('blur:attempt', { username, nickname, totalAttempts: this.currentBlurRound.totalAttempts });
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
  // LIVE Stream Operational Mode: 'game' | 'attacker' | 'fortune'
  // -------------------------------------------------------
  setLiveMode(mode) {
    if (!['game', 'attacker', 'fortune'].includes(mode)) return this.liveMode;
    this.liveMode = mode;
    console.log(`[GameEngine] 🔄 LIVE Stream Mode set to: ${mode.toUpperCase()}`);
    this.io.emit('mode:changed', { mode: this.liveMode });
    this._broadcastState();
    return this.liveMode;
  }

  getLiveMode() {
    return this.liveMode;
  }

  // -------------------------------------------------------
  // Fortune Teller Mode Methods
  // -------------------------------------------------------
  getFortuneState() {
    return {
      liveMode: this.liveMode,
      queue: this.fortuneQueue,
      config: {
        model: this.fortuneConfig.model,
        prompt: this.fortuneConfig.prompt,
        hasKey: Boolean(this.fortuneConfig.apiKey && this.fortuneConfig.apiKey.trim().length > 5)
      }
    };
  }

  setFortuneConfig({ apiKey, prompt, model } = {}) {
    if (apiKey !== undefined) {
      const cleaned = String(apiKey).trim().replace(/^["'`“”]+|["'`“”]+$/g, '').trim();
      this.fortuneConfig.apiKey = cleaned;
      if (cleaned) {
        console.log(`[FortuneEngine] 🔑 API Key configured! Prefix: "${cleaned.substring(0, 6)}...", Length: ${cleaned.length}`);
      } else {
        console.log('[FortuneEngine] ℹ️ API Key cleared. Will use built-in engine.');
      }
    }
    if (prompt !== undefined && String(prompt).trim()) this.fortuneConfig.prompt = String(prompt).trim();
    if (model !== undefined && String(model).trim()) this.fortuneConfig.model = String(model).trim();
    
    this.io.emit('fortune:config_updated', {
      model: this.fortuneConfig.model,
      prompt: this.fortuneConfig.prompt,
      hasKey: Boolean(this.fortuneConfig.apiKey && this.fortuneConfig.apiKey.trim().length > 5)
    });
    return this.getFortuneState();
  }

  _detectFortuneComment(text) {
    if (!text) return null;
    const str = String(text).trim();

    // Pattern 1: 5 single digits separated by spaces, commas, dashes, slashes, or colons
    // e.g. "3 7 1 9 5 / Will I get the new job?" or "1, 4, 8, 9, 2: When will I move?"
    const sepMatch = str.match(/(?:^|[^\d])(\d)[\s,/-]+(\d)[\s,/-]+(\d)[\s,/-]+(\d)[\s,/-]+(\d)(?:[^\d]|$)/);
    if (sepMatch) {
      const numbers = [sepMatch[1], sepMatch[2], sepMatch[3], sepMatch[4], sepMatch[5]];
      let question = str.replace(sepMatch[0], ' ').replace(/^[/:,\-\s]+|[/:,\-\s]+$/g, '').trim();
      if (question.length >= 2) {
        return { numbers, question };
      }
    }

    // Pattern 2: 5 consecutive digits e.g. "37195 Will I travel?"
    const consecMatch = str.match(/\b(\d)(\d)(\d)(\d)(\d)\b/);
    if (consecMatch) {
      const numbers = [consecMatch[1], consecMatch[2], consecMatch[3], consecMatch[4], consecMatch[5]];
      let question = str.replace(consecMatch[0], ' ').replace(/^[/:,\-\s]+|[/:,\-\s]+$/g, '').trim();
      if (question.length >= 2) {
        return { numbers, question };
      }
    }

    return null;
  }

  async handleFortuneSubmission({ userId, username, nickname, numbers, question, rawComment }) {
    const item = {
      id: `fortune_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      userId,
      username,
      nickname: nickname || username,
      numbers,
      numbersFormatted: numbers.join(' / '),
      question,
      answer: '🔮 Consulting the oracle...',
      status: 'pending',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    // Prepend to queue
    this.fortuneQueue.unshift(item);
    if (this.fortuneQueue.length > 40) this.fortuneQueue.pop(); // keep last 40 entries
    
    this.io.emit('fortune:queue', this.fortuneQueue);
    this.io.emit('fortune:new_entry', item);
    console.log(`[FortuneEngine] 📥 New submission from @${username} [${numbers.join(' ')}]: "${question}"`);

    // Generate AI interpretation asynchronously
    const res = await this._generateFortuneReading(numbers, question, nickname || username);
    item.answer = typeof res === 'object' ? res.answer : res;
    item.provider = typeof res === 'object' ? res.provider : 'AI';
    item.status = 'ready';

    this.io.emit('fortune:reading_ready', item);
    this.io.emit('fortune:queue', this.fortuneQueue);
    console.log(`[FortuneEngine] ✨ Reading ready for @${username} [Provider: ${item.provider}]`);
  }

  async _generateFortuneReading(numbers, question, username) {
    const numbersStr = numbers.join(' ');
    const userPrompt = `Seeker @${username} chose 5 numbers: [${numbersStr}]. Question: "${question}". Provide an interpretation based on these numbers.`;
    
    // Clean and sanitize key (strip quotes, smart quotes, backticks, whitespace)
    const rawKey = (this.fortuneConfig.apiKey || '').toString().trim();
    const key = rawKey.replace(/^["'`“”]+|["'`“”]+$/g, '').trim();

    if (key) {
      console.log(`[FortuneEngine] 🔑 Processing fortune reading with key prefix: "${key.substring(0, 7)}..." (Length: ${key.length})`);
    } else {
      console.log('[FortuneEngine] ℹ️ No API key provided. Using built-in local numerology engine.');
    }

    // 1. Google Gemini (Free / High Limits - starts with 'AIza' or 'AQ.')
    if (key && (key.startsWith('AIza') || key.startsWith('AQ.') || key.startsWith('aiza') || key.startsWith('aq.'))) {
      const geminiModels = [
        'gemini-3-flash-preview',
        'gemini-3.1-flash-lite-preview',
        'gemini-flash-latest',
        'gemini-2.5-flash',
        'gemini-1.5-flash'
      ];
      let lastError = null;

      for (const model of geminiModels) {
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              system_instruction: {
                parts: [{ text: this.fortuneConfig.prompt }]
              },
              contents: [
                { parts: [{ text: userPrompt }] }
              ],
              generationConfig: {
                thinkingConfig: { thinkingBudget: 0 },
                maxOutputTokens: 600,
                temperature: 0.8
              }
            })
          });
          const data = await response.json();
          const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            console.log(`[FortuneEngine] 🟢 Response from Google Gemini (${model})!`);
            return { answer: text.trim(), provider: 'Google Gemini (Live AI)' };
          } else if (data.error) {
            lastError = data.error.message;
            const isRetryable =
              data.error.code === 404 ||
              data.error.code === 429 ||
              data.error.code === 503 ||
              data.error.status === 'NOT_FOUND' ||
              data.error.status === 'RESOURCE_EXHAUSTED' ||
              data.error.status === 'UNAVAILABLE' ||
              (data.error.message && (
                data.error.message.includes('high demand') ||
                data.error.message.includes('overloaded') ||
                data.error.message.includes('spikes')
              ));

            if (isRetryable) {
              console.warn(`[FortuneEngine] ⚠️ Gemini (${model}) busy or unavailable ("${data.error.message}"). Trying next model...`);
              continue; // Try next fallback model seamlessly!
            }
            console.error(`[FortuneEngine] ❌ Gemini Error (${model}):`, data.error.message);
            return { answer: `[Gemini Error: ${data.error.message}]`, provider: 'Gemini Error' };
          }
        } catch (err) {
          lastError = err.message;
          console.error(`[FortuneEngine] ❌ Gemini API call failed (${model}):`, err.message);
        }
      }

      console.warn('[FortuneEngine] ⚠️ All Gemini models busy. Falling back smoothly to built-in numerology engine for this question.');
      const localResult = this._getLocalNumerologyReading(numbers, question);
      return { answer: localResult.answer, provider: 'Built-in Engine (Live AI High Demand Fallback)' };
    }

    // 2. Anthropic Claude (Starts with 'sk-ant-')
    if (key && key.startsWith('sk-ant-')) {
      try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': key,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-3-5-haiku-20241022',
            max_tokens: 400,
            system: this.fortuneConfig.prompt,
            messages: [{ role: 'user', content: userPrompt }]
          })
        });
        const data = await response.json();
        if (data.content && data.content[0] && data.content[0].text) {
          console.log('[FortuneEngine] 🟢 Response from Claude 3.5 Haiku (Live AI)!');
          return { answer: data.content[0].text.trim(), provider: 'Claude 3.5 Haiku (Live AI)' };
        } else if (data.error) {
          console.error('[FortuneEngine] ❌ Claude error:', data.error.message);
          return { answer: `[Claude Error: ${data.error.message}]`, provider: 'Claude Error' };
        }
      } catch (err) {
        console.error('[FortuneEngine] ❌ Claude API call failed:', err.message);
        return { answer: `[Claude Connection Error: ${err.message}]`, provider: 'Claude Error' };
      }
    }

    // 3. Groq (Free & Ultra Fast - starts with 'gsk_')
    if (key && key.startsWith('gsk_')) {
      try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`
          },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [
              { role: 'system', content: this.fortuneConfig.prompt },
              { role: 'user', content: userPrompt }
            ],
            max_tokens: 400,
            temperature: 0.8
          })
        });
        const data = await response.json();
        if (data.choices && data.choices[0] && data.choices[0].message) {
          console.log('[FortuneEngine] 🟢 Response from Groq Llama 3.3 70B (Live AI)!');
          return { answer: data.choices[0].message.content.trim(), provider: 'Groq Llama 3.3 70B (Live AI)' };
        } else if (data.error) {
          console.error('[FortuneEngine] ❌ Groq error:', data.error.message);
          return { answer: `[Groq Error: ${data.error.message}]`, provider: 'Groq Error' };
        }
      } catch (err) {
        console.error('[FortuneEngine] ❌ Groq API call failed:', err.message);
        return { answer: `[Groq Connection Error: ${err.message}]`, provider: 'Groq Error' };
      }
    }

    // 4. OpenAI (Starts with 'sk-')
    if (key && key.startsWith('sk-')) {
      try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`
          },
          body: JSON.stringify({
            model: this.fortuneConfig.model || 'gpt-4o-mini',
            messages: [
              { role: 'system', content: this.fortuneConfig.prompt },
              { role: 'user', content: userPrompt }
            ],
            max_tokens: 400,
            temperature: 0.8
          })
        });
        const data = await response.json();
        if (data.choices && data.choices[0] && data.choices[0].message) {
          console.log('[FortuneEngine] 🟢 Response from OpenAI GPT-4o-mini (Live AI)!');
          return { answer: data.choices[0].message.content.trim(), provider: 'OpenAI GPT-4o-mini (Live AI)' };
        } else if (data.error) {
          console.error('[FortuneEngine] ❌ OpenAI error:', data.error.message);
          return { answer: `[OpenAI Error: ${data.error.message}]`, provider: 'OpenAI Error' };
        }
      } catch (err) {
        console.error('[FortuneEngine] ❌ OpenAI API call failed:', err.message);
        return { answer: `[OpenAI Connection Error: ${err.message}]`, provider: 'OpenAI Error' };
      }
    }

    // If key was provided but didn't match any known prefix:
    if (key && key.length > 5) {
      console.warn(`[FortuneEngine] ⚠️ Key provided but not recognized (starts with "${key.substring(0, 6)}...", length ${key.length})`);
      return {
        answer: `[Key Format Error: Key starts with "${key.substring(0, 5)}...". Please use Google Gemini (AQ... or AIza...), OpenAI (sk-...), Claude (sk-ant-...), or Groq (gsk_...)]`,
        provider: 'Unrecognized Key'
      };
    }

    // 5. Built-in Mystical Numerology Engine (Zero-Cost / Fallback / Testing Mode)
    console.log('[FortuneEngine] ⚡ Generated using: Built-in Numerology Engine (Local Fallback)');
    return this._getLocalNumerologyReading(numbers, question);
  }

  _getLocalNumerologyReading(numbers, question) {
    const archetypes = [
      `The numbers ${numbers[0]} and ${numbers[1]} reveal bold beginnings and shifting momentum. Regarding "${question}", trust your instincts over the coming days—a positive breakthrough is aligning.`,
      `With ${numbers.slice(0, 3).join('-')}, your energy is transitioning from uncertainty into balance. For "${question}", patience is rewarded with an unexpected answer very soon.`,
      `A powerful sequence (${numbers.join(', ')}). Number ${numbers[2]} stands at the center, bringing clarity. The universe indicates a definite yes to "${question}", as long as you remain grounded.`,
      `The digits show past cycles concluding. While ${numbers[0]} demands focus, ${numbers[4]} brings fulfillment. Expect a sign regarding "${question}" before the week closes.`
    ];
    const hash = (numbers.join('') + question).split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return { answer: archetypes[hash % archetypes.length], provider: 'Built-in Numerology Engine (Local)' };
  }

  dismissFortune(id) {
    this.fortuneQueue = this.fortuneQueue.filter(item => item.id !== id);
    this.io.emit('fortune:queue', this.fortuneQueue);
    return this.fortuneQueue;
  }

  clearFortuneQueue() {
    this.fortuneQueue = [];
    this.io.emit('fortune:queue', this.fortuneQueue);
    return this.fortuneQueue;
  }

  async simulateFortuneComment(customComment = null) {
    if (this.liveMode !== 'fortune') {
      this.setLiveMode('fortune');
    }
    const FAKE_QUESTIONS = [
      { numbers: ['3', '7', '1', '9', '5'], q: 'Will I get the new job?' },
      { numbers: ['8', '2', '4', '6', '1'], q: 'Will I travel abroad this year?' },
      { numbers: ['5', '3', '9', '2', '7'], q: 'Is my financial breakthrough coming?' },
      { numbers: ['1', '9', '3', '8', '4'], q: 'Will my love life improve soon?' },
      { numbers: ['7', '4', '2', '8', '6'], q: 'Should I start my new business now?' }
    ];
    const FAKE_USERS = [
      { username: 'mimi_star', nickname: 'Mimi' },
      { username: 'john_doe99', nickname: 'John' },
      { username: 'ploy_live', nickname: 'Ploy' },
      { username: 'alex_glow', nickname: 'Alex' },
      { username: 'sarah_k', nickname: 'Sarah' }
    ];
    const u = FAKE_USERS[Math.floor(Math.random() * FAKE_USERS.length)];
    const item = FAKE_QUESTIONS[Math.floor(Math.random() * FAKE_QUESTIONS.length)];
    const comment = customComment ? String(customComment).trim() : `${item.numbers.join(' ')} / ${item.q}`;

    await this.onComment({
      userId: 'sim_' + Date.now(),
      username: u.username,
      nickname: u.nickname,
      comment
    });
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
      liveMode: this.liveMode,
      teamScores,
      leaderboard,
      activeMode: this.activeMode,
      flashState: this.getFlashState(),
      guessState: this.getGuessState(),
      blurState: this.getBlurState(),
      fortuneQueue: this.fortuneQueue
    });
  }
}

module.exports = GameEngine;
