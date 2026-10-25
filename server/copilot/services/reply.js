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

// ---------------------------------------------------------------
// Read my screen: image of an email / document / slide / chart →
// extracted text, translation, summary and drafts (if a reply fits).
// ---------------------------------------------------------------
const SCREEN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    content_type: { type: 'string', enum: ['email', 'chat', 'document', 'slide', 'chart', 'image', 'webpage', 'other'] },
    extracted_text: { type: 'string' },
    detected_language: { type: 'string' },
    translation: { type: 'string' },
    summary: { type: 'string' },
    key_points: { type: 'array', items: { type: 'string' } },
    wants: { type: 'array', items: { type: 'string' } },
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
  required: ['content_type', 'extracted_text', 'detected_language', 'translation', 'summary', 'key_points', 'wants', 'drafts', 'uncertain', 'uncertainty_note', 'sources'],
};

async function readScreen(userId, { image, mimeType, ...input }) {
  if (!image || !image.length) throw Object.assign(new Error('No image received'), { status: 400 });
  const myLang = languageName(input.my_language || 'en');
  const replyLang = input.reply_language && input.reply_language !== 'auto' ? languageName(input.reply_language) : null;
  const bg = await loadBackground(userId, {
    context_id: input.context_id,
    document_ids: input.document_ids,
    contact_id: input.contact_id,
  });

  const out = await ai.respond({
    system: `You help ME (the user) understand what is on my screen (an email, chat, document, slide, image or chart) and reply to it.
- "content_type": what the screenshot mainly shows.
- "extracted_text": the important text exactly as written (main message/body, sender, subject, figures). Ignore menus, toolbars and unrelated windows. Max ~3000 characters.
- "detected_language": ISO-639-1 code of the content.
- "translation": the extracted text translated into ${myLang}; empty string if it is already in ${myLang}.
- "summary" (in ${myLang}): what it is and what it means for me, 2–4 sentences. For charts, describe what the data shows; only read values that are clearly visible.
- "key_points" and "wants" (in ${myLang}): main points, and what the sender asks me to do (empty if nothing).
- "drafts": if a reply makes sense (email, chat, request), 2–3 drafts with a short "label" in ${myLang}, written in ${replyLang || 'the language of the content (or the contact\'s preferred language if set)'}; otherwise an empty array.
- If text is unreadable or cut off, say so and set uncertain=true. Never guess unreadable numbers. Never invent my own prices or policies: use placeholders like [confirm price].
- Use web search only when a public fact is needed; list those pages in "sources".
${HONESTY_RULES}`,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: `BACKGROUND:\n${backgroundBlock(bg, input.note || '')}\n\nMY NOTE: ${input.note || '(none)'}\n\nThe screenshot is attached.` },
        { type: 'input_image', image_url: `data:${mimeType || 'image/jpeg'};base64,${image.toString('base64')}`, detail: 'high' },
      ],
    }],
    schema: SCREEN_SCHEMA,
    schemaName: 'screen',
    webSearch: true,
    maxOutputTokens: 3000,
    temperature: 0.4,
  });

  const j = out.json;
  const result = {
    content_type: j.content_type,
    extracted_text: j.extracted_text,
    detected_language: j.detected_language,
    translation: j.translation,
    summary: stripCitationMarkup(j.summary),
    key_points: j.key_points || [],
    wants: j.wants || [],
    drafts: (j.drafts || []).slice(0, 3).map(d => ({ label: d.label, text: stripCitationMarkup(d.text) })),
    uncertain: j.uncertain,
    uncertainty_note: j.uncertainty_note,
    sources: mergeSources(j.sources, out.sources),
  };
  if (result.sources.some(s => !s.verified)) result.uncertain = true;

  // The image itself is not stored, only the extracted text and result.
  const row = await store.insert('copilot_sessions', userId, {
    kind: 'reply',
    title: `Screen (${result.content_type})${bg.contact ? ` — ${bg.contact.name}` : ''}: ${(result.extracted_text.split('\n').find(l => l.trim()) || '').slice(0, 60)}`,
    contact_id: input.contact_id || null,
    context_id: input.context_id || null,
    settings: { channel: 'screen', note: input.note || '', my_language: input.my_language || 'en', reply_language: input.reply_language || 'auto' },
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    transcript: [{ source: 'them', text: result.extracted_text, translation: result.translation }],
    summaries: { summary: result.summary, wants: result.wants },
    suggestions: [result],
    status: 'ended',
  });
  return { id: row.id, ...result };
}

module.exports = { generateReply, readScreen, CHANNELS: Object.keys(CHANNEL_STYLES) };
