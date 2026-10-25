// =============================================================
// copilot/index.js
// Sales Copilot module — mounts pages (/copilot), API (/api/copilot)
// and the Socket.io namespace (/copilot) on the existing server.
// Independent from the game engine.
// =============================================================

const auth = require('./services/auth');
const store = require('./services/store');
const keys = require('./services/keys');
const live = require('./services/live');
const pagesRouter = require('./routes/pages');
const apiRouter = require('./routes/api');
const crmRouter = require('./routes/crm');

function mount(app, io) {
  app.use('/copilot', pagesRouter);
  app.use('/api/copilot', apiRouter);
  app.use('/api/copilot', auth.requireApiAuth, crmRouter);

  const nsp = io.of('/copilot');
  nsp.use((socket, next) => {
    const user = auth.userFromCookieHeader(socket.handshake.headers.cookie);
    if (!user) return next(new Error('unauthorized'));
    socket.data.user = user;
    next();
  });
  nsp.on('connection', (socket) => {
    socket.on('session:join', ({ id } = {}, ack) => {
      const s = id && live.get(id, socket.data.user.userId);
      if (!s) return typeof ack === 'function' && ack({ ok: false });
      socket.join(`session:${s.id}`);
      if (typeof ack === 'function') ack({ ok: true, snapshot: live.snapshot(s) });
    });
    socket.on('session:leave', ({ id } = {}) => socket.leave(`session:${id}`));
  });
  live.attach(nsp);

  store.status().catch(() => {});
  keys.load().then(() => {
    if (keys.isDemo()) console.log('[Copilot] No OpenAI API key → DEMO MODE (example answers). Add a key in /copilot/settings');
  }).catch(() => {});
  if (!auth.isConfigured()) {
    console.warn('[Copilot] COPILOT_USER_EMAIL / COPILOT_USER_PASSWORD not set — login disabled');
  }
}

module.exports = { mount };
