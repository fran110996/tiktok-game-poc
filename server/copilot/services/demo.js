// =============================================================
// copilot/services/demo.js
// Demo mode: example answers with the same shape as the real AI,
// so every screen can be tried without an OpenAI API key.
// Nothing here is presented as real research: no web links are
// invented, and texts are marked as demo.
// =============================================================

// Scripted conversation (a Thai distributor asking about a serum).
const SCRIPT = [
  { source: 'them', lang: 'th', text: 'สวัสดีค่ะ สนใจเซรั่มวิตามินซีของคุณค่ะ', tr: 'Hello, I am interested in your vitamin C serum.' },
  { source: 'me', lang: 'en', text: 'Thank you for meeting me today. Happy to tell you more about it.', tr: '' },
  { source: 'them', lang: 'th', text: 'ถ้าสั่ง 100 ชิ้น ราคาส่งเท่าไหร่คะ', tr: 'If I order 100 pieces, what is the wholesale price?' },
  { source: 'me', lang: 'en', text: 'For 100 pieces we can offer a better price than our standard list.', tr: '' },
  { source: 'them', lang: 'th', text: 'ส่งแคตตาล็อกกับใบเสนอราคาให้ทาง LINE ได้ไหมคะ', tr: 'Can you send the catalogue and a quotation via LINE?' },
  { source: 'them', lang: 'th', text: 'แล้วจัดส่งภายในกี่วันคะ', tr: 'And how many days does delivery take?' },
  { source: 'me', lang: 'en', text: 'Let me check the delivery time and confirm.', tr: '' },
  { source: 'them', lang: 'th', text: 'มีสินค้าตัวอย่างให้ลองก่อนไหมคะ', tr: 'Do you have samples I can try first?' },
];

const translations = new Map(SCRIPT.map(l => [l.text, l]));
const cursors = new Map(); // key → { i, last }

// Returns the next scripted line for this source (at most one every ~6 s).
function transcribe({ source = 'them', sessionKey = 'default' } = {}) {
  const key = `${sessionKey}:${source}`;
  const c = cursors.get(key) || { i: 0, last: 0 };
  if (Date.now() - c.last < 6000) return '';
  const pool = source === 'room' ? SCRIPT : SCRIPT.filter(l => l.source === source);
  const line = pool[c.i % pool.length];
  c.i += 1;
  c.last = Date.now();
  cursors.set(key, c);
  return line.text;
}

