// =============================================================
// "Read my screen": grab one frame of a screen/window/tab (desktop),
// or take/choose a photo or screenshot (phones), send it to the
// server and render the result (text, translation, drafts).
// =============================================================

const ScreenReader = (() => {
  const { api, esc, sourcesHtml, uncertainTag, uncertainNote, pref } = Copilot;

  const canCaptureScreen = () => Boolean(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

  // One frame from a live video track → JPEG blob (max 2000 px wide)
  async function frameFromTrack(track, doc = document) {
    const video = doc.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([track]);
    await video.play();
    await new Promise(r => setTimeout(r, 350)); // let the first frame paint
    const scale = Math.min(1, 2000 / (video.videoWidth || 2000));
    const canvas = doc.createElement('canvas');
    canvas.width = Math.round((video.videoWidth || 1280) * scale);
    canvas.height = Math.round((video.videoHeight || 720) * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    video.pause();
    video.srcObject = null;
    return new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
  }

  // Ask the user to pick a window/screen/tab and grab one frame.
  // `win` lets the pop-out window ask with its own user gesture.
  async function captureOnce(win = window) {
    const stream = await win.navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'window' },
      audio: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'exclude',
    });
    try {
      return await frameFromTrack(stream.getVideoTracks()[0], win.document);
    } finally {
      stream.getTracks().forEach(t => t.stop());
    }
  }

  // Phones (or fallback): file picker with camera option
  function pickImage(doc = document) {
    return new Promise((resolve) => {
      const input = doc.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = () => resolve(input.files[0] || null);
      input.click();
    });
  }

  async function shrink(file) {
    if (!file || file.size < 1.5 * 1024 * 1024) return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 2000 / bmp.width);
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    } catch (err) {
      return file;
    }
  }

  async function analyze(blob, opts = {}) {
    const form = new FormData();
    form.append('image', blob, blob.name || 'screen.jpg');
    form.append('my_language', opts.my_language || pref('myLanguage') || 'en');
    form.append('reply_language', opts.reply_language || 'auto');
    if (opts.context_id) form.append('context_id', opts.context_id);
    if (opts.contact_id) form.append('contact_id', opts.contact_id);
    if (opts.note) form.append('note', opts.note);
    if (opts.document_ids) form.append('document_ids', JSON.stringify(opts.document_ids));
    return api('/read-screen', { method: 'POST', form });
  }

  function resultHtml(r, { imageUrl, idPrefix = 'scr' } = {}) {
    return `
      ${imageUrl ? `<img class="screen-shot" src="${imageUrl}" alt="Captured screen" />` : ''}
      <div class="row" style="margin-bottom:8px"><span class="tag">${esc(r.content_type)}</span>${uncertainTag(r)}${r.sources?.length ? '<span class="tag accent">Web researched</span>' : ''}</div>
      <div class="section-label">Summary</div>
      <p>${esc(r.summary)}</p>
      ${r.key_points?.length ? `<ul class="qlist" style="margin-top:6px">${r.key_points.map(k => `<li>${esc(k)}</li>`).join('')}</ul>` : ''}
      ${r.wants?.length ? `<div class="section-label">They ask</div><ul class="qlist">${r.wants.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      ${uncertainNote(r)}
      ${r.translation ? `<div class="section-label">Translation</div><div class="subcard ai-block small" id="${idPrefix}-tr">${esc(r.translation)}</div>` : ''}
      <details style="margin-top:8px"><summary class="small muted" style="cursor:pointer">Text read from the screen</summary><div class="subcard ai-block small" style="margin-top:6px">${esc(r.extracted_text)}</div></details>
      ${r.drafts?.length ? `<div class="section-label" style="margin-top:14px">Draft replies</div><div class="stack">${r.drafts.map((d, i) => `
        <div class="subcard draft">
          <div class="row between"><b>${esc(d.label)}</b><button class="btn-primary btn-sm" data-copy="${esc(d.text)}">Copy</button></div>
          <div class="draft-text">${esc(d.text)}</div>
        </div>`).join('')}</div>` : ''}
      ${sourcesHtml(r.sources)}
      ${r.id ? `<p class="small muted" style="margin-top:10px">Saved to <a href="/copilot/history?id=${r.id}" target="_blank">history</a>.</p>` : ''}`;
  }

  return { canCaptureScreen, frameFromTrack, captureOnce, pickImage, shrink, analyze, resultHtml };
})();
