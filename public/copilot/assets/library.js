// Context profiles + documents
(() => {
  const { api, esc, $, toast, modal, fmtDateTime } = Copilot;
  Copilot.init('library');

  const TEMPLATE = `Who I am:
My company:
Products / services:
Key prices or terms I can share:
My goals for these meetings:
Tone (e.g. warm, polite, concise):
Things I must not promise: `;

  async function loadContexts() {
    const list = $('#context-list');
    try {
      const rows = await api('/contexts');
      list.innerHTML = rows.length ? rows.map(c => `
        <div class="list-item">
          <div class="grow">
            <div class="title">${esc(c.name)}</div>
            <div class="muted small">${esc((c.text || '').slice(0, 120))}${(c.text || '').length > 120 ? '…' : ''}</div>
          </div>
          <button class="btn-ghost btn-sm" data-edit="${c.id}">Edit</button>
          <button class="btn-ghost btn-sm" data-del="${c.id}">Delete</button>
        </div>`).join('') : '<div class="empty">No profiles yet. Create one to describe yourself and your business.</div>';
      list.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => editContext(rows.find(r => r.id === b.dataset.edit))));
      list.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
        if (!confirm('Delete this profile?')) return;
        await api(`/contexts/${b.dataset.del}`, { method: 'DELETE' });
        loadContexts();
      }));
    } catch (err) {
      list.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  }

  function editContext(ctx) {
    const m = modal(`
      <h2>${ctx ? 'Edit profile' : 'New context profile'}</h2>
      <div class="field"><label>Name</label><input type="text" id="ctx-name" value="${esc(ctx?.name || '')}" placeholder="e.g. Tammy — B2B skincare sales" /></div>
      <div class="field"><label>Context</label><textarea id="ctx-text" rows="14">${esc(ctx?.text ?? TEMPLATE)}</textarea></div>
      <div class="row"><button class="btn-primary" id="ctx-save">Save</button><button class="btn-ghost" data-close>Cancel</button></div>`);
    $('#ctx-save', m.el).addEventListener('click', async () => {
      const body = { name: $('#ctx-name', m.el).value, text: $('#ctx-text', m.el).value };
      try {
        if (ctx) await api(`/contexts/${ctx.id}`, { method: 'PUT', body });
        else await api('/contexts', { method: 'POST', body });
        m.close();
        toast('Profile saved', 'ok');
        loadContexts();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  async function loadDocs() {
    const list = $('#doc-list');
    try {
      const rows = await api('/documents');
      list.innerHTML = rows.length ? rows.map(d => `
        <div class="list-item">
          <div class="grow">
            <div class="title">${esc(d.file_name)}</div>
            <div class="muted small">${((d.size_bytes || 0) / 1024).toFixed(0)} KB · ${(d.char_count || 0).toLocaleString()} characters · ${fmtDateTime(d.created_at)}</div>
          </div>
          <button class="btn-ghost btn-sm" data-view="${d.id}">Preview</button>
          <button class="btn-ghost btn-sm" data-del="${d.id}">Delete</button>
        </div>`).join('') : '<div class="empty">No documents yet.</div>';
      list.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', async () => {
        const d = await api(`/documents/${b.dataset.view}`);
        modal(`<h2>${esc(d.file_name)}</h2><p class="muted small" style="margin-bottom:8px">Extracted text (first 3,000 characters)</p><div class="subcard ai-block small">${esc(d.preview)}</div><div class="row" style="margin-top:12px"><button class="btn-ghost" data-close>Close</button></div>`);
      }));
      list.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
        if (!confirm('Delete this document?')) return;
        await api(`/documents/${b.dataset.del}`, { method: 'DELETE' });
        loadDocs();
      }));
    } catch (err) {
      list.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  }

  $('#new-context').addEventListener('click', () => editContext(null));

  $('#upload-btn').addEventListener('click', async () => {
    const files = [...$('#doc-file').files];
    if (!files.length) return toast('Choose a file first', 'error');
    const btn = $('#upload-btn');
    btn.disabled = true;
    for (const f of files) {
      if (f.size > 10 * 1024 * 1024) { toast(`${f.name} is larger than 10 MB`, 'error'); continue; }
      btn.textContent = `Uploading ${f.name}…`;
      const form = new FormData();
      form.append('file', f);
      try {
        await api('/documents', { method: 'POST', form });
        toast(`${f.name} uploaded`, 'ok');
      } catch (err) {
        toast(`${f.name}: ${err.message}`, 'error');
      }
    }
    btn.disabled = false;
    btn.textContent = 'Upload';
    $('#doc-file').value = '';
    loadDocs();
  });

  loadContexts();
  loadDocs();
})();
