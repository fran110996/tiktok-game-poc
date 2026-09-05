// =============================================================
// mockConnector.js
// Simulates TikTok LIVE events for testing without being LIVE.
// Drop-in replacement for tiktokConnector.js
// =============================================================

const { EventEmitter } = require('events');

const FAKE_USERS = [
  { id: 'user_001', username: 'franco_gamer', nickname: 'Franco 🎮' },
  { id: 'user_002', username: 'maria_tiktok', nickname: 'María ✨' },
  { id: 'user_003', username: 'carlos_live', nickname: 'Carlos 🔥' },
  { id: 'user_004', username: 'valentina99', nickname: 'Valen 💜' },
  { id: 'user_005', username: 'juanchi_ar', nickname: 'Juanchi 🇦🇷' },
  { id: 'user_006', username: 'sofia_stream', nickname: 'Sofía 🌟' },
  { id: 'user_007', username: 'martin_xd', nickname: 'Martín XD' },
  { id: 'user_008', username: 'lucia_plays', nickname: 'Lucía 🎯' },
];

const FAKE_COMMENTS = [
  'A', 'B', 'C', '1', '2', '3',
  'team a', 'team b', 'team c',
  'vamos A!!', 'B gana', 'arriba el C',
  'hola stream', 'qué juego es este?',
  'jeje', 'gg', 'buena', 'A A A', 'B B B',
];

const FAKE_GIFTS = [
  { name: 'Rose', coins: 1 },
  { name: 'TikTok', coins: 1 },
  { name: 'Drama Queen', coins: 5 },
  { name: 'Hand Heart', coins: 10 },
  { name: 'Galaxy', coins: 1000 },
];

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

class MockConnector extends EventEmitter {
  constructor() {
    super();
    this.isConnected = false;
    this.interval = null;
    this.creatorUsername = null;
    this.tickCount = 0;
  }

  async connect(tiktokUsername) {
    this.creatorUsername = tiktokUsername;
    this.isConnected = true;

    console.log(`[MockConnector] 🎭 Simulating TikTok LIVE for @${tiktokUsername}`);
    this.emit('connected', { username: tiktokUsername });

    // Simulate join events on connect
    setTimeout(() => {
      for (const user of FAKE_USERS.slice(0, 3)) {
        this.emit('join', { userId: user.id, username: user.username, nickname: user.nickname });
      }
    }, 500);

    // Simulate random events every 1.5 seconds
    this.interval = setInterval(() => {
      this.tickCount++;
      const user = randomFrom(FAKE_USERS);
      const roll = Math.random();

      if (roll < 0.70) {
        // 70% chance: comment
        const comment = randomFrom(FAKE_COMMENTS);
        this.emit('comment', {
          userId: user.id,
          username: user.username,
          nickname: user.nickname,
          comment,
        });
      } else if (roll < 0.90) {
        // 20% chance: new user joins
        const newUser = randomFrom(FAKE_USERS);
        this.emit('join', {
          userId: newUser.id,
          username: newUser.username,
          nickname: newUser.nickname,
        });
      } else {
        // 10% chance: gift
        const gift = randomFrom(FAKE_GIFTS);
        this.emit('gift', {
          userId: user.id,
          username: user.username,
          nickname: user.nickname,
          giftName: gift.name,
          coins: gift.coins,
          repeatCount: Math.floor(Math.random() * 3) + 1,
        });
      }
    }, 1500);
  }

  async disconnect() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isConnected = false;
    this.emit('disconnected');
    console.log('[MockConnector] Disconnected');
  }
}

module.exports = MockConnector;
