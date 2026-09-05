// =============================================================
// tiktokConnector.js
// MODULAR TikTok Live Connector — tiktok-live-connector v2.x
// Emits normalized events to the game engine.
// =============================================================

const { TikTokLiveConnection } = require('tiktok-live-connector');
const { EventEmitter } = require('events');

class TikTokConnector extends EventEmitter {
  constructor() {
    super();
    this.connection = null;
    this.isConnected = false;
    this.creatorUsername = null;
  }

  async connect(tiktokUsername, sessionId = null) {
    if (this.isConnected) {
      await this.disconnect();
    }

    this.creatorUsername = tiktokUsername;

    const options = {
      processInitialData: false,
      sessionId: sessionId || undefined,
    };

    this.connection = new TikTokLiveConnection(tiktokUsername, options);

    this.connection.on('connected', (state) => {
      this.isConnected = true;
      console.log(`[TikTokConnector] ✅ Connected to @${tiktokUsername}`);
      this.emit('connected', { username: tiktokUsername, state });
    });

    this.connection.on('disconnected', () => {
      this.isConnected = false;
      console.log(`[TikTokConnector] Disconnected`);
      this.emit('disconnected');
    });

    this.connection.on('error', (err) => {
      console.error('[TikTokConnector] Error:', err?.message || err);
      this.emit('error', err);
    });

    // COMMENT
    this.connection.on('chat', (data) => {
      const user = data.user || {};
      const userId = String(user.id || user.idStr || user.userId || 'unknown');
      const username = user.uniqueId || user.displayId || user.nickname || userId;
      const nickname = user.nickname || user.displayId || username;
      const commentText = data.comment || data.content || data.text || '';

      console.log(`[TikTokConnector] 💬 Chat from ${nickname} (@${username}): "${commentText}"`);

      this.emit('comment', {
        userId,
        username,
        nickname,
        comment: commentText,
      });
    });

    // GIFT
    this.connection.on('gift', (data) => {
      if (data.giftType === 1 && !data.repeatEnd) return;
      const user = data.user || {};
      const userId = String(user.id || user.idStr || user.userId || 'unknown');
      const username = user.uniqueId || user.displayId || user.nickname || userId;
      const nickname = user.nickname || user.displayId || userId;
      const giftName = data.giftName || data.gift?.name || 'Gift';
      const coins = data.diamondCount || data.gift?.diamondCount || 0;
      const repeatCount = data.repeatCount || 1;

      console.log(`[TikTokConnector] 🎁 Gift from ${nickname}: ${giftName} x${repeatCount} (${coins} coins)`);

      this.emit('gift', {
        userId,
        username,
        nickname,
        giftName,
        coins,
        repeatCount,
      });
    });

    // JOIN
    this.connection.on('member', (data) => {
      const user = data.user || {};
      const userId = String(user.id || user.idStr || user.userId || 'unknown');
      const username = user.uniqueId || user.displayId || user.nickname || userId;
      const nickname = user.nickname || username;

      console.log(`[TikTokConnector] 👤 Member join: ${nickname}`);

      this.emit('join', {
        userId,
        username,
        nickname,
      });
    });

    try {
      const state = await this.connection.connect();
      return state;
    } catch (err) {
      console.error('[TikTokConnector] Failed to connect:', err.message);
      throw err;
    }
  }

  async disconnect() {
    if (this.connection) {
      try { this.connection.disconnect(); } catch (_) {}
      this.connection = null;
      this.isConnected = false;
    }
  }
}

module.exports = TikTokConnector;
