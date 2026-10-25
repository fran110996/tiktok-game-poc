// =============================================================
// copilot/services/openai.js
// Server-side OpenAI calls (Responses API, transcription, TTS).
// The API key never leaves the server.
// =============================================================

const config = require('../config');
const keys = require('./keys');
const demo = require('./demo');

const API = config.openaiBaseUrl;

class OpenAIError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function ensureKey() {
  if (!keys.getKey()) throw new OpenAIError('No OpenAI API key is set (Settings → OpenAI API key)', 503);
}

async function postJson(pathname, body, { timeoutMs = 90000 } = {}) {
  ensureKey();
  const res = await fetch(`${API}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${keys.getKey()}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new OpenAIError(data?.error?.message || `OpenAI error ${res.status}`, res.status);
  }
  return data;
}

// ---------------------------------------------------------------
// Collect text + cited sources from a Responses API result.
// ---------------------------------------------------------------
function parseResponse(data) {
  let text = '';
  const sources = new Map();
  let searched = false;

  for (const item of data.output || []) {
    if (item.type === 'web_search_call') {
      searched = true;
      for (const s of item.action?.sources || []) {
        if (s.url && !sources.has(s.url)) sources.set(s.url, { url: s.url, title: s.title || s.url, cited: false });
      }
    }
    if (item.type !== 'message') continue;
    for (const part of item.content || []) {
      if (part.type !== 'output_text') continue;
      text += part.text || '';
      for (const ann of part.annotations || []) {
        if (ann.type === 'url_citation' && ann.url) {
          sources.set(ann.url, { url: ann.url, title: ann.title || ann.url, cited: true });
        }
      }
    }
  }
  return { text, sources: [...sources.values()], searched };
}

// ---------------------------------------------------------------
// respond(): one Responses API call.
//   system, input     — prompt text
//   schema            — optional JSON schema (strict structured output)
//   webSearch         — allow the web search tool
//   searchContextSize — 'low' | 'medium' | 'high'
// Returns { json?, text, sources, searched }
// ---------------------------------------------------------------
async function respond({ system, input, schema, schemaName = 'result', webSearch = false, maxOutputTokens = 1500, temperature = 0.4, searchContextSize = 'medium', model }) {
  if (keys.isDemo()) return demo.respond({ schemaName, input, schema });
  const body = {
    model: model || config.llmModel,
    instructions: system,
    input,
    max_output_tokens: maxOutputTokens,
    temperature,
    store: false,
  };
  if (schema) {
    body.text = { format: { type: 'json_schema', name: schemaName, schema, strict: true } };
  }
  if (webSearch) {
    body.tools = [{ type: config.webSearchTool, search_context_size: searchContextSize }];
    body.tool_choice = 'auto';
    body.include = ['web_search_call.action.sources'];
  }

  let data;
  try {
    data = await postJson('/responses', body);
  } catch (err) {
    // Older accounts / models: retry with the legacy preview tool and no include.
    if (webSearch && err.status === 400 && /include|tool|web_search|search_context/i.test(err.message)) {
      console.warn('[Copilot] Web search call rejected, retrying with web_search_preview:', err.message);
      body.tools = [{ type: 'web_search_preview', search_context_size: searchContextSize }];
      delete body.include;
      data = await postJson('/responses', body);
    } else if (err.status === 400 && /temperature/i.test(err.message)) {
      delete body.temperature;
      data = await postJson('/responses', body);
    } else {
      throw err;
    }
  }

  const parsed = parseResponse(data);
  if (schema) {
    try {
      parsed.json = JSON.parse(parsed.text);
    } catch (err) {
      throw new OpenAIError('The AI returned an unreadable answer. Please try again.', 502);
    }
  }
  return parsed;
}

// ---------------------------------------------------------------
// transcribe(): audio buffer → text
// ---------------------------------------------------------------
async function transcribe(buffer, { mimeType = 'audio/webm', language, prompt, source, sessionKey } = {}) {
  if (keys.isDemo()) return demo.transcribe({ source, sessionKey });
  ensureKey();
  const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : mimeType.includes('wav') ? 'wav' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType.split(';')[0] }), `chunk.${ext}`);
  form.append('model', config.transcribeModel);
  form.append('response_format', 'json');
  if (language) form.append('language', language);
  if (prompt) form.append('prompt', prompt.slice(-800));

  const res = await fetch(`${API}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${keys.getKey()}` },
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new OpenAIError(data?.error?.message || `Transcription error ${res.status}`, res.status);
  return (data.text || '').trim();
}

// ---------------------------------------------------------------
// speech(): text → mp3 (returns a fetch Response to stream)
// ---------------------------------------------------------------
async function speech(text, { voice, instructions } = {}) {
  // Demo mode: the browser speaks with its own built-in voice instead
  if (keys.isDemo()) throw Object.assign(new OpenAIError('Demo mode: using the browser voice', 503), { demo: true });
  ensureKey();
  const res = await fetch(`${API}/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${keys.getKey()}`,
    },
    body: JSON.stringify({
      model: config.ttsModel,
      voice: voice || config.ttsVoice,
      input: text.slice(0, 4000),
      instructions: instructions || 'Speak clearly and calmly at a natural, slightly brisk pace, like a discreet assistant whispering notes.',
      response_format: 'mp3',
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new OpenAIError(data?.error?.message || `TTS error ${res.status}`, res.status);
  }
  return res;
}

module.exports = { respond, transcribe, speech, OpenAIError };
