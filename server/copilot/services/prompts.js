// =============================================================
// copilot/services/prompts.js
// Shared prompt pieces and JSON schemas.
// =============================================================

const HONESTY_RULES = `Honesty rules (mandatory):
- Never invent facts, prices, numbers, dates, names, policies or product features.
- Only state facts that come from the provided context, documents, conversation, or web search results.
- If you are not sure, set "uncertain" to true and explain briefly in "uncertainty_note" what is unknown and how to confirm it.
- When you use web search, every researched fact must be supported by a cited source.`;

// Replies are written BY the user TO the other person, and never invent
// business facts (the AI otherwise tends to promise delivery or prices).
const DRAFT_RULES = `Rules for replies/drafts:
- The incoming message was written BY THEM and sent TO ME. I received it and I am answering it. Their questions are about MY products, prices and services (I am usually the seller).
- Answer their questions. Never repeat their questions back to them and never ask them for information they asked me for.
- Every fact about my business (prices, discounts, stock, delivery areas and times, policies, availability) must come from my context or documents. If it is not there, do not say yes or no: put a bracketed placeholder where the answer goes, for me to fill in, e.g. [confirm price for 100 units], [confirm delivery to Bangkok].
- Sign with my name from my context if known, otherwise [Your name].
Example — incoming: "How much is the serum for 100 units? Can you deliver to Bangkok?" (price and delivery not in my context)
  GOOD: "Thank you for your interest! For 100 units the price is [confirm price for 100 units], and delivery to Bangkok is [confirm delivery to Bangkok]. I can send you the catalogue too."
  BAD: "Could you please confirm the price for 100 units? Can you deliver to Bangkok?" (this asks them my own questions)`;

function contactBlock(contact) {
  if (!contact) return '';
  const prefs = contact.preferences || {};
  const channels = (contact.channels || []).map(c => `${c.channel}: ${c.handle}`).join(', ');
  return [
    `Contact: ${contact.name}${contact.company ? ` (${contact.company})` : ''}`,
    contact.tags?.length ? `Tags: ${contact.tags.join(', ')}` : '',
    channels ? `Channels: ${channels}` : '',
    prefs.language ? `Preferred language: ${prefs.language}` : '',
    prefs.tone ? `Preferred tone: ${prefs.tone}` : '',
    prefs.best_time ? `Best time to contact: ${prefs.best_time}` : '',
    contact.notes ? `Notes: ${contact.notes}` : '',
    contact.follow_up_date ? `Follow-up date: ${contact.follow_up_date}` : '',
  ].filter(Boolean).join('\n');
}

const SOURCES_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: { title: { type: 'string' }, url: { type: 'string' } },
    required: ['title', 'url'],
  },
};

// Merge sources the model listed with those the API actually cited.
// Links that never appeared in the search results are flagged unverified.
function mergeSources(modelSources, apiSources) {
  const byUrl = new Map();
  for (const s of apiSources || []) byUrl.set(s.url, { ...s, verified: true });
  const out = [];
  const seen = new Set();
  for (const s of modelSources || []) {
    if (!s || !/^https?:\/\//i.test(s.url || '')) continue;
    const key = s.url;
    if (seen.has(key)) continue;
    seen.add(key);
    const api = byUrl.get(key);
    out.push({ title: s.title || api?.title || key, url: key, verified: Boolean(api) });
  }
  // Cited-in-text sources the model forgot to list
  for (const s of apiSources || []) {
    if (s.cited && !seen.has(s.url)) {
      seen.add(s.url);
      out.push({ title: s.title, url: s.url, verified: true });
    }
  }
  return out;
}

function stripCitationMarkup(text) {
  // Web-search answers sometimes embed "([site](url))" inline — keep text clean.
  return String(text || '').replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, '').trim();
}

module.exports = { HONESTY_RULES, DRAFT_RULES, contactBlock, SOURCES_SCHEMA, mergeSources, stripCitationMarkup };
