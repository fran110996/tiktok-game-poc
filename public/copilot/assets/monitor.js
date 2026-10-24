// Morning summary: settings, run, reports
(() => {
  const { api, esc, $, toast, meta, fmtDate, fmtDateTime, hostname } = Copilot;
  Copilot.init('monitor');

  let langOrder = [];
  let pollTimer = null;

  // ---------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------
  function lines(id) {
    return $(id).value.split('\n').map(s => s.trim()).filter(Boolean);
  }

  function splitBrand(line) {
    const idx = line.indexOf(':');
    if (idx > 0 && !/^https?$/i.test(line.slice(0, idx))) return { brand: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
    return { brand: null, value: line };
  }

  async function loadSettings() {
    const [rows, m] = await Promise.all([api('/monitor/settings'), meta()]);
    const of = (k) => rows.filter(r => r.kind === k);
    $('#s-brands').value = of('brand').map(r => r.value).join('\n');
    $('#s-products').value = of('product').map(r => (r.brand ? `${r.brand}: ${r.value}` : r.value)).join('\n');
    $('#s-keywords').value = of('keyword').map(r => (r.brand ? `${r.brand}: ${r.value}` : r.value)).join('\n');
    $('#s-sites').value = of('site').map(r => r.value).join('\n');
    langOrder = of('language').map(r => r.value);
    if (!langOrder.length) langOrder = ['en'];
    $('#s-langs').innerHTML = Object.entries(m.languages).map(([k, v]) => `<label class="check" style="width:120px"><input type="checkbox" value="${k}" ${langOrder.includes(k) ? 'checked' : ''} /> ${esc(v)}</label>`).join('');
    $('#s-langs').querySelectorAll('input').forEach(i => i.addEventListener('change', () => {
      if (i.checked) langOrder.push(i.value); else langOrder = langOrder.filter(x => x !== i.value);
    }));
  }

  async function saveSettings() {
    const rows = [
      ...lines('#s-brands').map(v => ({ kind: 'brand', value: v })),
      ...lines('#s-products').map(l => ({ kind: 'product', ...splitBrand(l) })),
      ...lines('#s-keywords').map(l => ({ kind: 'keyword', ...splitBrand(l) })),
      ...lines('#s-sites').map(v => ({ kind: 'site', value: v.replace(/^https?:\/\//, '').replace(/\/$/, '') })),
      ...langOrder.map(v => ({ kind: 'language', value: v })),
    ];
    await api('/monitor/settings', { method: 'PUT', body: { rows } });
    toast('Settings saved', 'ok');
  }

  // ---------------------------------------------------------------
  // Reports
  // ---------------------------------------------------------------
  function reportHtml(r) {
    if (r.status === 'running') return '<div class="empty"><span class="spinner"></span> Searching the web… this takes about a minute.</div>';
    if (r.status === 'error') return `<div class="notice error">Run failed: ${esc(r.error || 'unknown error')}</div>`;
    const groups = r.groups || [];
    if (!groups.length) return '<div class="empty">Empty report.</div>';
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    return `
      <p class="small muted" style="margin-bottom:12px">${total} item${total === 1 ? '' : 's'} · ${groups.length} group${groups.length === 1 ? '' : 's'} · finished ${fmtDateTime(r.finished_at)} · ${r.trigger === 'auto' ? 'automatic run' : 'manual run'}</p>
      ${groups.map(g => `
        <div class="subcard" style="margin-bottom:12px">
          <div class="row between" style="margin-bottom:6px">
            <h3 style="margin:0">${esc(g.label)} <span class="tag">${esc(g.kind)}</span></h3>
            ${g.terms.length > 1 ? `<span class="small muted">${esc(g.terms.slice(1).join(', '))}</span>` : ''}
          </div>
          ${g.items.length ? `<div class="list">${g.items.map(i => `
            <div class="list-item" style="align-items:flex-start">
              <div class="grow">
                <a class="title" href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">${esc(i.headline)}</a>
                <div class="small" style="margin:3px 0">${esc(i.summary)}</div>
                <div class="small muted">${esc(i.source || hostname(i.url))} · ${i.date === 'unknown' ? '<span class="tag uncertain">Date unknown</span>' : esc(fmtDate(i.date))}
                  ${i.verified === false ? ' <span class="tag uncertain">⚠ Uncertain — link not confirmed by search</span>' : ''}</div>
              </div>
            </div>`).join('')}</div>`
            : `<div class="${g.error ? 'notice error' : 'muted small'}">${g.error ? '' : 'Nothing found. '}${esc(g.note || '')}</div>`}
        </div>`).join('')}`;
  }

  async function showReport(id) {
    const r = await api(`/monitor/reports/${id}`);
    $('#report-title').textContent = `Report · ${fmtDate(r.report_date)}`;
    $('#report').innerHTML = reportHtml(r);
    if (r.status === 'running') {
      clearTimeout(pollTimer);
      pollTimer = setTimeout(() => showReport(id).then(loadReports), 5000);
    }
  }

  async function loadReports(selectLatest = false) {
    const rows = await api('/monitor/reports');
    $('#report-list').innerHTML = rows.length ? rows.map(r => `
      <a class="list-item" href="#" data-id="${r.id}" style="color:inherit;text-decoration:none">
        <div class="grow"><div class="title">${esc(fmtDate(r.report_date))}</div><div class="small muted">${fmtDateTime(r.created_at)} · ${r.trigger}</div></div>
        <span class="tag ${r.status === 'done' ? 'green' : r.status === 'error' ? 'red' : ''}">${r.status}</span>
      </a>`).join('') : '<div class="empty">No reports yet.</div>';
    $('#report-list').querySelectorAll('[data-id]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); showReport(a.dataset.id); }));
    if (selectLatest) {
      if (rows.length) showReport(rows[0].id);
      else $('#report').innerHTML = '<div class="empty">No reports yet. Add brands or keywords in Settings, save, then click “Run now”.</div>';
    }
  }

  async function pollStatus() {
    const s = await api('/monitor/status');
    $('#run-btn').disabled = s.running;
    $('#run-status').innerHTML = s.running ? '<span class="spinner"></span> Running…' : '';
    if (s.running) setTimeout(pollStatus, 4000);
    return s;
  }

  $('#save-settings').addEventListener('click', () => saveSettings().catch(err => toast(err.message, 'error')));

  $('#run-btn').addEventListener('click', async () => {
    try {
      await saveSettings();
      await api('/monitor/run', { method: 'POST' });
      toast('Morning summary started');
      setTimeout(() => { loadReports(true); pollStatus(); }, 800);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  loadSettings().catch(err => toast(err.message, 'error'));
  loadReports(true).catch(err => toast(err.message, 'error'));
  pollStatus().catch(() => {});
})();
