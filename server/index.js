// =============================================================
// index.js
// Main Express + Socket.io server
// Routes:
//   GET  /              → Host Dashboard
//   GET  /overlay       → OBS Browser Source overlay
//   POST /api/connect   → Connect to TikTok LIVE
//   POST /api/start     → Start game session
//   POST /api/stop      → Stop game session
//   POST /api/reset     → Reset in-memory scores
//   GET  /api/leaderboard → Get current leaderboard
// =============================================================

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const TikTokConnector = require('./tiktokConnector');
const GameEngine = require('./gameEngine');
const db = require('./database');

const MOCK_MODE = process.env.MOCK_MODE === 'true';
const ConnectorClass = MOCK_MODE ? MockConnector : TikTokConnector;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// -------------------------------------------------------
// Initialize modules
// -------------------------------------------------------
const tiktok = new ConnectorClass();
const game = new GameEngine(io);

let currentCreator = null;

// -------------------------------------------------------
// Wire TikTok events → Game Engine
// -------------------------------------------------------
tiktok.on('comment', (data) => game.onComment(data));
tiktok.on('gift', (data) => game.onGift(data));
tiktok.on('join', (data) => game.onJoin(data));

tiktok.on('connected', ({ username }) => {
  io.emit('tiktok:connected', { username });
});

tiktok.on('disconnected', () => {
  io.emit('tiktok:disconnected');
});

tiktok.on('error', (err) => {
  io.emit('tiktok:error', { message: err.message });
});

// -------------------------------------------------------
// REST API
// -------------------------------------------------------

// Connect to TikTok LIVE
app.post('/api/connect', async (req, res) => {
  const { username, sessionId } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });

  try {
    currentCreator = username;
    await tiktok.connect(username, sessionId || null);
    // Auto-start game session
    await game.start(username);
    res.json({ ok: true, message: `Connected to @${username} and game started!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Disconnect from TikTok
app.post('/api/disconnect', async (req, res) => {
  await tiktok.disconnect();
  res.json({ ok: true });
});

// Start game session
app.post('/api/start', async (req, res) => {
  if (!currentCreator) return res.status(400).json({ error: 'Not connected to TikTok yet' });
  await game.start(currentCreator);
  res.json({ ok: true });
});

// Stop game session
app.post('/api/stop', (req, res) => {
  game.stop();
  res.json({ ok: true });
});

// Reset scores
app.post('/api/reset', (req, res) => {
  game.reset();
  res.json({ ok: true });
});

// Get leaderboard
app.get('/api/leaderboard', async (req, res) => {
  const data = await db.getLeaderboard(20);
  res.json(data);
});

// Get team scores
app.get('/api/teams', async (req, res) => {
  const scores = await db.getTeamScores();
  res.json(scores);
});

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Serve OBS overlay (combined — legacy)
app.get('/overlay', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/overlay.html'));
});

// Serve Teams overlay only
app.get('/overlay/teams', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/overlay-teams.html'));
});

// Serve Leaderboard overlay only
app.get('/overlay/leaderboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/overlay-leaderboard.html'));
});

// -------------------------------------------------------
// Socket.io connection
// -------------------------------------------------------
io.on('connection', (socket) => {
  console.log('[Server] Client connected:', socket.id);
  socket.on('disconnect', () => {
    console.log('[Server] Client disconnected:', socket.id);
  });
});

// -------------------------------------------------------
// Start server
// -------------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 TikTok Game POC running at http://localhost:${PORT}`);
  console.log(`📺 OBS Overlay at http://localhost:${PORT}/overlay\n`);
});
