// =============================================================
// copilot/services/live.js
// Live meeting assistant: audio chunks → transcript lines (Me/Them)
// → translation → periodic analysis (Panel 2: what they ask for,
// Panel 3: suggested replies & solutions). Updates are pushed over
// the Socket.io namespace /copilot to room `session:<id>`.
// =============================================================

const crypto = require('crypto');
const store = require('./store');
const ai = require('./openai');
const { languageName } = require('./languages');
const { loadBackground, backgroundBlock } = require('./background');
const { HONESTY_RULES, SOURCES_SCHEMA, mergeSources, stripCitationMarkup } = require('./prompts');

const ANALYSIS_INTERVAL_MS = 20000;
const PERSIST_INTERVAL_MS = 60000;
const IDLE_STOP_MS = 30 * 60 * 1000; // tab closed without Stop → auto-stop after 30 min of no audio

// Phrases transcription models tend to produce on silence/noise.
const SILENCE_HALLUCINATIONS = [
  /^thank(s| you)( so much)? for watching[.!]*$/i,
  /^(please )?subscribe[.!]*$/i,
  /^subtitles? by/i,
  /^you[.!]*$/i,
  /^bye[.!]*$/i,
  /^ขอบคุณ(ที่รับชม|ครับ|ค่ะ)?[.!]*$/,
  /^字幕/,
];

const QUESTION_HINT = /\?|？|ไหม|มั้ย|อะไร|เท่าไร|เท่าไหร่|ยังไง|อย่างไร|หรือเปล่า|เมื่อไร|เมื่อไหร่|ที่ไหน|吗|呢|か[。？]?$|\b(how|what|when|where|why|which|who|can you|could you|do you|is there|are there|would you)\b/i;

const PANEL2_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    request: { type: 'string' },
    actions: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
    uncertain: { type: 'boolean' },
    uncertainty_note: { type: 'string' },
  },
  required: ['request', 'actions', 'open_questions', 'uncertain', 'uncertainty_note'],
};

const PANEL3_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    replies: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { say: { type: 'string' }, meaning: { type: 'string' } },
        required: ['say', 'meaning'],
      },
    },
    solution: { type: 'string' },
    uncertain: { type: 'boolean' },
    uncertainty_note: { type: 'string' },
    sources: SOURCES_SCHEMA,
  },
  required: ['replies', 'solution', 'uncertain', 'uncertainty_note', 'sources'],
};

const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    key_points: { type: 'array', items: { type: 'string' } },
    next_steps: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'key_points', 'next_steps'],
};

const TRANSLATE_ROOM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    language: { type: 'string', description: 'ISO-639-1 code of the original text' },
    translation: { type: 'string', description: 'Translation into the target language, or empty string if the text is already in it' },
    speaker: { type: 'string', enum: ['me', 'them', 'unknown'] },
  },
  required: ['language', 'translation', 'speaker'],
};

const TRANSLATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    language: { type: 'string', description: 'ISO-639-1 code of the original text' },
    translation: { type: 'string', description: 'Translation into the target language, or empty string if the text is already in it' },
  },
  required: ['language', 'translation'],
};

class LiveSessions {
  constructor() {
    this.nsp = null;
    this.sessions = new Map();
  }

  attach(nsp) {
    this.nsp = nsp;
  }

  emit(session, event, payload) {
    if (this.nsp) this.nsp.to(`session:${session.id}`).emit(event, payload);
  }

  get(id, userId) {
    const s = this.sessions.get(id);
    return s && s.userId === userId ? s : null;
  }

  snapshot(s) {
    return {
      id: s.id,
      kind: 'meeting',
      live: true,
      title: s.title,
      contact_id: s.settings.contact_id || null,
      settings: s.settings,
      started_at: s.startedAt,
      transcript: s.transcript,
      panel2: s.panel2,
      panel3: s.panel3,
      status: s.status,
    };
  }

