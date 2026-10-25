// Session history (meetings + reply drafts)
(() => {
  const { api, esc, $, toast, fmtDateTime, sourcesHtml, uncertainTag, uncertainNote } = Copilot;
  const R = CopilotRender;
  Copilot.init('history');

  let contacts = new Map();

  async function loadList() {
    const kind = $('#kind-filter').value;
    const list = $('#session-list');
    try {
      const rows = await api(`/sessions${kind ? `?kind=${kind}` : ''}`);
      list.innerHTML = rows.length ? rows.map(s => {
        const c = contacts.get(s.contact_id);
        const summary = s.kind === 'reply' ? s.summaries?.summary : s.summaries?.final?.summary;
        return `<a class="list-item" href="/copilot/history?id=${s.id}" style="color:inherit;text-decoration:none">
          <span class="tag ${s.kind === 'reply' ? 'accent' : 'green'}">${s.kind === 'reply' ? 'Reply' : 'Meeting'}</span>
          <div class="grow">
            <div class="title">${esc(s.title || 'Untitled')}</div>
            <div class="muted small">${fmtDateTime(s.started_at)}${c ? ` · ${esc(c.name)}` : ''}${summary ? ` · ${esc(summary.slice(0, 110))}${summary.length > 110 ? '…' : ''}` : ''}</div>
          </div>
          ${s.live ? '<span class="tag red">● Live</span>' : (s.status === 'live' ? '<span class="tag">Interrupted</span>' : '')}
        </a>`;
      }).join('') : '<div class="empty">Nothing yet. Start a session or use the reply assistant.</div>';
    } catch (err) {
      list.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  }

  function transcriptPlain(s) {
    const who = (l) => (l.source === 'room' ? (l.speaker === 'me' ? 'ME?' : l.speaker === 'them' ? 'THEM?' : 'VOICE') : l.source === 'me' ? 'ME' : 'THEM');
    return (s.transcript || []).map(l => `[${l.t ? new Date(l.t).toLocaleTimeString('en-GB') : ''}] ${who(l)}: ${l.text}${l.translation ? `\n    → ${l.translation}` : ''}`).join('\n');
  }

  function meetingHtml(s) {
    const f = s.summaries?.final;
    const p2 = s.summaries?.panel2;
    const lastSuggestion = (s.suggestions || []).slice(-1)[0];
    return `
      ${f ? `<div class="card"><h2>Summary</h2><p>${esc(f.summary)}</p>
        ${f.key_points?.length ? `<div class="section-label">Key points</div><ul class="qlist">${f.key_points.map(k => `<li>${esc(k)}</li>`).join('')}</ul>` : ''}
        ${f.next_steps?.length ? `<div class="section-label">Next steps</div><ul class="qlist">${f.next_steps.map(k => `<li>${esc(k)}</li>`).join('')}</ul>` : ''}</div>` : ''}
      <div class="grid grid-2">
        <div class="card"><h2>What they asked for (last update)</h2>${R.panel2Html(p2)}</div>
        <div class="card"><h2>Last suggestions</h2>${R.panel3Html(lastSuggestion)}</div>
      </div>
      <div class="card"><h2>Transcript (${(s.transcript || []).length} lines)</h2>${R.transcriptHtml((s.transcript || []).map(l => ({ ...l, translated: true })))}</div>
      ${(s.suggestions || []).length > 1 ? `<div class="card"><h2>All suggestions during the meeting</h2>${s.suggestions.map(p => `<div class="subcard" style="margin-bottom:10px"><div class="small muted">${fmtDateTime(p.at)}</div>${R.panel3Html(p)}</div>`).join('')}</div>` : ''}`;
  }

  function replyHtml(s) {
    const r = (s.suggestions || [])[0] || {};
    return `
      <div class="grid grid-2">
        <div class="card"><h2>${s.settings?.channel === 'screen' ? 'Read from screen' : `Incoming (${esc((s.settings?.channel || '').toUpperCase())})`}</h2><div class="ai-block small">${esc(s.transcript?.[0]?.text || '')}</div>
          ${s.transcript?.[0]?.translation ? `<div class="section-label">Translation</div><div class="ai-block small">${esc(s.transcript[0].translation)}</div>` : ''}
          ${s.settings?.note ? `<div class="section-label">My note</div><div>${esc(s.settings.note)}</div>` : ''}</div>
        <div class="card"><h2>What they want ${uncertainTag(r)}</h2><p>${esc(r.summary || '')}</p>
          ${r.wants?.length ? `<ul class="qlist" style="margin-top:8px">${r.wants.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}${uncertainNote(r)}</div>
      </div>
      <div class="card"><h2>Drafts</h2><div class="grid grid-3">
        ${(r.drafts || []).map((d, i) => `<div class="subcard draft"><div class="row between"><b>${esc(d.label)}</b><button class="btn-primary btn-sm" data-copy-target="#draft-${i}">Copy</button></div><div class="draft-text" id="draft-${i}">${esc(d.text)}</div></div>`).join('')}
      </div>${sourcesHtml(r.sources)}</div>`;
  }

  async function loadDetail(id) {
    $('#list-view').classList.add('hidden');
    $('#detail-view').classList.remove('hidden');
    let s;
    try {
      s = await api(`/sessions/${id}`);
    } catch (err) {
      $('#d-body').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
      return;
    }
    if (s.live) {
      location.href = `/copilot/session?id=${id}`;
      return;
    }
    const c = contacts.get(s.contact_id);
    $('#d-title').textContent = s.title || 'Untitled';
    $('#d-meta').innerHTML = `${s.kind === 'reply' ? (s.settings?.channel === 'screen' ? 'Read my screen' : 'Reply assistant') : (s.settings?.mode === 'room' ? 'In-person conversation' : 'Online meeting')} · ${fmtDateTime(s.started_at)}${s.ended_at && s.kind === 'meeting' ? ` → ${new Date(s.ended_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : ''}${c ? ` · <a href="/copilot/contacts?id=${c.id}">${esc(c.name)}</a>` : ''}${s.status === 'live' ? ' · <span class="tag">Interrupted (server restarted before Stop)</span>' : ''}`;
    $('#d-body').innerHTML = s.kind === 'reply' ? replyHtml(s) : meetingHtml(s);
    $('#d-copy').style.display = s.kind === 'reply' ? 'none' : '';
    $('#d-copy').onclick = (e) => Copilot.copyText(transcriptPlain(s), e.currentTarget);
    $('#d-delete').onclick = async () => {
      if (!confirm('Delete permanently?')) return;
      try {
        await api(`/sessions/${id}`, { method: 'DELETE' });
        location.href = '/copilot/history';
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  (async () => {
    contacts = new Map((await api('/contacts').catch(() => [])).map(c => [c.id, c]));
    const id = new URLSearchParams(location.search).get('id');
    if (id) loadDetail(id);
    else loadList();
  })();
  $('#kind-filter').addEventListener('change', loadList);
})();
