// =============================================================
// copilot/services/reply.js
// Paste & Copy Reply: summary of what they want + 2–3 drafts in the
// channel's style. Saved as copilot_sessions rows with kind='reply'.
// =============================================================

const store = require('./store');
const ai = require('./openai');
const { languageName } = require('./languages');
const { loadBackground, backgroundBlock } = require('./background');
const { HONESTY_RULES, SOURCES_SCHEMA, mergeSources, stripCitationMarkup } = require('./prompts');

const CHANNEL_STYLES = {
  email: 'Email: subject line on the first line as "Subject: ...", greeting, short paragraphs, polite sign-off with the sender name from my context if known.',
  line: 'LINE chat: short, friendly, conversational; 1–4 short lines; polite particles if Thai (ครับ/ค่ะ per my context); an emoji is fine only if the tone allows.',
  whatsapp: 'WhatsApp: short and friendly messages, a few lines, no subject, light formatting.',
  linkedin: 'LinkedIn message: professional, warm, concise (under 120 words), no hashtags.',
  messenger: 'Facebook Messenger: casual-professional, short, a few lines.',
  sms: 'SMS: very short (under 300 characters), clear, no formatting.',
  other: 'Neutral professional message.',
};

const REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    wants: { type: 'array', items: { type: 'string' } },
    detected_language: { type: 'string' },
    drafts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { label: { type: 'string' }, text: { type: 'string' } },
        required: ['label', 'text'],
      },
    },
    uncertain: { type: 'boolean' },
    uncertainty_note: { type: 'string' },
    sources: SOURCES_SCHEMA,
  },
  required: ['summary', 'wants', 'detected_language', 'drafts', 'uncertain', 'uncertainty_note', 'sources'],
};

async function generateReply(userId, input) {
  const channel = CHANNEL_STYLES[input.channel] ? input.channel : 'other';
  const conversation = String(input.text || '').slice(0, 20000).trim();
  if (!conversation) throw Object.assign(new Error('Paste the conversation or email first'), { status: 400 });

  const myLang = languageName(input.my_language || 'en');
  const replyLang = input.reply_language && input.reply_language !== 'auto'
    ? languageName(input.reply_language)
    : null;

  const bg = await loadBackground(userId, {
    context_id: input.context_id,
    document_ids: input.document_ids,
    contact_id: input.contact_id,
  });

  const out = await ai.respond({
    system: `You help ME (the user) reply to a message on ${channel.toUpperCase()}.
Channel style: ${CHANNEL_STYLES[channel]}
- "summary" (in ${myLang}): what they want, 1–3 sentences.
- "wants" (in ${myLang}): their requests/questions as short bullet items.
- "detected_language": ISO-639-1 code of the incoming message.
- "drafts": 2–3 alternative replies ready to send, each with a short "label" in ${myLang} (e.g. "Short & friendly", "Detailed", "Formal"). Write the drafts in ${replyLang || "the same language as the incoming message (or the contact's preferred language if set)"}.
- Follow my note/instructions if given. Use my context, documents and the contact's preferences.
- Use web search only when a public fact is needed. Never guess my own prices, stock or policies: if they are missing, write a placeholder like [confirm price] in the draft and set uncertain=true.
- "sources": every web page you relied on (title + url). Empty array if none.
${HONESTY_RULES}`,
    input: `BACKGROUND:\n${backgroundBlock(bg, conversation.slice(-3000))}\n\nMY NOTE: ${input.note || '(none)'}\n\nCONVERSATION / EMAIL:\n${conversation}`,
    schema: REPLY_SCHEMA,
    schemaName: 'reply',
    webSearch: true,
    maxOutputTokens: 2000,
    temperature: 0.6,
  });

  const j = out.json;
  const result = {
    summary: stripCitationMarkup(j.summary),
    wants: j.wants || [],
    detected_language: j.detected_language,
    drafts: (j.drafts || []).slice(0, 3).map(d => ({ label: d.label, text: stripCitationMarkup(d.text) })),
    uncertain: j.uncertain,
    uncertainty_note: j.uncertainty_note,
    sources: mergeSources(j.sources, out.sources),
  };
  if (result.sources.some(s => !s.verified)) result.uncertain = true;

  const firstLine = conversation.split('\n').find(l => l.trim()) || '';
  const row = await store.insert('copilot_sessions', userId, {
    kind: 'reply',
    title: `${channel.toUpperCase()} reply${bg.contact ? ` to ${bg.contact.name}` : ''}: ${firstLine.slice(0, 60)}`,
    contact_id: input.contact_id || null,
    context_id: input.context_id || null,
    settings: { channel, note: input.note || '', my_language: input.my_language || 'en', reply_language: input.reply_language || 'auto', document_ids: input.document_ids || [] },
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    transcript: [{ source: 'them', text: conversation }],
    summaries: { summary: result.summary, wants: result.wants },
    suggestions: [result],
    status: 'ended',
  });

  return { id: row.id, ...result };
}

module.exports = { generateReply, CHANNELS: Object.keys(CHANNEL_STYLES) };
