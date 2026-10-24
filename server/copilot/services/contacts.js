// =============================================================
// copilot/services/contacts.js
// Contacts, events, upcoming view and greeting / group messages.
// =============================================================

const store = require('./store');
const ai = require('./openai');
const config = require('../config');
const { languageName } = require('./languages');
const { contactBlock } = require('./prompts');

const PRESET_TAGS = ['journalist', 'KOL', 'new customer', 'existing customer', 'ongoing client'];
const EVENT_TYPES = ['birthday', 'wedding', 'illness', 'promotion', 'custom'];
const RECURRING_TYPES = new Set(['birthday', 'wedding']);

// ---------------------------------------------------------------
// Dates (YYYY-MM-DD in the configured timezone)
// ---------------------------------------------------------------
function todayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function nextAnniversary(dateStr, today) {
  const [, m, d] = dateStr.split('-').map(Number);
  let year = Number(today.slice(0, 4));
  const make = (y) => {
    const day = m === 2 && d === 29 && !isLeap(y) ? 28 : d;
    return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  };
  let next = make(year);
  if (next < today) next = make(year + 1);
  return next;
}

function sanitizeContact(input) {
  const tags = Array.isArray(input.tags) ? input.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 20) : [];
  const channels = Array.isArray(input.channels)
    ? input.channels.filter(c => c && c.handle).map(c => ({ channel: String(c.channel || 'other').slice(0, 40), handle: String(c.handle).slice(0, 200) })).slice(0, 20)
    : [];
  const p = input.preferences || {};
  const date = /^\d{4}-\d{2}-\d{2}$/.test(input.follow_up_date || '') ? input.follow_up_date : null;
  return {
    name: String(input.name || '').trim().slice(0, 200),
    company: String(input.company || '').trim().slice(0, 200),
    tags: [...new Set(tags)],
    channels,
    preferences: {
      language: String(p.language || '').slice(0, 10),
      tone: String(p.tone || '').slice(0, 200),
      best_time: String(p.best_time || '').slice(0, 200),
    },
    notes: String(input.notes || '').slice(0, 5000),
    follow_up_date: date,
  };
}

function sanitizeEvent(input) {
  const type = EVENT_TYPES.includes(input.type) ? input.type : 'custom';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date || '')) throw Object.assign(new Error('Event date is required (YYYY-MM-DD)'), { status: 400 });
  return {
    type,
    label: String(input.label || '').slice(0, 100),
    date: input.date,
    note: String(input.note || '').slice(0, 2000),
  };
}

// ---------------------------------------------------------------
// Upcoming events & follow-ups
// ---------------------------------------------------------------
async function upcoming(userId, days = 14) {
  const today = todayStr();
  const end = addDays(today, days);
  const contacts = await store.list('copilot_contacts', userId);
  const byId = new Map(contacts.map(c => [c.id, c]));
  const events = await store.list('copilot_events', userId);
  const items = [];

  for (const e of events) {
    const contact = byId.get(e.contact_id);
    if (!contact) continue;
    const when = RECURRING_TYPES.has(e.type) ? nextAnniversary(e.date, today) : e.date;
    if (when < today || when > end) continue;
    const years = RECURRING_TYPES.has(e.type) ? Number(when.slice(0, 4)) - Number(e.date.slice(0, 4)) : null;
    items.push({
      id: `event:${e.id}:${when}`,
      kind: 'event',
      type: e.type,
      label: e.label || e.type,
      date: when,
      original_date: e.date,
      years: years && years > 0 && years < 120 ? years : null,
      in_days: daysBetween(today, when),
      note: e.note,
      contact: { id: contact.id, name: contact.name, company: contact.company, tags: contact.tags || [] },
    });
  }

  for (const c of contacts) {
    if (!c.follow_up_date || c.follow_up_date > end) continue;
    items.push({
      id: `followup:${c.id}:${c.follow_up_date}`,
      kind: 'followup',
      type: 'follow-up',
      label: 'Follow-up',
      date: c.follow_up_date,
      in_days: daysBetween(today, c.follow_up_date),
      overdue: c.follow_up_date < today,
      note: c.notes ? c.notes.slice(0, 300) : '',
      contact: { id: c.id, name: c.name, company: c.company, tags: c.tags || [] },
    });
  }

  items.sort((a, b) => a.date.localeCompare(b.date));
  return { today, end, items };
}

