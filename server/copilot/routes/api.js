// =============================================================
// copilot/routes/api.js
// /api/copilot — auth, context profiles, documents, live sessions,
// reply assistant, TTS.
// =============================================================

const express = require('express');
const multer = require('multer');
const path = require('path');
const { Readable } = require('stream');

const config = require('../config');
const auth = require('../services/auth');
const store = require('../services/store');
const ai = require('../services/openai');
const keys = require('../services/keys');
const live = require('../services/live');
const { generateReply, readScreen, CHANNELS } = require('../services/reply');
const { ALLOWED_EXT, extractText } = require('../services/documents');
const { LANGUAGES } = require('../services/languages');
const { PRESET_TAGS, EVENT_TYPES } = require('../services/contacts');
const { handle, httpError } = require('./util');

const router = express.Router();
const docUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ---------------------------------------------------------------
// Auth (login/status are the only public endpoints)
// ---------------------------------------------------------------
router.post('/auth/login', handle(async (req, res) => {
  if (!auth.isConfigured()) throw httpError(503, 'Login is not configured. Set COPILOT_USER_EMAIL and COPILOT_USER_PASSWORD on the server.');
  // Behind Render's proxy the real client IP is the last X-Forwarded-For entry
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',').pop().trim();
  if (auth.rateLimited(ip)) throw httpError(429, 'Too many attempts. Try again in 15 minutes.');
  const { email, password } = req.body || {};
  if (!auth.checkCredentials(email, password)) throw httpError(401, 'Wrong email or password');
  auth.setSessionCookie(req, res, config.userId);
  return { ok: true };
}));

router.post('/auth/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

router.use(auth.requireApiAuth);

router.get('/auth/me', handle(async (req) => ({ email: config.userEmail, user_id: req.copilotUser.userId })));

router.get('/meta', handle(async () => ({
  languages: LANGUAGES,
  channels: CHANNELS,
  tags: PRESET_TAGS,
  event_types: EVENT_TYPES,
  storage: (await store.status()).mode,
  ai_configured: Boolean(keys.getKey()),
  demo: keys.isDemo(),
  models: { llm: config.llmModel, transcribe: config.transcribeModel, tts: config.ttsModel },
  timezone: config.timezone,
})));

const uid = (req) => req.copilotUser.userId;

// ---------------------------------------------------------------
// Context profiles
// ---------------------------------------------------------------
router.get('/contexts', handle(async (req) => store.list('copilot_contexts', uid(req), { order: { column: 'updated_at', ascending: false } })));

router.post('/contexts', handle(async (req) => {
  const name = String(req.body?.name || '').trim().slice(0, 200);
  const text = String(req.body?.text || '').slice(0, 10000);
  if (!name) throw httpError(400, 'Name is required');
  return store.insert('copilot_contexts', uid(req), { name, text, updated_at: store.nowIso() });
}));

router.put('/contexts/:id', handle(async (req) => {
  const patch = { updated_at: store.nowIso() };
  if (req.body?.name !== undefined) patch.name = String(req.body.name).trim().slice(0, 200);
  if (req.body?.text !== undefined) patch.text = String(req.body.text).slice(0, 10000);
  const row = await store.update('copilot_contexts', uid(req), req.params.id, patch);
  if (!row) throw httpError(404, 'Not found');
  return row;
}));

router.delete('/contexts/:id', handle(async (req) => ({ ok: await store.remove('copilot_contexts', uid(req), req.params.id) })));

// ---------------------------------------------------------------
// Documents
// ---------------------------------------------------------------
router.get('/documents', handle(async (req) => store.list('copilot_documents', uid(req), {
  columns: 'id,file_name,mime_type,size_bytes,char_count,created_at',
  order: { column: 'created_at', ascending: false },
})));

router.get('/documents/:id', handle(async (req) => {
  const d = await store.get('copilot_documents', uid(req), req.params.id);
  if (!d) throw httpError(404, 'Not found');
  return { ...d, text: undefined, preview: (d.text || '').slice(0, 3000) };
}));

router.post('/documents', (req, res, next) => {
  docUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 10 MB' : err.message });
    next();
  });
}, handle(async (req) => {
  if (!req.file) throw httpError(400, 'No file uploaded');
  // multer gives latin1-decoded names; restore UTF-8 (Thai file names etc.)
  const fileName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const ext = path.extname(fileName).toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) throw httpError(400, 'Only PDF, DOCX, TXT and MD files are supported');
  let text;
  try {
    text = await extractText(fileName, req.file.buffer);
  } catch (err) {
    throw httpError(400, `Could not read the file: ${err.message}`);
  }
  if (!text) throw httpError(400, 'No text found in this file (scanned PDFs without text are not supported)');
  const row = await store.insert('copilot_documents', uid(req), {
    file_name: fileName.slice(0, 255),
    mime_type: req.file.mimetype,
    size_bytes: req.file.size,
    char_count: text.length,
    text,
  });
  return { id: row.id, file_name: row.file_name, size_bytes: row.size_bytes, char_count: row.char_count, created_at: row.created_at };
}));

