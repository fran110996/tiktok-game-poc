// =============================================================
// copilot/services/store.js
// Tiny data layer for copilot_* tables.
// Uses Supabase when reachable; otherwise falls back to a local JSON file
// (same idea as the in-memory failover in server/database.js).
// Every row is scoped by user_id.
// =============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

const TABLES = [
  'copilot_contexts',
  'copilot_documents',
  'copilot_sessions',
  'copilot_contacts',
  'copilot_events',
  'copilot_monitor_keywords',
  'copilot_monitor_reports',
  'copilot_settings',
];

let supabase = null;
try {
  if (process.env.SUPABASE_URL && (config.supabaseServiceKey || process.env.SUPABASE_ANON_KEY)) {
    supabase = config.supabaseServiceKey
      ? createClient(process.env.SUPABASE_URL, config.supabaseServiceKey, { auth: { persistSession: false } })
      : require('../../database').supabase;
  }
} catch (err) {
  supabase = null;
}

// ---------------------------------------------------------------
// Local JSON fallback
// ---------------------------------------------------------------
let local = null;
let saveTimer = null;

function loadLocal() {
  if (local) return local;
  local = {};
  try {
    if (fs.existsSync(config.localStorePath)) {
      local = JSON.parse(fs.readFileSync(config.localStorePath, 'utf8')) || {};
    }
  } catch (err) {
    console.error('[Copilot] Could not read local store, starting empty:', err.message);
    local = {};
  }
  for (const t of TABLES) if (!Array.isArray(local[t])) local[t] = [];
  return local;
}

