// =============================================================
// copilot/services/languages.js
// Supported languages (ISO-639-1 code → English name).
// =============================================================

const LANGUAGES = {
  en: 'English',
  th: 'Thai',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  vi: 'Vietnamese',
  id: 'Indonesian',
  ms: 'Malay',
  tl: 'Filipino',
  hi: 'Hindi',
  ar: 'Arabic',
  ru: 'Russian',
  es: 'Spanish',
  pt: 'Portuguese',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  nl: 'Dutch',
};

function languageName(code, fallback = 'English') {
  return LANGUAGES[code] || fallback;
}

module.exports = { LANGUAGES, languageName };
