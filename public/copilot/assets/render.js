// =============================================================
// Renderers for the three meeting panels (live page, pop-out, history)
// =============================================================

const CopilotRender = (() => {
  const { esc, fmtTime, sourcesHtml, uncertainTag, uncertainNote } = Copilot;

  // In-person mode (one microphone): speaker is a guess, shown with "?"
  function whoHtml(l) {
    if (l.source !== 'room') return `<span class="who ${l.source}">${l.source === 'me' ? 'ME' : 'THEM'}</span>`;
    if (l.speaker === 'me') return '<span class="who me guess" title="Guessed by the AI">ME?</span>';
    if (l.speaker === 'them') return '<span class="who them guess" title="Guessed by the AI">THEM?</span>';
    return '<span class="who voice">VOICE</span>';
  }

  function lineHtml(l) {
    const tr = l.translation && l.translation.trim() && l.translation.trim() !== l.text.trim()
      ? `<div class="line-tr">→ ${esc(l.translation)}</div>`
      : (!l.translated ? '<div class="line-tr muted small">translating…</div>' : '');
    return `<div class="line" data-line="${esc(l.id)}">
      <div class="line-meta">${whoHtml(l)}<span>${fmtTime(l.t)}</span>${l.language ? `<span>${esc(l.language.toUpperCase())}</span>` : ''}</div>
      <div class="line-text">${esc(l.text)}</div>${tr}</div>`;
  }

  function transcriptHtml(lines, { limit } = {}) {
    if (!lines.length) return '<div class="empty">Waiting for speech… lines appear ~5–10 s after someone speaks.</div>';
    const list = limit ? lines.slice(-limit) : lines;
    return list.map(lineHtml).join('');
  }

  // done: Set of action texts ticked by the user
  function panel2Html(p, done = new Set()) {
    if (!p) return '<div class="empty">Updates every ~20 s or when a question is detected.</div>';
    const actions = p.actions || [];
    const qs = p.open_questions || [];
    return `
      <div class="row" style="margin-bottom:6px">${uncertainTag(p)}</div>
      <div class="req-line">${esc(p.request || '—')}</div>
      <div class="section-label">Requested actions</div>
      ${actions.length ? `<ul class="checklist">${actions.map(a => `<li class="${done.has(a) ? 'done' : ''}"><input type="checkbox" data-action="${esc(a)}" ${done.has(a) ? 'checked' : ''} /><span>${esc(a)}</span></li>`).join('')}</ul>` : '<div class="muted small">None yet.</div>'}
      <div class="section-label">Open questions</div>
      ${qs.length ? `<ul class="qlist">${qs.map(q => `<li>${esc(q)}</li>`).join('')}</ul>` : '<div class="muted small">None.</div>'}
      ${uncertainNote(p)}`;
  }

  function panel3Html(p) {
    if (!p) return '<div class="empty">Suggestions appear once the conversation starts.</div>';
    const replies = p.replies || [];
    return `
      <div class="row" style="margin-bottom:8px">${uncertainTag(p)}${p.sources?.length ? '<span class="tag accent">Web researched</span>' : ''}</div>
      <div class="section-label">Say now</div>
      ${replies.length ? replies.map((r, i) => `
        <div class="reply-card">
          <div class="row between"><div class="reply-say">${esc(r.say)}</div><button class="btn-ghost btn-sm" data-copy="${esc(r.say)}">Copy</button></div>
          ${r.meaning ? `<div class="reply-meaning">${esc(r.meaning)}</div>` : ''}
        </div>`).join('') : '<div class="muted small">No reply needed right now.</div>'}
      <div class="section-label">Answer / solution</div>
      <div class="ai-block">${esc(p.solution || '—')}</div>
      ${uncertainNote(p)}
      ${sourcesHtml(p.sources)}`;
  }

  // Plain text versions for text-to-speech
  function panel2Speech(p, spoken) {
    if (!p) return '';
    const parts = [];
    if (p.request && !spoken.has(`r:${p.request}`)) { parts.push(p.request); spoken.add(`r:${p.request}`); }
    for (const a of p.actions || []) if (!spoken.has(`a:${a}`)) { parts.push(`Action: ${a}`); spoken.add(`a:${a}`); }
    for (const q of p.open_questions || []) if (!spoken.has(`q:${q}`)) { parts.push(`Question: ${q}`); spoken.add(`q:${q}`); }
    if (parts.length && p.uncertain) parts.push('Note: uncertain.');
    return parts.join('. ');
  }

  function panel3Speech(p, spoken) {
    if (!p) return '';
    const fresh = (p.replies || []).filter(r => !spoken.has(r.say));
    fresh.forEach(r => spoken.add(r.say));
    if (!fresh.length) return '';
    const text = fresh.map((r, i) => `Option ${i + 1}: ${r.say}`).join('. ');
    return p.uncertain ? `${text}. Careful, this is uncertain.` : text;
  }

  return { whoHtml, lineHtml, transcriptHtml, panel2Html, panel3Html, panel2Speech, panel3Speech };
})();