function writeLocal() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(config.localStorePath), { recursive: true });
    const tmp = `${config.localStorePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(local));
    fs.renameSync(tmp, config.localStorePath);
  } catch (err) {
    console.error('[Copilot] Could not write local store:', err.message);
  }
}

function saveLocal() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeLocal, 200);
}

// Don't lose the last change when the server stops (Ctrl+C, redeploy)
function flushOnExit() {
  if (saveTimer) writeLocal();
}
process.on('exit', flushOnExit);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    flushOnExit();
    process.exit(0);
  });
}

// ---------------------------------------------------------------
// Mode detection (probe once, re-probe every 5 minutes when local)
// ---------------------------------------------------------------
let mode = null; // 'supabase' | 'local'
let lastProbe = 0;

async function getMode() {
  const now = Date.now();
  if (mode === 'supabase' || (mode === 'local' && now - lastProbe < 5 * 60 * 1000)) return mode;
  lastProbe = now;
  if (!supabase) {
    if (mode !== 'local') console.log('[Copilot] Supabase not configured → using local JSON store');
    mode = 'local';
    return mode;
  }
  try {
    const { error } = await supabase.from('copilot_contexts').select('id').limit(1);
    if (error) throw new Error(error.message);
    if (mode !== 'supabase') console.log('[Copilot] Using Supabase for copilot data');
    mode = 'supabase';
  } catch (err) {
    if (mode !== 'local') console.warn('[Copilot] Supabase unavailable for copilot tables → local JSON store:', err.message);
    mode = 'local';
  }
  return mode;
}

function project(row, columns) {
  if (!columns || columns === '*') return { ...row };
  const out = {};
  for (const c of columns.split(',').map(s => s.trim())) out[c] = row[c];
  return out;
}

function matches(row, userId, filters) {
  if (row.user_id !== userId) return false;
  for (const [k, v] of Object.entries(filters || {})) {
    if (row[k] !== v) return false;
  }
  return true;
}

function sortRows(rows, order) {
  if (!order) return rows;
  const { column, ascending = true } = order;
  return rows.sort((a, b) => {
    const av = a[column] ?? '';
    const bv = b[column] ?? '';
    if (av < bv) return ascending ? -1 : 1;
    if (av > bv) return ascending ? 1 : -1;
    return 0;
  });
}

// ---------------------------------------------------------------
// Local implementations
// ---------------------------------------------------------------
const localOps = {
  list(table, userId, { filters, order, limit, columns } = {}) {
    const rows = loadLocal()[table].filter(r => matches(r, userId, filters));
    sortRows(rows, order);
    return (limit ? rows.slice(0, limit) : rows).map(r => project(r, columns));
  },
  get(table, userId, id) {
    const row = loadLocal()[table].find(r => r.id === id && r.user_id === userId);
    return row ? { ...row } : null;
  },
  insert(table, row) {
    loadLocal()[table].push(row);
    saveLocal();
    return { ...row };
  },
  update(table, userId, id, patch) {
    const row = loadLocal()[table].find(r => r.id === id && r.user_id === userId);
    if (!row) return null;
    Object.assign(row, patch);
    saveLocal();
    return { ...row };
  },
  remove(table, userId, id) {
    const rows = loadLocal()[table];
    const idx = rows.findIndex(r => r.id === id && r.user_id === userId);
    if (idx !== -1) rows.splice(idx, 1);
    saveLocal();
    return idx !== -1;
  },
  removeWhere(table, userId, filters) {
    const data = loadLocal();
    const before = data[table].length;
    data[table] = data[table].filter(r => !matches(r, userId, filters));
    saveLocal();
    return before - data[table].length;
  },
};

// ---------------------------------------------------------------
// Public API (Supabase first, local on failure)
// ---------------------------------------------------------------
async function withFallback(name, supaFn, localFn) {
  if ((await getMode()) === 'supabase') {
    try {
      return await supaFn();
    } catch (err) {
      console.warn(`[Copilot] Supabase ${name} failed, using local store:`, err.message);
    }
  }
  return localFn();
}

function check({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

function nowIso() {
  return new Date().toISOString();
}

async function list(table, userId, opts = {}) {
  return withFallback(`list ${table}`, async () => {
    let q = supabase.from(table).select(opts.columns || '*').eq('user_id', userId);
    for (const [k, v] of Object.entries(opts.filters || {})) q = q.eq(k, v);
    if (opts.order) q = q.order(opts.order.column, { ascending: opts.order.ascending !== false });
    if (opts.limit) q = q.limit(opts.limit);
    return check(await q) || [];
  }, () => localOps.list(table, userId, opts));
}

async function get(table, userId, id) {
  if (!id) return null;
  return withFallback(`get ${table}`, async () => {
    return check(await supabase.from(table).select('*').eq('user_id', userId).eq('id', id).maybeSingle());
  }, () => localOps.get(table, userId, id));
}

async function insert(table, userId, row) {
  const full = { id: crypto.randomUUID(), created_at: nowIso(), ...row, user_id: userId };
  return withFallback(`insert ${table}`, async () => {
    return check(await supabase.from(table).insert(full).select().single());
  }, () => localOps.insert(table, full));
}

async function update(table, userId, id, patch) {
  const clean = { ...patch };
  delete clean.id;
  delete clean.user_id;
  return withFallback(`update ${table}`, async () => {
    return check(await supabase.from(table).update(clean).eq('user_id', userId).eq('id', id).select().maybeSingle());
  }, () => localOps.update(table, userId, id, clean));
}

async function remove(table, userId, id) {
  return withFallback(`delete ${table}`, async () => {
    check(await supabase.from(table).delete().eq('user_id', userId).eq('id', id));
    return true;
  }, () => localOps.remove(table, userId, id));
}

async function removeWhere(table, userId, filters) {
  return withFallback(`delete ${table}`, async () => {
    let q = supabase.from(table).delete().eq('user_id', userId);
    for (const [k, v] of Object.entries(filters || {})) q = q.eq(k, v);
    check(await q);
    return true;
  }, () => localOps.removeWhere(table, userId, filters));
}

async function status() {
  return { mode: await getMode() };
}

module.exports = { list, get, insert, update, remove, removeWhere, status, nowIso };
