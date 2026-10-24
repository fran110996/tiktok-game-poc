// Home dashboard
(() => {
  const { api, esc, $, fmtDate, fmtDateTime } = Copilot;
  Copilot.init('home');

  const h = new Date().getHours();
  $('#greeting').textContent = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  $('#today').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  api('/upcoming?days=14').then(d => {
    $('#home-upcoming').innerHTML = d.items.length ? d.items.slice(0, 6).map(i => `
      <a class="list-item" href="/copilot/upcoming" style="color:inherit;text-decoration:none">
        <div class="grow"><div class="title">${esc(i.contact.name)} <span class="muted small">· ${esc(i.label)}</span></div>
        <div class="small muted">${i.overdue ? 'Overdue — ' : ''}${esc(fmtDate(i.date))}</div></div>
        <span class="tag ${i.in_days <= 1 ? 'green' : ''}">${i.overdue ? 'overdue' : i.in_days === 0 ? 'today' : `${i.in_days} d`}</span>
      </a>`).join('') : '<div class="empty">Nothing in the next 14 days.</div>';
  }).catch(err => { $('#home-upcoming').innerHTML = `<div class="empty">${esc(err.message)}</div>`; });

  async function monitor() {
    const [reports, status] = await Promise.all([api('/monitor/reports'), api('/monitor/status')]);
    const today = reports.find(r => r.report_date === status.today);
    if (status.running || today?.status === 'running') {
      $('#home-monitor').innerHTML = '<div class="empty"><span class="spinner"></span> Preparing today\'s summary…</div>';
      setTimeout(monitor, 6000);
      return;
    }
    if (!today) {
      $('#home-monitor').innerHTML = '<div class="empty">No summary today yet. <a href="/copilot/monitor">Set up brands & keywords</a>.</div>';
      return;
    }
    const full = await api(`/monitor/reports/${today.id}`);
    const groups = full.groups || [];
    $('#home-monitor').innerHTML = groups.length ? groups.map(g => `
      <div style="margin-bottom:10px"><b>${esc(g.label)}</b> <span class="muted small">— ${g.items.length ? `${g.items.length} item${g.items.length === 1 ? '' : 's'}` : 'nothing found'}</span>
        ${g.items.slice(0, 2).map(i => `<div class="small" style="margin-top:3px">• <a href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">${esc(i.headline)}</a> <span class="muted">${i.date === 'unknown' ? '' : esc(i.date)}</span></div>`).join('')}
      </div>`).join('') : `<div class="empty">${esc(full.error || 'Empty report')}</div>`;
  }
  monitor().catch(err => { $('#home-monitor').innerHTML = `<div class="empty">${esc(err.message)}</div>`; });

  api('/sessions?limit=6').then(rows => {
    $('#home-recent').innerHTML = rows.length ? rows.map(s => `
      <a class="list-item" href="/copilot/${s.live ? 'session' : 'history'}?id=${s.id}" style="color:inherit;text-decoration:none">
        <span class="tag ${s.kind === 'reply' ? 'accent' : 'green'}">${s.kind === 'reply' ? 'Reply' : 'Meeting'}</span>
        <div class="grow"><div class="title">${esc(s.title)}</div><div class="small muted">${fmtDateTime(s.started_at)}</div></div>
        ${s.live ? '<span class="tag red">● Live</span>' : ''}
      </a>`).join('') : '<div class="empty">No sessions yet.</div>';
  }).catch(err => { $('#home-recent').innerHTML = `<div class="empty">${esc(err.message)}</div>`; });
})();
