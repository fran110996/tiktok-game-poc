// =============================================================
// copilot/services/keys.js
// Which OpenAI API key to use, and whether the copilot runs in
// demo mode (example answers, no AI calls).
//
// Order: key saved in Settings (encrypted in copilot_settings)
//        → OPENAI_API_KEY env var → none (= demo mode).
// COPILOT_DEMO=true forces demo mode even when a key exists.
// =============================================================

const crypto = require('crypto');
const config = require('../config');
const store = require('./store');

const TABLE = 'copilot_settings';
const KEY_NAME = 'openai_api_key';

let saved = null;   // decrypted key from Settings
let loaded = false;
let loadError = null;

const cipherKey = crypto.createHash('sha256').update(`${config.sessionSecret}:settings`).digest();

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cipherKey, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

function decrypt(value) {
  const [v, iv, tag, enc] = String(value || '').split(':');
  if (v !== 'v1') throw new Error('Unknown format');
  const d = crypto.createDecipheriv('aes-256-gcm', cipherKey, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

async function load(userId = config.userId) {
  try {
    const rows = await store.list(TABLE, userId, { filters: { key: KEY_NAME }, limit: 1 });
    saved = rows[0] ? decrypt(rows[0].value) : null;
    loadError = null;
  } catch (err) {
    saved = null;
    // Usually: COPILOT_SESSION_SECRET (or the login) changed since the key was saved
    loadError = 'The saved API key could not be read (the server secret changed). Please save it again.';
  }
  loaded = true;
}

function getKey() {
  return saved || config.openaiKey || '';
}

function isDemo() {
  return process.env.COPILOT_DEMO === 'true' || !getKey();
}

function mask(key) {
  return key ? `${key.slice(0, 7)}…${key.slice(-4)}` : '';
}

function status() {
  const key = getKey();
  return {
    configured: Boolean(key),
    source: saved ? 'settings' : config.openaiKey ? 'server' : 'none',
    masked: mask(key),
    demo: isDemo(),
    forced_demo: process.env.COPILOT_DEMO === 'true',
    error: loadError,
  };
}

async function save(userId, key) {
  const rows = await store.list(TABLE, userId, { filters: { key: KEY_NAME } });
  for (const r of rows) await store.remove(TABLE, userId, r.id);
  if (key) await store.insert(TABLE, userId, { key: KEY_NAME, value: encrypt(key), updated_at: store.nowIso() });
  saved = key || null;
  loadError = null;
}

// Cheap call that proves the key works (lists models).
async function test(key = getKey()) {
  if (!key) return { ok: false, error: 'No API key set' };
  try {
    const res = await fetch(`${config.openaiBaseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return { ok: true };
    const data = await res.json().catch(() => ({}));
    return { ok: false, error: data?.error?.message || `OpenAI answered ${res.status}` };
  } catch (err) {
    return { ok: false, error: `Could not reach OpenAI: ${err.message}` };
  }
}

module.exports = { load, getKey, isDemo, status, save, test, isLoaded: () => loaded };
