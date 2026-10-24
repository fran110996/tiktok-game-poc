// Contacts: list, form, events, history
(() => {
  const { api, esc, $, toast, modal, meta, fmtDate, fmtDateTime } = Copilot;
  Copilot.init('contacts');

  const CHANNELS = ['Email', 'LINE', 'WhatsApp', 'LinkedIn', 'Messenger', 'Phone', 'Instagram', 'Other'];
  let all = [];

  function tagsHtml(tags) {
    return `<span class="tags">${(tags || []).map(t => `<span class="tag accent">${esc(t)}</span>`).join('')}</span>`;
  }

  // ---------------------------------------------------------------
  // List
  // ---------------------------------------------------------------
  async function loadList() {
    all = await api('/contacts');
    const m = await meta();
    const tagSet = new Set([...m.tags, ...all.flatMap(c => c.tags || [])]);
    const sel = $('#tag-filter');
    const cur = sel.value;
    sel.innerHTML = '<option value="">All tags</option>' + [...tagSet].map(t => `<option>${esc(t)}</option>`).join('');
    sel.value = cur;
    renderList();
  }

  function renderList() {
    const q = $('#search').value.trim().toLowerCase();
    const tag = $('#tag-filter').value;
    const rows = all.filter(c => (!tag || (c.tags || []).includes(tag))
      && (!q || `${c.name} ${c.company} ${c.notes}`.toLowerCase().includes(q)));
    $('#contact-list').innerHTML = rows.length ? rows.map(c => `
      <a class="list-item" href="/copilot/contacts?id=${c.id}" style="color:inherit;text-decoration:none">
        <div class="grow">
          <div class="title">${esc(c.name)} ${c.company ? `<span class="muted small">· ${esc(c.company)}</span>` : ''}</div>
          <div class="small" style="margin-top:4px">${tagsHtml(c.tags)}</div>
        </div>
        ${c.follow_up_date ? `<span class="tag ${c.follow_up_date < new Date().toISOString().slice(0, 10) ? 'red' : ''}">Follow up ${esc(fmtDate(c.follow_up_date))}</span>` : ''}
      </a>`).join('') : `<div class="empty">${all.length ? 'No match.' : 'No contacts yet.'}</div>`;
  }

  // ---------------------------------------------------------------
  // Form
  // ---------------------------------------------------------------
  async function editContact(c) {
    const m = await meta();
    const langOpts = '<option value="">—</option>' + Object.entries(m.languages).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
    const tags = new Set(c?.tags || []);
    const custom = [...tags].filter(t => !m.tags.includes(t));
    const md = modal(`
      <h2>${c ? 'Edit contact' : 'New contact'}</h2>
      <div class="grid grid-2" style="gap:10px">
        <div class="field"><label>Name *</label><input type="text" id="f-name" value="${esc(c?.name || '')}" /></div>
        <div class="field"><label>Company</label><input type="text" id="f-company" value="${esc(c?.company || '')}" /></div>
      </div>
      <div class="field"><label>Tags</label>
        <div class="row" id="f-tags">${m.tags.map(t => `<label class="check"><input type="checkbox" value="${esc(t)}" ${tags.has(t) ? 'checked' : ''} /> ${esc(t)}</label>`).join('')}</div>
        <input type="text" id="f-custom-tags" style="margin-top:8px" placeholder="Custom tags, comma separated" value="${esc(custom.join(', '))}" />
      </div>
      <div class="field"><label>Channels / handles</label><div id="f-channels" class="stack"></div>
        <button class="btn-ghost btn-sm" id="f-add-channel" style="margin-top:6px">+ Add channel</button></div>
      <div class="grid grid-3" style="gap:10px">
        <div class="field"><label>Preferred language</label><select id="f-lang">${langOpts}</select></div>
        <div class="field"><label>Tone</label><input type="text" id="f-tone" value="${esc(c?.preferences?.tone || '')}" placeholder="e.g. formal, uses ครับ/ค่ะ" /></div>
        <div class="field"><label>Best time</label><input type="text" id="f-time" value="${esc(c?.preferences?.best_time || '')}" placeholder="e.g. weekday mornings" /></div>
      </div>
      <div class="field"><label>Follow-up date</label><input type="date" id="f-follow" value="${esc(c?.follow_up_date || '')}" /></div>
      <div class="field"><label>Notes</label><textarea id="f-notes" rows="4">${esc(c?.notes || '')}</textarea></div>
      ${c ? '' : `<div class="field"><label>Birthday (optional — creates a yearly event)</label><input type="date" id="f-birthday" /></div>`}
      <div class="row"><button class="btn-primary" id="f-save">Save</button><button class="btn-ghost" data-close>Cancel</button></div>`);

    const el = md.el;
    $('#f-lang', el).value = c?.preferences?.language || '';
    const chBox = $('#f-channels', el);
    const addChannel = (ch = { channel: 'LINE', handle: '' }) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<select style="width:140px">${CHANNELS.map(x => `<option ${x === ch.channel ? 'selected' : ''}>${x}</option>`).join('')}</select>
        <input type="text" style="flex:1" placeholder="handle, email or number" value="${esc(ch.handle)}" />
        <button class="btn-ghost btn-sm">✕</button>`;
      row.querySelector('button').addEventListener('click', () => row.remove());
      chBox.appendChild(row);
    };
    (c?.channels?.length ? c.channels : [{ channel: 'LINE', handle: '' }]).forEach(addChannel);
    $('#f-add-channel', el).addEventListener('click', () => addChannel());

    $('#f-save', el).addEventListener('click', async () => {
      const tagList = [...el.querySelectorAll('#f-tags input:checked')].map(i => i.value)
        .concat($('#f-custom-tags', el).value.split(',').map(s => s.trim()).filter(Boolean));
      const body = {
        name: $('#f-name', el).value,
        company: $('#f-company', el).value,
        tags: tagList,
        channels: [...chBox.children].map(r => ({ channel: r.querySelector('select').value, handle: r.querySelector('input').value.trim() })).filter(x => x.handle),
        preferences: { language: $('#f-lang', el).value, tone: $('#f-tone', el).value, best_time: $('#f-time', el).value },
        follow_up_date: $('#f-follow', el).value || null,
        notes: $('#f-notes', el).value,
      };
      try {
        const saved = c ? await api(`/contacts/${c.id}`, { method: 'PUT', body }) : await api('/contacts', { method: 'POST', body });
        const bday = !c && $('#f-birthday', el)?.value;
        if (bday) await api(`/contacts/${saved.id}/events`, { method: 'POST', body: { type: 'birthday', date: bday } });
        md.close();
        toast('Contact saved', 'ok');
        location.href = `/copilot/contacts?id=${saved.id}`;
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  // ---------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------
  async function editEvent(contactId, ev) {
    const m = await meta();
    const md = modal(`
      <h2>${ev ? 'Edit event' : 'New event'}</h2>
      <div class="grid grid-2" style="gap:10px">
        <div class="field"><label>Type</label><select id="e-type">${m.event_types.map(t => `<option value="${t}">${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}</select></div>
        <div class="field"><label>Date</label><input type="date" id="e-date" value="${esc(ev?.date || '')}" /></div>
      </div>
      <div class="field"><label>Label (for custom events)</label><input type="text" id="e-label" value="${esc(ev?.label || '')}" placeholder="e.g. Company anniversary" /></div>
      <div class="field"><label>Note</label><textarea id="e-note" rows="3">${esc(ev?.note || '')}</textarea></div>
      <p class="small muted" style="margin-bottom:12px">Birthday and wedding repeat every year. Use the real year if you know it (used for age / anniversary years).</p>
      <div class="row"><button class="btn-primary" id="e-save">Save</button><button class="btn-ghost" data-close>Cancel</button></div>`);
    $('#e-type', md.el).value = ev?.type || 'birthday';
    $('#e-save', md.el).addEventListener('click', async () => {
      const body = { type: $('#e-type', md.el).value, date: $('#e-date', md.el).value, label: $('#e-label', md.el).value, note: $('#e-note', md.el).value };
      try {
        if (ev) await api(`/events/${ev.id}`, { method: 'PUT', body });
        else await api(`/contacts/${contactId}/events`, { method: 'POST', body });
        md.close();
        loadDetail(contactId);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  // ---------------------------------------------------------------
  // Detail
  // ---------------------------------------------------------------
  async function loadDetail(id) {
    $('#list-view').classList.add('hidden');
    $('#detail-view').classList.remove('hidden');
    let c;
    try {
      c = await api(`/contacts/${id}`);
    } catch (err) {
      $('#detail-view').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
      return;
    }
    const m = await meta();
    $('#c-name').textContent = c.name;
    $('#c-sub').innerHTML = `${esc(c.company || '')} ${tagsHtml(c.tags)}`;
    $('#c-meet').href = `/copilot/session?contact=${c.id}`;
    $('#c-reply').href = `/copilot/reply?contact=${c.id}`;
    const p = c.preferences || {};
    $('#c-details').innerHTML = `
      <table class="simple">
        <tr><th>Channels</th><td>${(c.channels || []).map(ch => `<div>${esc(ch.channel)}: <b>${esc(ch.handle)}</b> <button class="btn-ghost btn-sm" data-copy="${esc(ch.handle)}">Copy</button></div>`).join('') || '—'}</td></tr>
        <tr><th>Language</th><td>${esc(m.languages[p.language] || p.language || '—')}</td></tr>
        <tr><th>Tone</th><td>${esc(p.tone || '—')}</td></tr>
        <tr><th>Best time</th><td>${esc(p.best_time || '—')}</td></tr>
        <tr><th>Follow-up</th><td>${c.follow_up_date ? esc(fmtDate(c.follow_up_date)) : '—'}</td></tr>
        <tr><th>Notes</th><td class="ai-block">${esc(c.notes || '—')}</td></tr>
      </table>`;

    $('#c-events').innerHTML = c.events.length ? c.events.map(e => `
      <div class="list-item">
        <span class="tag">${esc(e.type)}</span>
        <div class="grow"><div class="title">${esc(e.label || e.type)} · ${esc(fmtDate(e.date))}</div>${e.note ? `<div class="small muted">${esc(e.note)}</div>` : ''}</div>
        <button class="btn-ghost btn-sm" data-ev-edit="${e.id}">Edit</button>
        <button class="btn-ghost btn-sm" data-ev-del="${e.id}">Delete</button>
      </div>`).join('') : '<div class="empty">No events.</div>';
    $('#c-events').querySelectorAll('[data-ev-edit]').forEach(b => b.addEventListener('click', () => editEvent(c.id, c.events.find(e => e.id === b.dataset.evEdit))));
    $('#c-events').querySelectorAll('[data-ev-del]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Delete this event?')) return;
      await api(`/events/${b.dataset.evDel}`, { method: 'DELETE' });
      loadDetail(c.id);
    }));

    $('#c-history').innerHTML = c.history.length ? c.history.map(h => `
      <a class="list-item" href="/copilot/history?id=${h.id}" style="color:inherit;text-decoration:none">
        <span class="tag ${h.kind === 'reply' ? 'accent' : 'green'}">${h.kind === 'reply' ? 'Reply' : 'Meeting'}</span>
        <div class="grow"><div class="title">${esc(h.title)}</div><div class="small muted">${fmtDateTime(h.started_at)}</div></div>
      </a>`).join('') : '<div class="empty">No sessions or drafts linked yet.</div>';

    $('#c-edit').onclick = () => editContact(c);
    $('#c-add-event').onclick = () => editEvent(c.id, null);
    $('#c-delete').onclick = async () => {
      if (!confirm(`Delete ${c.name} and their events?`)) return;
      await api(`/contacts/${c.id}`, { method: 'DELETE' });
      location.href = '/copilot/contacts';
    };
  }

  $('#new-contact').addEventListener('click', () => editContact(null));
  $('#search').addEventListener('input', renderList);
  $('#tag-filter').addEventListener('change', renderList);

  const id = new URLSearchParams(location.search).get('id');
  if (id) loadDetail(id);
  else loadList().catch(err => toast(err.message, 'error'));
})();