  // ---------------------------------------------------------------
  async start(userId, input) {
    const settings = {
      my_language: input.my_language || 'en',
      their_language: input.their_language || 'auto',
      context_id: input.context_id || null,
      context_text: (input.context_text || '').slice(0, 5000),
      document_ids: Array.isArray(input.document_ids) ? input.document_ids.slice(0, 20) : [],
      contact_id: input.contact_id || null,
      sources: input.sources || {},
      // 'meeting': mic = Me + shared audio = Them. 'room': one microphone hears
      // both people (in-person conversation, phone); speakers are guessed.
      mode: input.mode === 'room' ? 'room' : 'meeting',
    };
    const bg = await loadBackground(userId, settings);
    const startedAt = new Date().toISOString();
    const title = (input.title || '').trim()
      || `${settings.mode === 'room' ? 'Conversation' : 'Meeting'}${bg.contact ? ` with ${bg.contact.name}` : ''} — ${new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`;

    const row = await store.insert('copilot_sessions', userId, {
      kind: 'meeting',
      title,
      contact_id: settings.contact_id,
      context_id: settings.context_id,
      settings,
      started_at: startedAt,
      ended_at: null,
      transcript: [],
      summaries: {},
      suggestions: [],
      status: 'live',
    });

    const s = {
      id: row.id,
      userId,
      title,
      settings,
      bg,
      startedAt,
      transcript: [],
      panel2: null,
      panel3: null,
      suggestionsLog: [],
      status: 'live',
      lastAnalyzedCount: 0,
      analyzing: false,
      rerun: false,
      lastAnalysisAt: 0,
      detectedTheirLanguage: null,
      lastActivity: Date.now(),
    };
    s.analysisTimer = setInterval(() => this.analyze(s).catch(() => {}), ANALYSIS_INTERVAL_MS);
    s.persistTimer = setInterval(() => {
      if (Date.now() - s.lastActivity > IDLE_STOP_MS) this.stop(s).catch(() => {});
      else this.persist(s).catch(() => {});
    }, PERSIST_INTERVAL_MS);
    this.sessions.set(s.id, s);
    return this.snapshot(s);
  }

  // ---------------------------------------------------------------
  async addAudio(s, { source, buffer, mimeType, t }) {
    if (s.status !== 'live') return null;
    s.lastActivity = Date.now();
    const isRoom = source === 'room';
    const isMe = source === 'me';
    // Room audio mixes both languages, so let the model detect it.
    const lang = isRoom ? undefined
      : isMe ? s.settings.my_language
        : (s.settings.their_language !== 'auto' ? s.settings.their_language : undefined);
    const prevText = s.transcript.filter(l => l.source === source).slice(-3).map(l => l.text).join(' ');

    let text;
    try {
      text = await ai.transcribe(buffer, { mimeType, language: lang, prompt: prevText, source, sessionKey: s.id });
    } catch (err) {
      this.emit(s, 'copilot:error', { message: `Transcription failed: ${err.message}` });
      throw err;
    }
    if (!text || text.length < 2 || SILENCE_HALLUCINATIONS.some(rx => rx.test(text.trim()))) return null;

    const line = {
      id: crypto.randomUUID(),
      t: Number(t) || Date.now(),
      source: isRoom ? 'room' : isMe ? 'me' : 'them',
      text,
      translation: '',
      language: lang || null,
    };
    if (isRoom) line.speaker = 'unknown';
    this.insertLine(s, line);
    this.emit(s, 'copilot:line', line);

    // Translate to my language (skip if already in it); in room mode also
    // guess who is speaking from my context and the recent conversation.
    try {
      const target = languageName(s.settings.my_language);
      const roomHint = isRoom
        ? `\nThe text comes from ONE microphone that hears both ME (the user) and THEM (the other person). Guess "speaker": "me" or "them" from the content, the conversation so far and what you know about me; use "unknown" if unclear.\nAbout me: ${(s.bg.contextText || '(no context)').slice(0, 600)}\nRecent conversation:\n${this.transcriptText(s, 1200)}`
        : '';
      const out = await ai.respond({
        system: `You are a professional interpreter. Detect the language of the text and translate it into ${target}. Keep the meaning, names and numbers exactly. If the text is already in ${target}, return an empty translation.${roomHint} Output only JSON.`,
        input: text,
        schema: isRoom ? TRANSLATE_ROOM_SCHEMA : TRANSLATE_SCHEMA,
        schemaName: 'translation',
        maxOutputTokens: 600,
        temperature: 0,
      });
      line.language = (out.json.language || line.language || '').slice(0, 5).toLowerCase() || null;
      line.translation = (out.json.translation || '').trim();
      if (isRoom) line.speaker = ['me', 'them'].includes(out.json.speaker) ? out.json.speaker : 'unknown';
      if (!isMe && line.speaker !== 'me' && line.language) s.detectedTheirLanguage = line.language;
    } catch (err) {
      // Transcript line stays without translation
    }
    line.translated = true;
    this.emit(s, 'copilot:line', line);

    if (!isMe && line.speaker !== 'me' && (QUESTION_HINT.test(text) || QUESTION_HINT.test(line.translation)) && Date.now() - s.lastAnalysisAt > 5000) {
      this.analyze(s).catch(() => {});
    }
    return line;
  }