function messagesFromInput(input) {
  const blocks = String(input || '').split('### ID: ').slice(1);
  return blocks.map(b => {
    const id = b.split('\n')[0].trim();
    const name = (b.match(/Contact: ([^\n(]+)/) || [])[1]?.trim() || 'there';
    const occasion = (b.match(/Occasion: ([^\n]+)/) || [])[1] || '';
    let message = `Hi ${name}, I hope you are doing well! I wanted to reach out personally — let me know if there is anything I can help you with. (demo message)`;
    if (/birthday/i.test(occasion)) message = `Happy birthday, ${name}! Wishing you a wonderful year ahead full of health and success. (demo message)`;
    else if (/wedding/i.test(occasion)) message = `Happy anniversary, ${name}! Wishing you both many more happy years together. (demo message)`;
    else if (/illness/i.test(occasion)) message = `Hi ${name}, I heard you were not feeling well. Wishing you a quick and full recovery — take good care. (demo message)`;
    else if (/promotion/i.test(occasion)) message = `Congratulations on your new role, ${name}! Very well deserved. (demo message)`;
    else if (/follow-up/i.test(occasion)) message = `Hi ${name}, just checking in on our last conversation. Would this week be a good time for a quick call? (demo message)`;
    return { id, message };
  });
}

// Same shape as each real structured answer, keyed by schema name.
function respond({ schemaName, input, schema }) {
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  let json;
  switch (schemaName) {
    case 'translation': {
      const l = translations.get(String(input).trim());
      json = { language: l?.lang || 'en', translation: l?.tr || '' };
      if (schema?.properties?.speaker) json.speaker = l ? l.source : 'unknown';
      break;
    }
    case 'requests':
      json = {
        request: 'They want wholesale pricing for 100 pieces, a catalogue and quotation via LINE, the delivery time and samples.',
        actions: ['Send the catalogue via LINE', 'Send a quotation for 100 pieces', 'Confirm the delivery time', 'Offer samples'],
        open_questions: ['Wholesale price for 100 pieces?', 'How many days for delivery?', 'Are samples available?'],
        uncertain: true,
        uncertainty_note: 'Demo mode: example answer. The real AI would check your documents for the price and delivery time.',
      };
      break;
    case 'suggestions':
      json = {
        replies: [
          { say: 'ได้ค่ะ เดี๋ยวส่งแคตตาล็อกและใบเสนอราคาให้ทาง LINE วันนี้เลยค่ะ', meaning: "Sure, I'll send the catalogue and quotation via LINE today." },
          { say: 'สำหรับ 100 ชิ้น เรามีราคาพิเศษค่ะ ขอเช็กแล้วยืนยันอีกครั้งนะคะ', meaning: 'For 100 pieces we have a special price — let me check and confirm.' },
          { say: 'มีตัวอย่างให้ลองค่ะ จะส่งไปพร้อมใบเสนอราคานะคะ', meaning: "We have samples — I'll send them with the quotation." },
        ],
        solution: '(Demo answer) Confirm interest, promise the catalogue and a quotation for 100 pieces via LINE today, and check the delivery time before committing. Offer samples to speed up the decision.',
        uncertain: true,
        uncertainty_note: 'Demo mode: no real AI or web search was used. Prices and delivery times must come from your documents.',
        sources: [],
      };
      break;
    case 'summary':
      json = {
        summary: '(Demo summary) The customer is interested in the vitamin C serum, asked for wholesale pricing for 100 pieces, a catalogue and quotation via LINE, delivery time and samples.',
        key_points: ['Interested in vitamin C serum', 'Volume: 100 pieces', 'Prefers LINE for documents'],
        next_steps: ['Send catalogue and quotation via LINE today', 'Confirm delivery time', 'Arrange samples'],
      };
      break;
    case 'reply':
      json = {
        summary: '(Demo) They are asking for information and a reply from you.',
        wants: ['A clear answer to their question', 'Next steps'],
        detected_language: 'en',
        drafts: [
          { label: 'Short & friendly', text: 'Hi! Thanks for your message. I will send you the details and our price list today. [confirm price] (demo draft)' },
          { label: 'Detailed', text: 'Hello, thank you for reaching out. Please find our latest catalogue attached. For your volume, the price would be [confirm price] with delivery in [confirm days]. Happy to arrange samples as well. Best regards (demo draft)' },
        ],
        uncertain: true,
        uncertainty_note: 'Demo mode: example drafts, the message was not really analysed.',
        sources: [],
      };
      break;
    case 'screen':
      json = {
        content_type: 'other',
        extracted_text: '(Demo mode: the image was not really read. With an OpenAI API key, the text on your screen appears here.)',
        detected_language: 'en',
        translation: '',
        summary: '(Demo) Example result. Add an OpenAI API key in Settings to read real emails, documents, slides and charts.',
        key_points: ['Example key point'],
        wants: ['Example request from the sender'],
        drafts: [{ label: 'Example reply', text: 'Hi, thank you for your email. I will get back to you with the details shortly. (demo draft)' }],
        uncertain: true,
        uncertainty_note: 'Demo mode: nothing was read from the image.',
        sources: [],
      };
      break;
    case 'messages':
      json = { messages: messagesFromInput(text) };
      break;
    case 'briefing': {
      const terms = (text.match(/Terms \([^)]*\): (.*)/) || [])[1] || 'your keywords';
      json = {
        found: false,
        items: [],
        note: `Demo mode: no web search was done for "${terms}". Add an OpenAI API key in Settings to get real news with source links.`,
      };
      break;
    }
    default:
      json = {};
  }
  return { json, text: JSON.stringify(json), sources: [], searched: false, demo: true };
}

module.exports = { transcribe, respond };
