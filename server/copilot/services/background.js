// =============================================================
// copilot/services/background.js
// Loads what the AI should know about the user before a session:
// context profile text, selected documents, selected contact.
// =============================================================

const store = require('./store');
const { relevantChunks } = require('./documents');
const { contactBlock } = require('./prompts');

async function loadBackground(userId, { context_id, context_text, document_ids, contact_id } = {}) {
  let contextText = (context_text || '').trim();
  if (!contextText && context_id) {
    const ctx = await store.get('copilot_contexts', userId, context_id);
    contextText = ctx?.text || '';
  }

  const docs = [];
  for (const id of document_ids || []) {
    const d = await store.get('copilot_documents', userId, id);
    if (d) docs.push({ file_name: d.file_name, text: d.text || '' });
  }

  const contact = contact_id ? await store.get('copilot_contacts', userId, contact_id) : null;
  return { contextText: contextText.slice(0, 5000), docs, contact };
}

// Prompt-ready background block, with document chunks picked by `query`.
function backgroundBlock(bg, query, { docChars = 6000 } = {}) {
  const parts = [];
  if (bg.contextText) parts.push(`ABOUT ME (the user) — context profile:\n${bg.contextText}`);
  if (bg.contact) parts.push(`THE PERSON I AM TALKING TO:\n${contactBlock(bg.contact)}`);
  const chunks = relevantChunks(bg.docs, query, docChars);
  if (chunks) parts.push(`MY DOCUMENTS (relevant excerpts):\n${chunks}`);
  return parts.join('\n\n') || '(No context profile or documents provided.)';
}

module.exports = { loadBackground, backgroundBlock };