  insertLine(s, line) {
    const idx = s.transcript.findIndex(l => l.t > line.t);
    if (idx === -1) s.transcript.push(line);
    else s.transcript.splice(idx, 0, line);
  }

  transcriptText(s, maxChars = 8000) {
    const lines = s.transcript.map(l => {
      const ts = new Date(l.t).toISOString().slice(11, 19);
      const who = l.source === 'room'
        ? `VOICE (${l.speaker === 'me' ? 'probably ME' : l.speaker === 'them' ? 'probably THEM' : 'speaker unknown'})`
        : l.source === 'me' ? 'ME' : 'THEM';
      return `[${ts}] ${who}: ${l.text}${l.translation ? `  (translation: ${l.translation})` : ''}`;
    });
    let out = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      if (out.length + lines[i].length > maxChars) break;
      out = `${lines[i]}\n${out}`;
    }
    return out.trim();
  }

  theirLanguageCode(s) {
    if (s.settings.their_language && s.settings.their_language !== 'auto') return s.settings.their_language;
    return s.detectedTheirLanguage || s.settings.my_language;
  }

  // ---------------------------------------------------------------
  async analyze(s, { force = false } = {}) {
    if (s.status !== 'live' && !force) return;
    if (!s.transcript.length) return;
    if (!force && s.transcript.length === s.lastAnalyzedCount) return;
    if (s.analyzing) { s.rerun = true; return; }

    s.analyzing = true;
    s.lastAnalysisAt = Date.now();
    s.lastAnalyzedCount = s.transcript.length;
    this.emit(s, 'copilot:analyzing', { on: true });

    const mine = languageName(s.settings.my_language);
    const theirs = languageName(this.theirLanguageCode(s), mine);
    const convo = this.transcriptText(s);
    const recent = this.transcriptText(s, 1500);
    const background = backgroundBlock(s.bg, recent);
    const roomNote = s.settings.mode === 'room'
      ? '\nThis is an in-person conversation recorded by one microphone: lines are labelled VOICE with a guessed speaker, and the guess can be wrong. Use the content to tell who is asking.'
      : '';

    const panel2 = ai.respond({
      system: `You assist ME (the user) live during a sales/business meeting. "THEM" is the other side.${roomNote}
Identify what THEM is asking for or wants. Write in ${mine}.
- "request": one line summarising their main request right now.
- "actions": concrete actions they are asking ME to do (checklist items, short).
- "open_questions": their questions that have not been answered yet.
Use empty arrays when nothing applies. If the transcript is too short or unclear, say so in "request" and set uncertain=true.
${HONESTY_RULES}`,
      input: `BACKGROUND:\n${background}\n\nTRANSCRIPT (oldest → newest):\n${convo}`,
      schema: PANEL2_SCHEMA,
      schemaName: 'requests',
      maxOutputTokens: 700,
      temperature: 0.2,
    });

    const panel3 = ai.respond({
      system: `You assist ME (the user) live during a sales/business meeting. "THEM" is the other side.${roomNote}
Suggest what I can say right now and the best answer/solution.
- "replies": 1–3 short replies I can say now (1–2 sentences each). "say" is written in ${theirs} (the language THEM speaks). "meaning" is the ${mine} translation, or "" if ${theirs} is ${mine}.
- "solution": a concise answer or solution in ${mine} using my context, my documents and the conversation (max ~120 words).
- Use web search only when a factual question cannot be answered from the background (e.g. public facts, market info, regulations, competitor info). Never search for my own private prices or policies — if they are not in my documents, say they must be confirmed.
- "sources": every web page you relied on (title + url). Empty array if none.
${HONESTY_RULES}`,
      input: `BACKGROUND:\n${background}\n\nTRANSCRIPT (oldest → newest):\n${this.transcriptText(s, 6000)}`,
      schema: PANEL3_SCHEMA,
      schemaName: 'suggestions',
      webSearch: true,
      maxOutputTokens: 1200,
      temperature: 0.4,
    });

    const [r2, r3] = await Promise.allSettled([panel2, panel3]);
    const at = new Date().toISOString();

    if (r2.status === 'fulfilled') {
      s.panel2 = { ...r2.value.json, at };
      this.emit(s, 'copilot:panel2', s.panel2);
    } else {
      this.emit(s, 'copilot:error', { message: `Panel 2 update failed: ${r2.reason.message}` });
    }

    if (r3.status === 'fulfilled') {
      const j = r3.value.json;
      s.panel3 = {
        replies: (j.replies || []).slice(0, 3),
        solution: stripCitationMarkup(j.solution),
        uncertain: j.uncertain,
        uncertainty_note: j.uncertainty_note,
        sources: mergeSources(j.sources, r3.value.sources),
        searched: r3.value.searched,
        at,
      };
      if (s.panel3.sources.some(src => !src.verified)) s.panel3.uncertain = true;
      s.suggestionsLog.push(s.panel3);
      this.emit(s, 'copilot:panel3', s.panel3);
    } else {
      this.emit(s, 'copilot:error', { message: `Panel 3 update failed: ${r3.reason.message}` });
    }

    s.analyzing = false;
    this.emit(s, 'copilot:analyzing', { on: false });
    if (s.rerun) {
      s.rerun = false;
      setTimeout(() => this.analyze(s).catch(() => {}), 1000);
    }
  }

  async persist(s, extra = {}) {
    await store.update('copilot_sessions', s.userId, s.id, {
      transcript: s.transcript,
      summaries: { ...(s.summaries || {}), panel2: s.panel2 },
      suggestions: s.suggestionsLog.slice(-50),
      ...extra,
    });
  }

  // ---------------------------------------------------------------
  async stop(s) {
    if (s.status !== 'live') return null;
    s.status = 'stopping';
    clearInterval(s.analysisTimer);
    clearInterval(s.persistTimer);
    this.emit(s, 'copilot:status', { status: 'stopping' });

    s.summaries = { panel2: s.panel2 };
    if (s.transcript.length) {
      try {
        const out = await ai.respond({
          system: `Summarise this meeting for ME (the user) in ${languageName(s.settings.my_language)}. "summary": 3–5 sentences. "key_points": what was discussed/agreed. "next_steps": follow-ups for me. ${HONESTY_RULES}`,
          input: this.transcriptText(s, 20000),
          schema: SUMMARY_SCHEMA,
          schemaName: 'summary',
          maxOutputTokens: 900,
          temperature: 0.2,
        });
        s.summaries.final = out.json;
      } catch (err) {
        s.summaries.final = null;
      }
    }

    const endedAt = new Date().toISOString();
    await this.persist(s, { ended_at: endedAt, status: 'ended' });
    s.status = 'ended';
    this.sessions.delete(s.id);
    this.emit(s, 'copilot:status', { status: 'ended', summaries: s.summaries });
    return { id: s.id, ended_at: endedAt, summaries: s.summaries };
  }
}

module.exports = new LiveSessions();
