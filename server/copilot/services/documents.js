// =============================================================
// copilot/services/documents.js
// Text extraction (PDF, DOCX, TXT, MD) and keyword retrieval of
// relevant chunks for prompts.
// =============================================================

const path = require('path');

const ALLOWED_EXT = ['.pdf', '.docx', '.txt', '.md'];
const MAX_TEXT_CHARS = 400000; // ~100k tokens per document is plenty for a pilot

async function extractText(fileName, buffer) {
  const ext = path.extname(fileName || '').toLowerCase();
  let text = '';
  if (ext === '.pdf') {
    // lib path avoids pdf-parse's debug self-test in index.js
    const pdfParse = require('pdf-parse/lib/pdf-parse.js');
    const out = await pdfParse(buffer);
    text = out.text || '';
  } else if (ext === '.docx') {
    const mammoth = require('mammoth');
    const out = await mammoth.extractRawText({ buffer });
    text = out.value || '';
  } else if (ext === '.txt' || ext === '.md') {
    text = buffer.toString('utf8');
  } else {
    throw new Error(`Unsupported file type ${ext}. Use PDF, DOCX, TXT or MD.`);
  }
  text = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.slice(0, MAX_TEXT_CHARS);
}

// ---------------------------------------------------------------
// Chunking + retrieval
// ---------------------------------------------------------------
function chunkText(text, size = 1200, overlap = 150) {
  const chunks = [];
  const paragraphs = text.split(/\n\s*\n/);
  let current = '';
  for (const p of paragraphs) {
    if ((current + '\n\n' + p).length > size && current) {
      chunks.push(current.trim());
      current = current.slice(-overlap) + '\n\n' + p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
    while (current.length > size * 1.5) {
      chunks.push(current.slice(0, size).trim());
      current = current.slice(size - overlap);
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

const STOPWORDS = new Set('the a an and or but of to in on for with at by from is are was were be been it this that these those i you he she we they my your our their me us them as if so do does did not no yes can could would should will just about what which who how when where why there here have has had more most some any all also than then too very please'.split(' '));

// Works for space-separated languages; Thai/Chinese/Japanese fall back to
// character bigrams so keyword overlap still has signal.
function tokenize(text) {
  const lower = String(text || '').toLowerCase();
  const words = lower.match(/[\p{L}\p{N}]+/gu) || [];
  const tokens = [];
  for (const w of words) {
    if (/[฀-๿぀-ヿ一-鿿가-힯]/u.test(w) && w.length > 2) {
      for (let i = 0; i < w.length - 1; i++) tokens.push(w.slice(i, i + 2));
    } else if (w.length > 1 && !STOPWORDS.has(w)) {
      tokens.push(w);
    }
  }
  return tokens;
}

// docs: [{ file_name, text }]. Returns a prompt-ready string under maxChars.
function relevantChunks(docs, query, maxChars = 7000) {
  if (!docs || !docs.length) return '';
  const all = [];
  for (const d of docs) {
    for (const c of chunkText(d.text || '')) all.push({ file: d.file_name, text: c });
  }
  if (!all.length) return '';

  const totalChars = all.reduce((n, c) => n + c.text.length, 0);
  let picked;
  if (totalChars <= maxChars) {
    picked = all;
  } else {
    // BM25-lite scoring against the query
    const q = [...new Set(tokenize(query))];
    const df = new Map();
    const chunkTokens = all.map(c => {
      const toks = tokenize(c.text);
      const set = new Set(toks);
      for (const t of set) df.set(t, (df.get(t) || 0) + 1);
      return toks;
    });
    const N = all.length;
    const scored = all.map((c, i) => {
      const tf = new Map();
      for (const t of chunkTokens[i]) tf.set(t, (tf.get(t) || 0) + 1);
      let score = 0;
      for (const t of q) {
        const f = tf.get(t);
        if (!f) continue;
        const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
        score += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * chunkTokens[i].length / 200));
      }
      return { ...c, score, order: i };
    });
    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    picked = [];
    let used = 0;
    for (const c of scored) {
      if (used + c.text.length > maxChars) continue;
      picked.push(c);
      used += c.text.length;
    }
    picked.sort((a, b) => a.order - b.order);
  }
  return picked.map(c => `[From "${c.file}"]\n${c.text}`).join('\n\n---\n\n').slice(0, maxChars + 500);
}

module.exports = { ALLOWED_EXT, extractText, relevantChunks };