router.delete('/documents/:id', handle(async (req) => ({ ok: await store.remove('copilot_documents', uid(req), req.params.id) })));

// ---------------------------------------------------------------
// Sessions (meeting + reply history)
// ---------------------------------------------------------------
router.get('/sessions', handle(async (req) => {
  const filters = {};
  if (req.query.kind) filters.kind = String(req.query.kind);
  if (req.query.contact_id) filters.contact_id = String(req.query.contact_id);
  const rows = await store.list('copilot_sessions', uid(req), {
    filters,
    columns: 'id,kind,title,contact_id,started_at,ended_at,status,summaries',
    order: { column: 'started_at', ascending: false },
    limit: Math.min(Number(req.query.limit) || 100, 500),
  });
  return rows.map(r => ({ ...r, live: Boolean(live.get(r.id, uid(req))) }));
}));

router.get('/sessions/:id', handle(async (req) => {
  const s = live.get(req.params.id, uid(req));
  if (s) return live.snapshot(s);
  const row = await store.get('copilot_sessions', uid(req), req.params.id);
  if (!row) throw httpError(404, 'Not found');
  return { ...row, live: false };
}));

router.post('/sessions', handle(async (req) => {
  return live.start(uid(req), req.body || {});
}));

router.post('/sessions/:id/audio', (req, res, next) => {
  audioUpload.single('audio')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, handle(async (req) => {
  const s = live.get(req.params.id, uid(req));
  if (!s) throw httpError(404, 'Session is not live');
  if (!req.file || req.file.size < 1000) return { ok: true, skipped: true };
  const line = await live.addAudio(s, {
    source: ['me', 'them', 'room'].includes(req.body.source) ? req.body.source : 'them',
    buffer: req.file.buffer,
    mimeType: req.file.mimetype || 'audio/webm',
    t: req.body.t,
  });
  return { ok: true, line };
}));

// Correct who said a transcript line (live or saved session)
router.put('/sessions/:id/lines/:lineId', handle(async (req) => {
  const who = req.body?.speaker;
  if (!['me', 'them', 'unknown'].includes(who)) throw httpError(400, 'speaker must be me, them or unknown');
  const s = live.get(req.params.id, uid(req));
  if (s) {
    const line = live.correctSpeaker(s, req.params.lineId, who);
    if (!line) throw httpError(404, 'Line not found');
    return { ok: true, line };
  }
  const row = await store.get('copilot_sessions', uid(req), req.params.id);
  if (!row) throw httpError(404, 'Not found');
  const transcript = row.transcript || [];
  const line = transcript.find(l => l.id === req.params.lineId);
  if (!line) throw httpError(404, 'Line not found');
  live.applySpeaker(line, who);
  await store.update('copilot_sessions', uid(req), row.id, { transcript });
  return { ok: true, line };
}));

router.post('/sessions/:id/analyze', handle(async (req) => {
  const s = live.get(req.params.id, uid(req));
  if (!s) throw httpError(404, 'Session is not live');
  live.analyze(s, { force: true }).catch(() => {});
  return { ok: true };
}));

router.post('/sessions/:id/stop', handle(async (req) => {
  const s = live.get(req.params.id, uid(req));
  if (!s) throw httpError(404, 'Session is not live');
  return live.stop(s);
}));

router.put('/sessions/:id', handle(async (req) => {
  const patch = {};
  if (req.body?.title !== undefined) patch.title = String(req.body.title).slice(0, 300);
  if (req.body?.contact_id !== undefined) patch.contact_id = req.body.contact_id || null;
  const row = await store.update('copilot_sessions', uid(req), req.params.id, patch);
  if (!row) throw httpError(404, 'Not found');
  return { ok: true };
}));

router.delete('/sessions/:id', handle(async (req) => {
  if (live.get(req.params.id, uid(req))) throw httpError(400, 'Stop the session before deleting it');
  return { ok: await store.remove('copilot_sessions', uid(req), req.params.id) };
}));

// ---------------------------------------------------------------
// Reply assistant
// ---------------------------------------------------------------
router.post('/reply', handle(async (req) => generateReply(uid(req), req.body || {})));

// Read my screen (image upload: screen frame, screenshot or phone photo)
router.post('/read-screen', (req, res, next) => {
  imageUpload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Image is larger than 10 MB' : err.message });
    next();
  });
}, handle(async (req) => {
  if (!req.file) throw httpError(400, 'No image uploaded');
  if (!/^image\/(png|jpe?g|webp|gif)$/i.test(req.file.mimetype)) throw httpError(400, 'Use a PNG, JPG, WEBP or GIF image');
  let docIds = [];
  try { docIds = JSON.parse(req.body.document_ids || '[]'); } catch (err) { docIds = []; }
  return readScreen(uid(req), {
    image: req.file.buffer,
    mimeType: req.file.mimetype,
    context_id: req.body.context_id || null,
    contact_id: req.body.contact_id || null,
    note: req.body.note || '',
    my_language: req.body.my_language || 'en',
    reply_language: req.body.reply_language || 'auto',
    document_ids: Array.isArray(docIds) ? docIds : [],
  });
}));

