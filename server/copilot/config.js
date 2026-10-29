// =============================================================
// copilot/config.js
// Env-driven settings for the Sales Copilot module.
// =============================================================

require('dotenv').config();
const crypto = require('crypto');

const email = (process.env.COPILOT_USER_EMAIL || '').trim().toLowerCase();
const password = process.env.COPILOT_USER_PASSWORD || '';

// Signing secret for the session cookie. If none is set, derive a stable one
// from the credentials so a restart does not log the user out.
const sessionSecret = process.env.COPILOT_SESSION_SECRET
  || crypto.createHash('sha256').update(`copilot:${email}:${password}`).digest('hex');

module.exports = {
  openaiKey: process.env.OPENAI_API_KEY || '',
  openaiBaseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  llmModel: process.env.COPILOT_LLM_MODEL || 'gpt-4.1-mini',
  transcribeModel: process.env.COPILOT_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',
  ttsModel: process.env.COPILOT_TTS_MODEL || 'gpt-4o-mini-tts',
  // Drafts (Reply assistant, Read my screen): low volume, quality matters most
  replyModel: process.env.COPILOT_REPLY_MODEL || 'gpt-4.1',
  ttsVoice: process.env.COPILOT_TTS_VOICE || 'coral',
  webSearchTool: process.env.COPILOT_WEB_SEARCH_TOOL || 'web_search',
  timezone: process.env.COPILOT_TIMEZONE || 'Asia/Bangkok',

  userEmail: email,
  userPassword: password,
  // Single pilot user. Every row carries this id so more users can be added later.
  userId: process.env.COPILOT_USER_ID || 'owner',
  sessionSecret,
  sessionDays: 14,

  // Supabase service role key bypasses RLS on copilot tables. Falls back to the
  // shared anon client if absent (then RLS must allow it, see copilot_setup.sql).
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  localStorePath: process.env.COPILOT_LOCAL_STORE || require('path').join(__dirname, '../../data/copilot-store.json'),
};