// ---------------------------------------------------------------
// Suggested personalised messages
// ---------------------------------------------------------------
const MESSAGES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    messages: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string' }, message: { type: 'string' } },
        required: ['id', 'message'],
      },
    },
  },
  required: ['messages'],
};

const suggestionCache = new Map(); // item id → message

async function writeMessages({ system, entries }) {
  const out = await ai.respond({
    system,
    input: entries.map(e => `### ID: ${e.id}\n${e.brief}`).join('\n\n'),
    schema: MESSAGES_SCHEMA,
    schemaName: 'messages',
    maxOutputTokens: Math.min(400 + entries.length * 250, 6000),
    temperature: 0.7,
  });
  const map = new Map();
  for (const m of out.json.messages || []) map.set(m.id, m.message);
  return map;
}

async function suggestGreetings(userId, items, { myLanguage = 'en', context = '', refresh = false } = {}) {
  const contacts = new Map((await store.list('copilot_contacts', userId)).map(c => [c.id, c]));
  const todo = items.filter(i => refresh || !suggestionCache.has(i.id));
  for (let i = 0; i < todo.length; i += 10) {
    const batch = todo.slice(i, i + 10);
    const entries = batch.map(item => {
      const c = contacts.get(item.contact.id);
      const lang = c?.preferences?.language ? languageName(c.preferences.language, c.preferences.language) : languageName(myLanguage);
      return {
        id: item.id,
        brief: `${contactBlock(c || item.contact)}\nOccasion: ${item.kind === 'followup' ? `follow-up${item.overdue ? ' (overdue)' : ''}` : item.type}${item.label && item.label !== item.type ? ` — ${item.label}` : ''}\nDate: ${item.date} (in ${item.in_days} days)${item.years ? `\nYears: ${item.years}` : ''}\nEvent note: ${item.note || '-'}\nWrite in: ${lang}`,
      };
    });
    const map = await writeMessages({
      system: `You write short personal messages that ME (the user) will copy and send to my contacts.
${context ? `About me:\n${context.slice(0, 2000)}\n` : ''}Rules:
- Match the occasion respectfully: birthday/wedding anniversary → warm congratulations; illness → gentle get-well wishes, no business talk, no medical claims; promotion → congratulations; follow-up → friendly check-in that moves things forward without pressure; custom → appropriate to the note.
- Personalise using the contact's name, company, tags, preferences and notes. Use the contact's preferred tone if given.
- 1–4 sentences. No placeholders except a name when missing. Do not invent shared memories or facts.
- Return one message per ID, in the language requested for that ID.`,
      entries,
    });
    for (const item of batch) if (map.has(item.id)) suggestionCache.set(item.id, map.get(item.id));
  }
  return items.map(i => ({ id: i.id, message: suggestionCache.get(i.id) || '' }));
}

async function groupMessages(userId, { tag, contact_ids, purpose, my_language = 'en', context = '' }) {
  let contacts = await store.list('copilot_contacts', userId);
  if (Array.isArray(contact_ids) && contact_ids.length) contacts = contacts.filter(c => contact_ids.includes(c.id));
  else if (tag) contacts = contacts.filter(c => (c.tags || []).includes(tag));
  contacts = contacts.slice(0, 50);
  if (!contacts.length) return [];
  if (!String(purpose || '').trim()) throw Object.assign(new Error('Describe the purpose of the message'), { status: 400 });

  const results = [];
  for (let i = 0; i < contacts.length; i += 10) {
    const batch = contacts.slice(i, i + 10);
    const map = await writeMessages({
      system: `You write one personalised message per contact that ME (the user) will copy and send individually (no mass-mail tone).
${context ? `About me:\n${context.slice(0, 2000)}\n` : ''}Purpose of the message: ${String(purpose).slice(0, 1500)}
Rules: personalise with name, company, tags, preferences and notes; use each contact's preferred language (otherwise ${languageName(my_language)}) and tone; 2–5 sentences; do not invent facts.`,
      entries: batch.map(c => ({ id: c.id, brief: contactBlock(c) })),
    });
    for (const c of batch) results.push({ contact: { id: c.id, name: c.name, company: c.company, channels: c.channels || [] }, message: map.get(c.id) || '' });
  }
  return results;
}

module.exports = {
  PRESET_TAGS,
  EVENT_TYPES,
  todayStr,
  sanitizeContact,
  sanitizeEvent,
  upcoming,
  suggestGreetings,
  groupMessages,
};