// ---------------------------------------------------------------
// Text to speech (earphone playback)
// ---------------------------------------------------------------
router.post('/tts', handle(async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) throw httpError(400, 'No text');
  let upstream;
  try {
    upstream = await ai.speech(text);
  } catch (err) {
    if (err.demo) return res.status(503).json({ error: err.message, demo: true });
    throw err;
  }
  res.set('Content-Type', 'audio/mpeg');
  res.set('Cache-Control', 'no-store');
  Readable.fromWeb(upstream.body).pipe(res);
}));

// ---------------------------------------------------------------
// Settings: OpenAI API key (stored encrypted on the server, only a
// masked version is ever sent back to the browser)
// ---------------------------------------------------------------
router.get('/settings', handle(async () => ({
  openai: keys.status(),
  models: { llm: config.llmModel, transcribe: config.transcribeModel, tts: config.ttsModel, reply: config.replyModel },
  storage: (await store.status()).mode,
})));

router.put('/settings/openai-key', handle(async (req) => {
  const key = String(req.body?.key || '').trim();
  if (!/^sk-[A-Za-z0-9_\-]{20,}$/.test(key)) throw httpError(400, 'That does not look like an OpenAI API key (it starts with "sk-").');
  const check = await keys.test(key);
  if (!check.ok) throw httpError(400, `OpenAI rejected this key: ${check.error}`);
  await keys.save(uid(req), key);
  return { ok: true, openai: keys.status() };
}));

router.delete('/settings/openai-key', handle(async (req) => {
  await keys.save(uid(req), null);
  return { ok: true, openai: keys.status() };
}));

router.post('/settings/test', handle(async () => keys.test()));

module.exports = router;
