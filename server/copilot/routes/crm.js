// =============================================================
// copilot/routes/crm.js
// /api/copilot — contacts, events, upcoming, group messages,
// morning summary (monitor).
// =============================================================

const express = require('express');
const store = require('../services/store');
const contacts = require('../services/contacts');
const monitor = require('../services/monitor');
const { handle, httpError } = require('./util');

const router = express.Router();
const uid = (req) => req.copilotUser.userId;

async function contextText(userId, contextId) {
  if (!contextId) return '';
  const ctx = await store.get('copilot_contexts', userId, contextId);
  return ctx?.text || '';
}

// ---------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------
router.get('/contacts', handle(async (req) => {
  const rows = await store.list('copilot_contacts', uid(req), { order: { column: 'name', ascending: true } });
  const tag = req.query.tag ? String(req.query.tag) : null;
  return tag ? rows.filter(c => (c.tags || []).includes(tag)) : rows;
}));

router.get('/contacts/:id', handle(async (req) => {
  const c = await store.get('copilot_contacts', uid(req), req.params.id);
  if (!c) throw httpError(404, 'Not found');
  const events = await store.list('copilot_events', uid(req), { filters: { contact_id: c.id }, order: { column: 'date', ascending: true } });
  const history = await store.list('copilot_sessions', uid(req), {
    filters: { contact_id: c.id },
    columns: 'id,kind,title,started_at,ended_at,status',
    order: { column: 'started_at', ascending: false },
    limit: 100,
  });
  return { ...c, events, history };
}));

router.post('/contacts', handle(async (req) => {
  const data = contacts.sanitizeContact(req.body || {});
  if (!data.name) throw httpError(400, 'Name is required');
  return store.insert('copilot_contacts', uid(req), { ...data, updated_at: store.nowIso() });
}));

router.put('/contacts/:id', handle(async (req) => {
  const data = contacts.sanitizeContact(req.body || {});
  if (!data.name) throw httpError(400, 'Name is required');
  const row = await store.update('copilot_contacts', uid(req), req.params.id, { ...data, updated_at: store.nowIso() });
  if (!row) throw httpError(404, 'Not found');
  return row;
}));

router.delete('/contacts/:id', handle(async (req) => {
  await store.removeWhere('copilot_events', uid(req), { contact_id: req.params.id });
  return { ok: await store.remove('copilot_contacts', uid(req), req.params.id) };
}));

// ---------------------------------------------------------------
// Events
// ---------------------------------------------------------------
router.post('/contacts/:id/events', handle(async (req) => {
  const c = await store.get('copilot_contacts', uid(req), req.params.id);
  if (!c) throw httpError(404, 'Contact not found');
  return store.insert('copilot_events', uid(req), { contact_id: c.id, ...contacts.sanitizeEvent(req.body || {}) });
}));

router.put('/events/:id', handle(async (req) => {
  const row = await store.update('copilot_events', uid(req), req.params.id, contacts.sanitizeEvent(req.body || {}));
  if (!row) throw httpError(404, 'Not found');
  return row;
}));

router.delete('/events/:id', handle(async (req) => ({ ok: await store.remove('copilot_events', uid(req), req.params.id) })));

// ---------------------------------------------------------------
// Upcoming + greetings + group messages
// ---------------------------------------------------------------
router.get('/upcoming', handle(async (req) => contacts.upcoming(uid(req), Math.min(Number(req.query.days) || 14, 60))));

router.post('/upcoming/suggestions', handle(async (req) => {
  const { items } = await contacts.upcoming(uid(req), Math.min(Number(req.body?.days) || 14, 60));
  const wanted = Array.isArray(req.body?.ids) && req.body.ids.length ? items.filter(i => req.body.ids.includes(i.id)) : items;
  return contacts.suggestGreetings(uid(req), wanted, {
    myLanguage: req.body?.my_language || 'en',
    context: await contextText(uid(req), req.body?.context_id),
    refresh: Boolean(req.body?.refresh),
  });
}));

router.post('/group-messages', handle(async (req) => contacts.groupMessages(uid(req), {
  tag: req.body?.tag,
  contact_ids: req.body?.contact_ids,
  purpose: req.body?.purpose,
  my_language: req.body?.my_language || 'en',
  context: await contextText(uid(req), req.body?.context_id),
})));

// ---------------------------------------------------------------
// Morning summary
// ---------------------------------------------------------------
router.get('/monitor/settings', handle(async (req) => monitor.getSettings(uid(req))));

// Replaces the whole settings list: body { rows: [{ kind, value, brand? }] }
router.put('/monitor/settings', handle(async (req) => {
  const rows = (Array.isArray(req.body?.rows) ? req.body.rows : [])
    .filter(r => monitor.KINDS.includes(r.kind) && String(r.value || '').trim())
    .slice(0, 100)
    .map(r => ({ kind: r.kind, value: String(r.value).trim().slice(0, 200), brand: r.brand ? String(r.brand).trim().slice(0, 200) : null }));
  const existing = await monitor.getSettings(uid(req));
  for (const r of existing) await store.remove('copilot_monitor_keywords', uid(req), r.id);
  for (const r of rows) await store.insert('copilot_monitor_keywords', uid(req), r);
  return monitor.getSettings(uid(req));
}));

// Runs in the background (can take a minute); the page polls /monitor/status.
router.post('/monitor/run', handle(async (req) => {
  if (!(await monitor.isConfigured(uid(req)))) throw httpError(400, 'Add at least one brand, product or keyword first');
  monitor.runReport(uid(req), 'manual').catch(err => console.warn('[Copilot] Morning summary failed:', err.message));
  return { started: true };
}));

router.post('/monitor/auto', handle(async (req) => monitor.ensureDaily(uid(req))));

router.get('/monitor/status', handle(async (req) => ({ running: monitor.isRunning(uid(req)), today: contacts.todayStr() })));

router.get('/monitor/reports', handle(async (req) => store.list('copilot_monitor_reports', uid(req), {
  columns: 'id,report_date,status,trigger,created_at,finished_at,error',
  order: { column: 'created_at', ascending: false },
  limit: 100,
})));

router.get('/monitor/reports/:id', handle(async (req) => {
  const r = await store.get('copilot_monitor_reports', uid(req), req.params.id);
  if (!r) throw httpError(404, 'Not found');
  return r;
}));

router.delete('/monitor/reports/:id', handle(async (req) => ({ ok: await store.remove('copilot_monitor_reports', uid(req), req.params.id) })));

module.exports = router;
