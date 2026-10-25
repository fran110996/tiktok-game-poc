// Paste & Copy Reply
(() => {
  const { api, esc, $, toast, pref, fillLanguages, sourcesHtml, uncertainTag, uncertainNote } = Copilot;
  Copilot.init('reply');

  async function setup() {
    const [contexts, contacts, docs] = await Promise.all([
      api('/contexts').catch(() => []),
      api('/contacts').catch(() => []),
      api('/documents').catch(() => []),
    ]);
    await fillLanguages($('#reply-lang'), { auto: true, selected: pref('replyLanguage') || 'auto' });
    $('#reply-lang').options[0].textContent = 'Same as the message';

    $('#context').innerHTML += contexts.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    const lastCtx = pref('lastContext');
    if (lastCtx && contexts.some(c => c.id === lastCtx)) $('#context').value = lastCtx;

    $('#contact').innerHTML += contacts.map(c => `<option value="${c.id}">${esc(c.name)}${c.company ? ` — ${esc(c.company)}` : ''}</option>`).join('');
    const preset = new URLSearchParams(location.search).get('contact');
    if (preset) $('#contact').value = preset;

    $('#channel').value = pref('replyChannel') || 'email';
    $('#doc-checks').innerHTML = docs.length
      ? docs.map(d => `<label class="check"><input type="checkbox" value="${d.id}" /> ${esc(d.file_name)}</label>`).join('')
      : '<span class="muted">No documents.</span>';
  }

  function renderResult(r) {
    $('#result').innerHTML = `
      <div class="row" style="margin-bottom:8px">${uncertainTag(r)}${r.sources?.length ? '<span class="tag accent">Web researched</span>' : ''}</div>
      <div class="section-label">${r.wants?.length ? 'What they want' : 'Goal'}</div>
      <p>${esc(r.summary)}</p>
      ${r.wants?.length ? `<ul class="qlist" style="margin-top:6px">${r.wants.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      ${uncertainNote(r)}
      <div class="section-label" style="margin-top:16px">Drafts</div>
      <div class="stack">
        ${r.drafts.map((d, i) => `
          <div class="subcard draft">
            <div class="row between"><b>${esc(d.label)}</b><button class="btn-primary btn-sm" data-copy-target="#draft-${i}">Copy</button></div>
            <div class="draft-text" id="draft-${i}">${esc(d.text)}</div>
          </div>`).join('')}
      </div>
      ${sourcesHtml(r.sources)}
      <p class="small muted" style="margin-top:12px">Saved to <a href="/copilot/history?id=${r.id}">history</a>.</p>`;
  }

  $('#go').addEventListener('click', async () => {
    const text = $('#text').value.trim();
    if (!text && !$('#note').value.trim()) return toast('Paste a conversation, or describe a new message in the note', 'error');
    const btn = $('#go');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Drafting…';
    $('#result').innerHTML = '<div class="empty"><span class="spinner"></span> Reading the message and drafting replies (may search the web)…</div>';
    pref('replyChannel', $('#channel').value);
    pref('replyLanguage', $('#reply-lang').value);
    try {
      const r = await api('/reply', {
        method: 'POST',
        body: {
          channel: $('#channel').value,
          contact_id: $('#contact').value || null,
          context_id: $('#context').value || null,
          text,
          note: $('#note').value,
          my_language: pref('myLanguage') || 'en',
          reply_language: $('#reply-lang').value,
          document_ids: [...document.querySelectorAll('#doc-checks input:checked')].map(i => i.value),
        },
      });
      renderResult(r);
    } catch (err) {
      $('#result').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = '✦ Draft replies';
    }
  });

  // ---------------------------------------------------------------
  // Read my screen
  // ---------------------------------------------------------------
  async function runScreen(getBlob) {
    let blob;
    try {
      blob = await getBlob();
    } catch (err) {
      if (err.name !== 'NotAllowedError') toast(`Screen capture failed: ${err.message}`, 'error');
      return;
    }
    if (!blob) return;
    blob = await ScreenReader.shrink(blob);
    const url = URL.createObjectURL(blob);
    $('#result').innerHTML = `<img class="screen-shot" src="${url}" alt="" /><div class="empty"><span class="spinner"></span> Reading the screen, translating and drafting…</div>`;
    try {
      const r = await ScreenReader.analyze(blob, {
        context_id: $('#context').value || null,
        contact_id: $('#contact').value || null,
        note: $('#note').value,
        reply_language: $('#reply-lang').value,
        document_ids: [...document.querySelectorAll('#doc-checks input:checked')].map(i => i.value),
      });
      $('#result').innerHTML = ScreenReader.resultHtml(r, { imageUrl: url });
    } catch (err) {
      $('#result').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
    }
  }

  if (!ScreenReader.canCaptureScreen()) {
    // Phones: no screen capture in browsers → photo / screenshot instead
    $('#read-screen').textContent = '📷 Photo or screenshot';
    $('#read-image').classList.add('hidden');
    $('#screen-hint').textContent = 'Take a photo or pick a screenshot of the email, document, slide or chart.';
    $('#read-screen').addEventListener('click', () => runScreen(() => ScreenReader.pickImage()));
  } else {
    $('#read-screen').addEventListener('click', () => runScreen(() => ScreenReader.captureOnce()));
    $('#read-image').addEventListener('click', () => runScreen(() => ScreenReader.pickImage()));
  }

  setup().catch(err => toast(err.message, 'error'));
})();
