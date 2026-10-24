// Upcoming events & greetings + group message helper
(() => {
  const { api, esc, $, toast, pref, meta, fmtDate } = Copilot;
  Copilot.init('upcoming');

  const ICON = { birthday: '🎂', wedding: '💍', illness: '💐', promotion: '🎉', custom: '📌', 'follow-up': '↻' };
  let contacts = [];

  function whenLabel(i) {
    if (i.overdue) return `<span class="tag red">Overdue · ${esc(fmtDate(i.date))}</span>`;
    if (i.in_days === 0) return '<span class="tag green">Today</span>';
    if (i.in_days === 1) return '<span class="tag green">Tomorrow</span>';
    return `<span class="tag">In ${i.in_days} days · ${esc(fmtDate(i.date))}</span>`;
  }

  async function load(refresh = false) {
    const list = $('#upcoming-list');
    let data;
    try {
      data = await api('/upcoming?days=14');
    } catch (err) {
      list.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
      return;
    }
    $('#range').textContent = `Events and follow-ups from ${fmtDate(data.today)} to ${fmtDate(data.end)}, with a suggested message for each.`;
    if (!data.items.length) {
      list.innerHTML = '<div class="empty">Nothing in the next 14 days. Add birthdays, events or follow-up dates to your <a href="/copilot/contacts">contacts</a>.</div>';
      return;
    }
    list.innerHTML = data.items.map((i, n) => `
      <div class="list-item" style="align-items:flex-start">
        <div style="font-size:1.4rem;width:30px;text-align:center">${ICON[i.type] || '📌'}</div>
        <div class="grow">
          <div class="row"><a class="title" href="/copilot/contacts?id=${i.contact.id}">${esc(i.contact.name)}</a>
            <span class="muted small">${esc(i.contact.company || '')}</span>${whenLabel(i)}</div>
          <div class="small muted" style="margin:2px 0 8px">${esc(i.label)}${i.years ? ` · ${i.years} years` : ''}${i.note ? ` — ${esc(i.note)}` : ''}</div>
          <div class="subcard"><div class="draft-text" id="msg-${n}" style="margin:0"><span class="spinner"></span> <span class="muted">Writing a message…</span></div></div>
        </div>
        <button class="btn-primary btn-sm" data-copy-target="#msg-${n}">Copy</button>
      </div>`).join('');

    try {
      const msgs = await api('/upcoming/suggestions', {
        method: 'POST',
        body: { refresh, my_language: pref('myLanguage') || 'en', context_id: $('#context').value || null },
      });
      const byId = new Map(msgs.map(m => [m.id, m.message]));
      data.items.forEach((i, n) => {
        $(`#msg-${n}`).textContent = byId.get(i.id) || '(No suggestion — try Regenerate)';
      });
    } catch (err) {
      data.items.forEach((i, n) => { $(`#msg-${n}`).innerHTML = `<span class="muted">${esc(err.message)}</span>`; });
    }
  }

  // ---------------------------------------------------------------
  // Group messages
  // ---------------------------------------------------------------
  async function setupGroup() {
    const m = await meta();
    contacts = await api('/contacts');
    const tags = [...new Set([...m.tags, ...contacts.flatMap(c => c.tags || [])])];
    $('#g-tag').innerHTML = '<option value="">— Choose a tag —</option>' + tags.map(t => `<option>${esc(t)}</option>`).join('');
    $('#g-tag').addEventListener('change', () => {
      const tag = $('#g-tag').value;
      const list = contacts.filter(c => (c.tags || []).includes(tag));
      $('#g-contacts').innerHTML = !tag ? '<span class="muted">Choose a tag.</span>'
        : list.length ? list.map(c => `<label class="check"><input type="checkbox" value="${c.id}" checked /> ${esc(c.name)}${c.company ? ` <span class="muted">· ${esc(c.company)}</span>` : ''}</label>`).join('')
          : '<span class="muted">No contacts with this tag.</span>';
    });
  }

  $('#g-go').addEventListener('click', async () => {
    const ids = [...document.querySelectorAll('#g-contacts input:checked')].map(i => i.value);
    if (!ids.length) return toast('Pick at least one contact', 'error');
    if (!$('#g-purpose').value.trim()) return toast('Describe what the message is about', 'error');
    const btn = $('#g-go');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Writing…';
    try {
      const res = await api('/group-messages', {
        method: 'POST',
        body: { contact_ids: ids, purpose: $('#g-purpose').value, my_language: pref('myLanguage') || 'en', context_id: $('#context').value || null },
      });
      $('#g-result').innerHTML = `<div class="stack">${res.map((r, n) => `
        <div class="subcard">
          <div class="row between"><div><b>${esc(r.contact.name)}</b> <span class="muted small">${esc(r.contact.company || '')} ${(r.contact.channels || []).map(ch => `· ${esc(ch.channel)}: ${esc(ch.handle)}`).join(' ')}</span></div>
          <button class="btn-primary btn-sm" data-copy-target="#g-msg-${n}">Copy</button></div>
          <div class="draft-text" id="g-msg-${n}">${esc(r.message)}</div>
        </div>`).join('')}</div>`;
    } catch (err) {
      $('#g-result').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = '✦ Write messages';
    }
  });

  (async () => {
    const contexts = await api('/contexts').catch(() => []);
    $('#context').innerHTML += contexts.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    const last = pref('lastContext');
    if (last && contexts.some(c => c.id === last)) $('#context').value = last;
    load();
    setupGroup().catch(() => {});
  })();
  $('#regen').addEventListener('click', () => load(true));
})();
