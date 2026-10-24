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
const multer = require('multer');
const fs = require('fs');

const uploadDir = path.join(__dirname, '../public/uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `img_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB limit

const TikTokConnector = require('./tiktokConnector');
const MockConnector = require('./mockConnector');
const GameEngine = require('./gameEngine');
const db = require('./database');

const MOCK_MODE = process.env.MOCK_MODE === 'true';
const ConnectorClass = MOCK_MODE ? MockConnector : TikTokConnector;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// Sales Copilot (separate module, login-protected). Mounted before the
// static middleware so /copilot pages are never served without auth.
require('./copilot').mount(app, io);

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
    let msg = err.message || 'Connection failed';
    if (msg.includes('retry-after') || msg.includes('Cannot read properties of undefined')) {
      msg = 'TikTok connection cooldown. Please ensure your TikTok LIVE is currently broadcasting and wait 1-2 minutes before clicking Connect again.';
    }
    res.status(500).json({ error: msg });
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

// -------------------------------------------------------
// Flash & Match Endpoints
// -------------------------------------------------------
// Get Flash Presets
app.get('/api/flash/presets', (req, res) => {
  res.json(game.getFlashPresets());
});

// Get Current Flash State
app.get('/api/flash/state', (req, res) => {
  res.json(game.getFlashState());
});

// Start Flash Round
app.post('/api/flash/start', (req, res) => {
  const state = game.startFlashRound(req.body?.config || null);
  res.json({ ok: true, state });
});

// End Flash Round
app.post('/api/flash/end', (req, res) => {
  const state = game.endFlashRound();
  res.json({ ok: true, state });
});

// Simulate Live Chat Matches (for video demo recording)
app.post('/api/flash/simulate', async (req, res) => {
  const count = req.body?.count || 6;
  await game.simulateFlashChat(count);
  res.json({ ok: true, message: `Simulating ${count} chat matches` });
});

// -------------------------------------------------------
// Guess the Weight Endpoints
// -------------------------------------------------------
app.get('/api/guess/state', (req, res) => {
  res.json(game.getGuessState());
});

app.post('/api/guess/start', (req, res) => {
  const state = game.startGuessRound(req.body?.config || null);
  res.json({ ok: true, state });
});

app.post('/api/guess/lock', (req, res) => {
  const state = game.lockGuessRound();
  res.json({ ok: true, state });
});

app.post('/api/guess/reveal', (req, res) => {
  const state = game.revealGuessResult();
  res.json({ ok: true, state });
});

app.post('/api/guess/simulate', async (req, res) => {
  const count = req.body?.count || 6;
  await game.simulateGuessChat(count);
  res.json({ ok: true, message: `Simulating ${count} guesses` });
});

// -------------------------------------------------------
// Blur to Guess Endpoints
// -------------------------------------------------------
app.get('/api/blur/state', (req, res) => {
  res.json(game.getBlurState());
});

app.post('/api/blur/start', (req, res) => {
  const state = game.startBlurRound(req.body?.config || null);
  res.json({ ok: true, state });
});

app.post('/api/blur/end', (req, res) => {
  const state = game.endBlurRound();
  res.json({ ok: true, state });
});

app.post('/api/blur/simulate', async (req, res) => {
  const count = req.body?.count || 5;
  await game.simulateBlurChat(count);
  res.json({ ok: true, message: `Simulating ${count} blur guesses` });
});

// -------------------------------------------------------
// LIVE Mode Selector Endpoints ('game' | 'attacker' | 'fortune')
// -------------------------------------------------------
app.get('/api/mode', (req, res) => {
  res.json({ mode: game.getLiveMode() });
});

app.post('/api/mode', (req, res) => {
  const mode = req.body?.mode;
  const current = game.setLiveMode(mode);
  res.json({ ok: true, mode: current });
});

// -------------------------------------------------------
// Fortune Teller Endpoints
// -------------------------------------------------------
app.get('/api/fortune/state', (req, res) => {
  res.json(game.getFortuneState());
});

app.post('/api/fortune/config', (req, res) => {
  const state = game.setFortuneConfig(req.body || {});
  res.json({ ok: true, state });
});

app.post('/api/fortune/dismiss', (req, res) => {
  const queue = game.dismissFortune(req.body?.id);
  res.json({ ok: true, queue });
});

app.post('/api/fortune/clear', (req, res) => {
  const queue = game.clearFortuneQueue();
  res.json({ ok: true, queue });
});

app.post('/api/fortune/simulate', async (req, res) => {
  await game.simulateFortuneComment(req.body?.comment || null);
  res.json({ ok: true, message: 'Simulated fortune comment processed' });
});

// -------------------------------------------------------
// Image Upload Endpoints
// -------------------------------------------------------
app.post('/api/upload/image', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const url = `/uploads/${req.file.filename}`;
  res.json({ ok: true, url, filename: req.file.filename });
});

app.get('/api/upload/list', (req, res) => {
  const files = fs.readdirSync(uploadDir)
    .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f))
    .map(f => ({ filename: f, url: `/uploads/${f}` }));
  res.json(files);
});

app.delete('/api/upload/:filename', (req, res) => {
  const filepath = path.join(uploadDir, req.params.filename);
  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Serve OBS overlay (combined)
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

// Serve Game overlay (supports Flash & Match, Guess the Weight, Blur to Guess)
app.get('/overlay/flash', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/overlay-flashmatch.html'));
});
app.get('/overlay/game', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/overlay-flashmatch.html'));
});

// Serve Teleprompter
app.get('/teleprompter', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/teleprompter.html'));
});

// -------------------------------------------------------
// Socket.io connection & Multi-Streamer Room Routing
// -------------------------------------------------------
io.on('connection', (socket) => {
  // Support independent rooms for multiple streamers
  socket.on('room:join', ({ creator }) => {
    const room = creator ? creator.toLowerCase().trim() : 'global';
    socket.join(room);
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
