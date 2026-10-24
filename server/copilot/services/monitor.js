// =============================================================
// copilot/services/monitor.js
// Morning summary: web search on brands / products / keywords,
// grouped by brand, every item with a source link and date.
// Runs on "Run now" or the first time the copilot is opened each day
// (no cron: the free Render instance sleeps).
// =============================================================

const store = require('./store');
const ai = require('./openai');
const { languageName } = require('./languages');
const { todayStr } = require('./contacts');

const KINDS = ['brand', 'product', 'keyword', 'site', 'language'];
const running = new Map(); // userId → Promise

const GROUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    found: { type: 'boolean' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          headline: { type: 'string' },
          summary: { type: 'string' },
          url: { type: 'string' },
          source: { type: 'string' },
          date: { type: 'string', description: 'Publication date YYYY-MM-DD, or "unknown"' },
        },
        required: ['headline', 'summary', 'url', 'source', 'date'],
      },
    },
    note: { type: 'string' },
  },
  required: ['found', 'items', 'note'],
};

async function getSettings(userId) {
  const rows = await store.list('copilot_monitor_keywords', userId, { order: { column: 'created_at', ascending: true } });
  return rows;
}

function buildGroups(rows) {
  const brands = rows.filter(r => r.kind === 'brand');
  const groups = brands.map(b => ({ label: b.value, kind: 'brand', terms: [b.value] }));
  const byBrand = new Map(groups.map(g => [g.label.toLowerCase(), g]));
  for (const r of rows.filter(x => x.kind === 'product' || x.kind === 'keyword')) {
    const parent = r.brand && byBrand.get(String(r.brand).toLowerCase());
    if (parent) parent.terms.push(r.value);
    else groups.push({ label: r.value, kind: r.kind, terms: [r.value] });
  }
  return groups.slice(0, 15);
}

async function searchGroup(group, { languages, sites, today }) {
  const langNames = languages.map(l => languageName(l, l));
  const out = await ai.respond({
    system: `You are a media monitoring analyst preparing a morning briefing. Today is ${today}.
Search the public web and news for the most recent coverage (prefer the last 7 days, newest first) about the given terms.
${sites.length ? `Check these sites first: ${sites.join(', ')}. Other public sites are allowed.\n` : ''}Search in: ${langNames.join(', ')}. Write headlines and summaries in ${langNames[0]}.
Social networks (Facebook, Instagram, TikTok, X) are best-effort only.
Rules:
- Only include items you actually found in the search results, each with its exact URL, the site/source name and its publication date (YYYY-MM-DD, or "unknown" if not shown).
- Up to 6 items, 1–2 sentence summary each. Skip duplicates and items not really about the terms.
- If nothing relevant was found, set found=false, items=[] and explain in "note". Never invent articles, dates or links.`,
    input: `Terms (${group.kind}): ${group.terms.join(', ')}`,
    schema: GROUP_SCHEMA,
    schemaName: 'briefing',
    webSearch: true,
    searchContextSize: 'medium',
    maxOutputTokens: 1800,
    temperature: 0.2,
  });

  const known = new Set(out.sources.map(s => s.url));
  const items = (out.json.items || [])
    .filter(i => /^https?:\/\//i.test(i.url || ''))
    .map(i => ({ ...i, date: /^\d{4}-\d{2}-\d{2}$/.test(i.date) ? i.date : 'unknown', verified: known.has(i.url) }));
  return {
    label: group.label,
    kind: group.kind,
    terms: group.terms,
    found: items.length > 0,
    note: items.length ? out.json.note : (out.json.note || 'Nothing relevant found in public web/news results.'),
    searched: out.searched,
    items,
  };
}

async function runReport(userId, trigger = 'manual') {
  if (running.has(userId)) return running.get(userId);
  const job = (async () => {
    const rows = await getSettings(userId);
    const groups = buildGroups(rows);
    if (!groups.length) throw Object.assign(new Error('Add at least one brand, product or keyword in Settings first'), { status: 400 });
    const languages = rows.filter(r => r.kind === 'language').map(r => r.value);
    if (!languages.length) languages.push('en');
    const sites = rows.filter(r => r.kind === 'site').map(r => r.value);
    const today = todayStr();

    const report = await store.insert('copilot_monitor_reports', userId, {
      report_date: today,
      status: 'running',
      trigger,
      groups: [],
      settings: { languages, sites, terms: groups.map(g => g.terms) },
      error: null,
      finished_at: null,
    });

    const results = new Array(groups.length);
    let next = 0;
    const worker = async () => {
      while (next < groups.length) {
        const i = next++;
        try {
          results[i] = await searchGroup(groups[i], { languages, sites, today });
        } catch (err) {
          results[i] = { label: groups[i].label, kind: groups[i].kind, terms: groups[i].terms, found: false, items: [], note: `Search failed: ${err.message}`, error: true };
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);

    const allFailed = results.every(r => r.error);
    return store.update('copilot_monitor_reports', userId, report.id, {
      status: allFailed ? 'error' : 'done',
      groups: results,
      error: allFailed ? results[0]?.note : null,
      finished_at: new Date().toISOString(),
    });
  })();
  running.set(userId, job);
  try {
    return await job;
  } finally {
    running.delete(userId);
  }
}

// First open of the day → start a run in the background (if configured).
async function ensureDaily(userId) {
  if (running.has(userId)) return { started: false, running: true };
  const today = todayStr();
  const existing = await store.list('copilot_monitor_reports', userId, { filters: { report_date: today }, columns: 'id,status', limit: 1 });
  if (existing.length) return { started: false, running: false, today };
  const rows = await getSettings(userId);
  if (!buildGroups(rows).length) return { started: false, running: false, configured: false };
  runReport(userId, 'auto').catch(err => console.warn('[Copilot] Morning summary failed:', err.message));
  return { started: true, running: true };
}

async function isConfigured(userId) {
  return buildGroups(await getSettings(userId)).length > 0;
}

function isRunning(userId) {
  return running.has(userId);
}

module.exports = { KINDS, getSettings, runReport, ensureDaily, isRunning, isConfigured };
