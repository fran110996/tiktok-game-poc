// =============================================================
// Live meeting assistant
//  - capture: mic (Me) + screen/tab audio (Them), 5 s chunks
//  - panels 1/2/3 updated over Socket.io namespace /copilot
//  - earphone playback (OpenAI TTS via server)
//  - pop-out window (Document Picture-in-Picture, popup fallback)
// =============================================================

(() => {
  const { api, esc, $, toast, pref, fillLanguages, fmtDateTime } = Copilot;
  const R = CopilotRender;
  Copilot.init('session');

  const CHUNK_MS = 5000;
  const VIEW_ONLY = new URLSearchParams(location.search).get('view') === '1';
  const SILENCE_RMS = 0.012; // chunks quieter than this are not sent

  const state = {
    session: null,
    lines: [],
    panel2: null,
    panel3: null,
    done: new Set(),
    recorders: [],
    streams: [],
    socket: null,
    startedAt: null,
    timer: null,
    targets: new Set(), // extra render targets (pop-out window)
  };

  // =============================================================
  // SETUP
  // =============================================================
  async function loadSetup() {
    setupMode();
    await fillLanguages($('#my-lang'), { selected: pref('myLanguage') || 'en' });
    await fillLanguages($('#their-lang'), { auto: true, selected: pref('theirLanguage') || 'auto' });

    const [contexts, docs, contacts] = await Promise.all([
      api('/contexts').catch(() => []),
      api('/documents').catch(() => []),
      api('/contacts').catch(() => []),
    ]);

    const ctxSel = $('#context-select');
    ctxSel.innerHTML += contexts.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    ctxSel.addEventListener('change', () => {
      const c = contexts.find(x => x.id === ctxSel.value);
      $('#context-text').value = c ? c.text : '';
      pref('lastContext', ctxSel.value);
    });
    const last = pref('lastContext');
    if (last && contexts.some(c => c.id === last)) { ctxSel.value = last; ctxSel.dispatchEvent(new Event('change')); }

    const lastDocs = new Set(pref('lastDocs') || []);
    $('#doc-checks').innerHTML = docs.length
      ? docs.map(d => `<label class="check"><input type="checkbox" value="${d.id}" ${lastDocs.has(d.id) ? 'checked' : ''} /> ${esc(d.file_name)}</label>`).join('')
      : '<span class="muted">No documents yet — <a href="/copilot/library">upload some</a>.</span>';

    const cSel = $('#contact-select');
    cSel.innerHTML += contacts.map(c => `<option value="${c.id}">${esc(c.name)}${c.company ? ` — ${esc(c.company)}` : ''}</option>`).join('');
    const preset = new URLSearchParams(location.search).get('contact');
    if (preset) cSel.value = preset;
  }

  // Runs before anything is fetched, so Start always uses the right mode
  function setupMode() {
    // Phones cannot capture other apps' audio → in-person by default
    const canShare = Boolean(navigator.mediaDevices?.getDisplayMedia);
    if (!canShare) {
      const meetingRadio = document.querySelector('input[name=mode][value=meeting]');
      meetingRadio.disabled = true;
      meetingRadio.closest('label').querySelector('.mode-card').insertAdjacentHTML('beforeend', '<div class="small" style="color:var(--orange);margin-top:4px">Needs Chrome/Edge on a computer.</div>');
    }
    const savedMode = pref('mode');
    const mode = !canShare ? 'room' : (savedMode === 'room' ? 'room' : 'meeting');
    document.querySelector(`input[name=mode][value=${mode}]`).checked = true;
    document.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener('change', applyMode));
    applyMode();
    listMics().catch(() => {});
  }

  function currentMode() {
    return document.querySelector('input[name=mode]:checked')?.value || 'meeting';
  }

  function applyMode() {
    const room = currentMode() === 'room';
    $('#meeting-sources').classList.toggle('hidden', room);
    $('#room-tip').classList.toggle('hidden', !room);
    pref('mode', currentMode());
  }

  // Microphones (labels are only visible after mic permission was granted once)
  async function listMics() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const mics = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default');
    const sel = $('#mic-select');
    const saved = pref('micId');
    sel.innerHTML = '<option value="">Default microphone</option>' + mics.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || `Microphone ${i + 1}`)}</option>`).join('');
    if (saved && mics.some(d => d.deviceId === saved)) sel.value = saved;
  }

  // =============================================================
  // AUDIO CAPTURE
  // =============================================================
  const audioCtx = () => (state.ac ||= new (window.AudioContext || window.webkitAudioContext)());

  function pickMime() {
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    return types.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  }

  // Records an audio-only stream in self-contained ~5 s files (each chunk is a
  // complete file the transcription API can read), skipping silent chunks.
  class SourceRecorder {
    constructor(stream, source) {
      this.stream = new MediaStream(stream.getAudioTracks());
      this.source = source;
      this.mime = pickMime();
      this.running = false;
      this.peak = 0;
      this.inflight = 0;

      const src = audioCtx().createMediaStreamSource(this.stream);
      this.analyser = audioCtx().createAnalyser();
      this.analyser.fftSize = 1024;
      src.connect(this.analyser);
      this.buf = new Float32Array(this.analyser.fftSize);
      this.meterEl = $(`#chip-${source === 'them' ? 'them' : 'me'} .meter > i`);
    }

    start() {
      this.running = true;
      this.next();
      this.meterLoop = setInterval(() => this.measure(), 100);
    }

    measure() {
      this.analyser.getFloatTimeDomainData(this.buf);
      let sum = 0;
      for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
      const rms = Math.sqrt(sum / this.buf.length);
      this.peak = Math.max(this.peak, rms);
      if (this.meterEl) this.meterEl.style.width = `${Math.min(100, rms * 600)}%`;
    }

    next() {
      if (!this.running) return;
      const rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);
      const parts = [];
      const t = Date.now();
      this.peak = 0;
      rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
      rec.onstop = () => {
        // If the audio meter is not running (some phones), never drop chunks as "silent"
        const metering = audioCtx().state === 'running';
        const peak = this.peak;
        if (this.running) this.next();
        const blob = new Blob(parts, { type: rec.mimeType || this.mime || 'audio/webm' });
        if ((!metering || peak >= SILENCE_RMS) && blob.size > 1500) this.upload(blob, t);
      };
      rec.start();
      this.current = rec;
      this.stopTimer = setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, CHUNK_MS);
    }

    async upload(blob, t) {
      if (!state.session) return;
      if (this.inflight > 3) return; // network too slow — drop rather than lag behind
      this.inflight++;
      const form = new FormData();
      const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'mp4' : 'webm';
      form.append('audio', blob, `chunk.${ext}`);
      form.append('source', this.source);
      form.append('t', String(t));
      try {
        await api(`/sessions/${state.session.id}/audio`, { method: 'POST', form });
      } catch (err) {
        notice(`Audio upload failed (${this.source === 'them' ? 'Them' : 'microphone'}): ${err.message}`, 'error');
      } finally {
        this.inflight--;
      }
    }

    stop() {
      this.running = false;
      clearTimeout(this.stopTimer);
      clearInterval(this.meterLoop);
      if (this.current && this.current.state !== 'inactive') this.current.stop();
      if (this.meterEl) this.meterEl.style.width = '0';
    }
  }

  async function captureSources({ mic, screen }) {
    const out = { mic: null, screen: null, warnings: [] };
    if (mic) {
      const micId = $('#mic-select').value;
      const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      if (micId) audio.deviceId = { exact: micId };
      try {
        out.mic = await navigator.mediaDevices.getUserMedia({ audio });
      } catch (err) {
        if (micId && err.name === 'OverconstrainedError') {
          // Saved device disappeared (e.g. earphones disconnected) → default mic
          out.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).catch(() => null);
        }
        if (!out.mic) out.warnings.push(`Microphone not available (${err.name}). Check the browser's microphone permission.`);
      }
      if (out.mic) listMics().catch(() => {});
    }
    if (screen) {
      try {
        const s = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            suppressLocalAudioPlayback: false,
            // Chrome: keep this page's own playback (earphone TTS) out of the capture
            restrictOwnAudio: true,
          },
          systemAudio: 'include',
          selfBrowserSurface: 'exclude',
          surfaceSwitching: 'include',
        });
        if (!s.getAudioTracks().length) {
          s.getTracks().forEach(t => t.stop());
          out.warnings.push('The shared screen/tab has no audio. Share again and tick "Share tab audio" (or "Share system audio" for the entire screen).');
        } else {
          out.screen = s;
        }
      } catch (err) {
        if (err.name !== 'NotAllowedError') out.warnings.push(`Screen share failed (${err.name}).`);
        else out.warnings.push('Screen share skipped — "Them" will not be captured.');
      }
    }
    return out;
  }

  async function startCapture(opts) {
    const room = opts.mode === 'room';
    const cap = await captureSources(room ? { mic: true, screen: false } : opts);
    cap.warnings.forEach(w => notice(w));
    if (!cap.mic && !cap.screen) return false;
    if (audioCtx().state === 'suspended') await audioCtx().resume().catch(() => {});

    $('#chip-me-label').textContent = room ? 'Voices' : 'Me';
    $('#chip-them').classList.toggle('hidden', room);
    $('#p1-legend').textContent = room ? 'One microphone · ME? / THEM? are AI guesses — tap a label to fix it' : 'Me = microphone · Them = shared audio';

    if (cap.mic) {
      state.streams.push(cap.mic);
      const r = new SourceRecorder(cap.mic, room ? 'room' : 'me');
      r.start();
      state.recorders.push(r);
      setChip('me', true);
    } else setChip('me', false);

    if (cap.screen) {
      state.streams.push(cap.screen);
      const r = new SourceRecorder(cap.screen, 'them');
      r.start();
      state.recorders.push(r);
      setChip('them', true);
      // User clicked "Stop sharing" in Chrome's bar
      cap.screen.getAudioTracks()[0].addEventListener('ended', () => {
        r.stop();
        setChip('them', false);
        notice('Screen sharing stopped — "Them" is no longer captured.');
      });
    } else setChip('them', false);
    return true;
  }

  function stopCapture() {
    state.recorders.forEach(r => r.stop());
    state.recorders = [];
    state.streams.forEach(s => s.getTracks().forEach(t => t.stop()));
    state.streams = [];
    setChip('me', false);
    setChip('them', false);
  }

  function setChip(source, on) {
    const chip = $(`#chip-${source}`);
    chip.style.opacity = on ? '1' : '0.4';
    chip.title = on ? 'Capturing' : 'Not captured';
  }

  // =============================================================
  // LIVE VIEW
  // =============================================================
  function notice(msg, type = '') {
    const box = $('#live-notice');
    const el = document.createElement('div');
    el.className = `notice ${type}`;
    el.innerHTML = `${esc(msg)} <a href="#" style="float:right">dismiss</a>`;
    el.querySelector('a').addEventListener('click', (e) => { e.preventDefault(); el.remove(); });
    box.appendChild(el);
    if (box.children.length > 4) box.firstElementChild.remove();
  }

  function showLive() {
    $('#setup-view').classList.add('hidden');
    $('#live-view').classList.remove('hidden');
    $('#live-title').textContent = state.session.title;
    $('#live-dot').className = 'dot on';
    clearInterval(state.timer);
    state.timer = setInterval(() => {
      const s = Math.floor((Date.now() - state.startedAt) / 1000);
      $('#live-timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }, 1000);
  }

  function nearBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  function renderTranscript() {
    const body = $('#p1-body');
    const stick = nearBottom(body);
    body.innerHTML = R.transcriptHtml(state.lines);
    if (stick) body.scrollTop = body.scrollHeight;
    $('#p1-count').textContent = `${state.lines.length} line${state.lines.length === 1 ? '' : 's'}`;
    state.targets.forEach(t => t.render());
  }

  function renderPanel2() {
    $('#p2-body').innerHTML = R.panel2Html(state.panel2, state.done);
    $('#p2-at').textContent = state.panel2?.at ? `Updated ${new Date(state.panel2.at).toLocaleTimeString('en-GB')}` : '';
    state.targets.forEach(t => t.render());
  }

  function renderPanel3() {
    $('#p3-body').innerHTML = R.panel3Html(state.panel3);
    $('#p3-at').textContent = state.panel3?.at ? `Updated ${new Date(state.panel3.at).toLocaleTimeString('en-GB')}` : '';
    state.targets.forEach(t => t.render());
  }

  // Checklist ticks (main page + pop-out share this handler)
  function onActionToggle(e) {
    const cb = e.target.closest('[data-action]');
    if (!cb) return;
    if (cb.checked) state.done.add(cb.dataset.action); else state.done.delete(cb.dataset.action);
    renderPanel2();
  }
  document.addEventListener('change', onActionToggle);

  // Tap a ME / THEM / UNCERTAIN label to correct it (main page + pop-out)
  async function onFixSpeaker(e) {
    const tag = e.target.closest('[data-fix]');
    if (!tag || !state.session) return;
    const line = state.lines.find(l => l.id === tag.dataset.fix);
    if (!line) return;
    try {
      upsertLine(await R.correctLine(state.session.id, line));
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  document.addEventListener('click', onFixSpeaker);

  function upsertLine(line) {
    const idx = state.lines.findIndex(l => l.id === line.id);
    if (idx !== -1) state.lines[idx] = line;
    else {
      const at = state.lines.findIndex(l => l.t > line.t);
      if (at === -1) state.lines.push(line); else state.lines.splice(at, 0, line);
    }
    renderTranscript();
  }

  function connectSocket() {
    if (state.socket) state.socket.disconnect();
    const socket = io('/copilot', { withCredentials: true, transports: ['websocket', 'polling'] });
    state.socket = socket;
    const join = () => socket.emit('session:join', { id: state.session.id }, (res) => {
      if (!res?.ok) return notice('This session is no longer live on the server.', 'error');
      const snap = res.snapshot;
      // Merge lines we may have missed while disconnected
      snap.transcript.forEach(l => { if (!state.lines.some(x => x.id === l.id)) state.lines.push(l); });
      state.lines.sort((a, b) => a.t - b.t);
      if (snap.panel2) state.panel2 = snap.panel2;
      if (snap.panel3) state.panel3 = snap.panel3;
      renderTranscript(); renderPanel2(); renderPanel3();
    });
    socket.on('connect', join);
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') location.href = '/copilot/login?next=' + encodeURIComponent(location.pathname + location.search);
    });
    socket.on('copilot:line', (line) => {
      upsertLine(line);
      if (line.translated) Speaker.onLine(line);
    });
    socket.on('copilot:panel2', (p) => { state.panel2 = p; renderPanel2(); Speaker.onPanel(2, p); });
    socket.on('copilot:panel3', (p) => { state.panel3 = p; renderPanel3(); Speaker.onPanel(3, p); });
    socket.on('copilot:analyzing', ({ on }) => { $('#analyzing').style.display = on ? '' : 'none'; });
    socket.on('copilot:error', ({ message }) => notice(message, 'error'));
  }

  // =============================================================
  // START / RESUME / STOP
  // =============================================================
  async function start() {
    const btn = $('#start-btn');
    const mode = currentMode();
    const mic = mode === 'room' || $('#use-mic').checked;
    const screen = mode === 'meeting' && $('#use-screen').checked;
    if (!mic && !screen) return toast('Choose at least one audio source', 'error');
    if (!window.MediaRecorder) return toast('This browser cannot record audio. Use Chrome/Edge (computer or Android) or Safari on iPhone (iOS 16.4+).', 'error');

    // Inside the click: unlock audio meter + playback (required on iPhone)
    audioCtx().resume().catch(() => {});
    Speaker.unlock();
    pref('micId', $('#mic-select').value);

    btn.disabled = true;
    btn.textContent = 'Starting…';
    const docIds = [...document.querySelectorAll('#doc-checks input:checked')].map(i => i.value);
    pref('lastDocs', docIds);
    pref('myLanguage', $('#my-lang').value);
    pref('theirLanguage', $('#their-lang').value);

    // Ask for devices first (user gesture), then create the session
    state.startedAt = Date.now();
    const okCapture = await startCapture({ mic, screen, mode });
    if (!okCapture) {
      btn.disabled = false;
      btn.textContent = '● Start';
      $('#setup-view').insertAdjacentHTML('afterbegin', `<div class="notice error">No audio source could be captured. ${[...document.querySelectorAll('#live-notice .notice')].map(n => esc(n.textContent.replace('dismiss', ''))).join(' ')}</div>`);
      $('#live-notice').innerHTML = '';
      return;
    }
    try {
      state.session = await api('/sessions', {
        method: 'POST',
        body: {
          title: $('#title').value,
          context_id: $('#context-select').value || null,
          context_text: $('#context-text').value,
          document_ids: docIds,
          contact_id: $('#contact-select').value || null,
          my_language: $('#my-lang').value,
          their_language: $('#their-lang').value,
          sources: { mic, screen },
          mode,
        },
      });
    } catch (err) {
      stopCapture();
      btn.disabled = false;
      btn.textContent = '● Start';
      return toast(err.message, 'error');
    }
    history.replaceState(null, '', `/copilot/session?id=${state.session.id}`);
    showLive();
    connectSocket();
    keepAwake();
  }

  async function resume() {
    audioCtx().resume().catch(() => {});
    Speaker.unlock();
    const mode = state.session?.settings?.mode || 'meeting';
    const canShare = Boolean(navigator.mediaDevices?.getDisplayMedia);
    const ok = await startCapture({ mic: true, screen: mode === 'meeting' && canShare, mode });
    if (ok) {
      $('#resume-btn').style.display = 'none';
      keepAwake();
    }
  }

  // Keep the phone screen on while listening (a locked phone stops the microphone)
  async function keepAwake() {
    if (!('wakeLock' in navigator)) return;
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
    } catch (err) {
      // Not critical (battery saver, unsupported)
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.session && state.recorders.length) keepAwake();
  });

  async function stop() {
    if (!confirm('Stop and save this session?')) return;
    $('#stop-btn').disabled = true;
    stopCapture();
    if (state.wakeLock) state.wakeLock.release().catch(() => {});
    Speaker.stopAll();
    clearInterval(state.timer);
    $('#live-dot').className = 'dot';
    closePopout();
    $('#live-view').classList.add('hidden');
    $('#ended-view').classList.remove('hidden');
    $('#ended-open').href = `/copilot/history?id=${state.session.id}`;
    try {
      const res = await api(`/sessions/${state.session.id}/stop`, { method: 'POST' });
      const f = res.summaries?.final;
      $('#ended-summary').innerHTML = f
        ? `<p>${esc(f.summary)}</p>${f.next_steps?.length ? `<div class="section-label">Next steps</div><ul class="qlist">${f.next_steps.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}`
        : '<p class="muted">Session saved (no summary — the transcript was empty or the AI was unavailable).</p>';
    } catch (err) {
      $('#ended-summary').innerHTML = `<p class="notice error">${esc(err.message)}</p>`;
    }
    state.session = null;
    if (state.socket) state.socket.disconnect();
  }

  // Reopen a live session after a reload (audio capture must be restarted)
  async function reopen(id) {
    let s;
    try {
      s = await api(`/sessions/${id}`);
    } catch (err) {
      return toast(err.message, 'error');
    }
    if (!s.live) {
      location.href = `/copilot/history?id=${id}`;
      return;
    }
    state.session = s;
    state.lines = s.transcript || [];
    state.panel2 = s.panel2;
    state.panel3 = s.panel3;
    state.startedAt = new Date(s.started_at).getTime();
    showLive();
    renderTranscript(); renderPanel2(); renderPanel3();
    setChip('me', false); setChip('them', false);
    const room = s.settings?.mode === 'room';
    $('#chip-me-label').textContent = room ? 'Voices' : 'Me';
    $('#chip-them').classList.toggle('hidden', room);
    if (VIEW_ONLY) {
      // Second device (phone/tablet): follow the panels and listen; no capture here
      $('#chip-me').classList.add('hidden');
      $('#chip-them').classList.add('hidden');
      $('#screen-btn').classList.add('hidden');
      $('#device-btn').classList.add('hidden');
      notice('Following this session from another device. Choose a panel to read aloud and press ▶ once to enable sound.', 'info');
    } else {
      $('#resume-btn').style.display = '';
      notice('Page was reloaded — click "Resume audio capture" to continue listening.', 'info');
    }
    connectSocket();
  }

  // =============================================================
  // OTHER DEVICE (link to follow the session on a phone/tablet)
  // =============================================================
  async function showDeviceLink() {
    const url = `${location.origin}/copilot/session?id=${state.session.id}&view=1`;
    const m = Copilot.modal(`
      <h2>Follow on another device</h2>
      <p class="small muted" style="margin-bottom:10px">Open this link on your phone or tablet (log in with the same account). It shows the three panels live and can read them aloud on that device — handy with earphones.</p>
      <div class="row" style="margin-bottom:12px"><input type="text" readonly value="${esc(url)}" style="flex:1" /><button class="btn-primary btn-sm" data-copy="${esc(url)}">Copy link</button></div>
      <div id="qr" class="qr-box"></div>
      <div class="row" style="margin-top:14px"><button class="btn-ghost" data-close>Close</button></div>`);
    try {
      if (!window.QRCode) {
        await new Promise((resolve, reject) => {
          const sc = document.createElement('script');
          sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
          sc.onload = resolve;
          sc.onerror = reject;
          document.head.appendChild(sc);
        });
      }
      new window.QRCode(m.el.querySelector('#qr'), { text: url, width: 180, height: 180 });
    } catch (err) {
      m.el.querySelector('#qr').remove();
    }
  }

  // =============================================================
  // READ MY SCREEN (during a session)
  // =============================================================
  let lastScreen = null; // { html } — also shown in the pop-out

  async function readScreen(win = window) {
    if (!state.session) return;
    const shared = state.streams.find(s => s.getVideoTracks().some(t => t.readyState === 'live'));
    let getBlob;
    if (!ScreenReader.canCaptureScreen()) {
      getBlob = () => ScreenReader.pickImage(win.document);
    } else if (win !== window) {
      // From the pop-out: the user is looking at another app → let them pick it
      getBlob = () => ScreenReader.captureOnce(win);
    } else if (shared) {
      const choice = await new Promise((resolve) => {
        const m = Copilot.modal(`
          <h2>Read which screen?</h2>
          <div class="stack">
            <button class="btn-primary" data-pick="shared">The shared meeting screen (e.g. their slides)</button>
            <button class="btn-ghost" data-pick="other">Another window (email, document…)</button>
            <button class="btn-ghost" data-pick="file">Upload a screenshot / photo</button>
          </div>`, { onClose: () => resolve(null) });
        m.el.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => { resolve(b.dataset.pick); m.close(); }));
      });
      if (!choice) return;
      getBlob = choice === 'shared' ? () => ScreenReader.frameFromTrack(shared.getVideoTracks()[0])
        : choice === 'file' ? () => ScreenReader.pickImage()
          : () => ScreenReader.captureOnce();
    } else {
      getBlob = () => ScreenReader.captureOnce(win);
    }

    let blob;
    try {
      blob = await getBlob();
    } catch (err) {
      if (err.name !== 'NotAllowedError') toast(`Screen capture failed: ${err.message}`, 'error');
      return;
    }
    if (!blob) return;
    blob = await ScreenReader.shrink(blob);
    const imageUrl = URL.createObjectURL(blob);
    lastScreen = { html: `<img class="screen-shot" src="${imageUrl}" alt="" /><div class="empty"><span class="spinner"></span> Reading the screen…</div>` };
    const m = win === window ? Copilot.modal(`<h2>Read my screen</h2><div id="scr-body">${lastScreen.html}</div><div class="row" style="margin-top:12px"><button class="btn-ghost" data-close>Close</button></div>`) : null;
    state.targets.forEach(t => t.showScreen && t.showScreen());
    try {
      const r = await ScreenReader.analyze(blob, {
        context_id: state.session.settings?.context_id,
        contact_id: state.session.settings?.contact_id || state.session.contact_id,
        my_language: state.session.settings?.my_language,
        document_ids: state.session.settings?.document_ids,
      });
      lastScreen = { html: ScreenReader.resultHtml(r, { imageUrl }) };
    } catch (err) {
      lastScreen = { html: `<div class="notice error">${esc(err.message)}</div>` };
    }
    if (m && m.el.isConnected) m.el.querySelector('#scr-body').innerHTML = lastScreen.html;
    state.targets.forEach(t => t.render());
  }

  // =============================================================
  // PHONE LAYOUT: one panel at a time
  // =============================================================
  document.querySelectorAll('[data-mtab]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('[data-mtab]').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.panels .panel').forEach(p => p.classList.toggle('mobile-active', p.dataset.panel === b.dataset.mtab));
    if (b.dataset.mtab === '1') $('#p1-body').scrollTop = $('#p1-body').scrollHeight;
  }));

  // =============================================================
  // EARPHONE PLAYBACK (TTS)
  // =============================================================
  const Speaker = (() => {
    const audio = new Audio();
    const queue = [];
    let panel = Number(pref('speakPanel') || 0);
    let muted = false;
    let paused = false;
    let busy = false;
    let last = null; // { text, url }
    const spoken2 = new Set();
    const spoken3 = new Set();
    const spoken1 = new Set();

    function status(msg) {
      $('#pb-status').textContent = msg;
      state.targets.forEach(t => t.status && t.status(msg));
    }

    function highlight() {
      document.querySelectorAll('.panel').forEach(p => p.classList.toggle('speaking', Number(p.dataset.panel) === panel));
    }

    async function fetchAudio(text) {
      const res = await fetch('/api/copilot/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw Object.assign(new Error(data.error || 'TTS failed'), { demo: Boolean(data.demo) });
      }
      return URL.createObjectURL(await res.blob());
    }

    // Demo mode (no OpenAI key): the browser's built-in voice reads instead
    const synth = window.speechSynthesis;
    function browserSay(text) {
      if (!synth) { busy = false; status('No voice available in this browser'); return; }
      last = { text, url: null };
      const u = new SpeechSynthesisUtterance(text);
      if (/[\u0E00-\u0E7F]/.test(text)) u.lang = 'th-TH';
      u.onend = () => { busy = false; status(queue.length ? '' : 'Idle'); pump(); };
      u.onerror = u.onend;
      synth.cancel();
      synth.speak(u);
      status('Speaking (browser voice, demo)…');
    }

    async function pump() {
      if (busy || paused || muted || !queue.length) return;
      busy = true;
      const text = queue.shift();
      try {
        status('Preparing audio…');
        const url = await fetchAudio(text);
        if (last?.url) URL.revokeObjectURL(last.url);
        last = { text, url };
        if (muted) { busy = false; return; }
        audio.src = url;
        await audio.play();
        status('Speaking…');
      } catch (err) {
        if (err.demo) return browserSay(text);
        status(`Playback error: ${err.message}`);
        busy = false;
        pump();
      }
    }

    audio.addEventListener('ended', () => { busy = false; status(queue.length ? '' : 'Idle'); pump(); });
    audio.addEventListener('pause', () => { if (!audio.ended && paused) status('Paused'); });

    function enqueue(text) {
      if (!panel || muted || !text) return;
      queue.push(text);
      while (queue.length > 3) queue.shift(); // stay current, drop stale items
      pump();
    }

    return {
      get panel() { return panel; },
      get muted() { return muted; },
      setPanel(n) {
        panel = Number(n);
        pref('speakPanel', panel);
        queue.length = 0;
        // Do not read old content when switching panel — only new content from now on
        if (panel === 2) R.panel2Speech(state.panel2, spoken2);
        if (panel === 3) R.panel3Speech(state.panel3, spoken3);
        highlight();
        status(panel ? 'Waiting for new content…' : 'Off');
        state.targets.forEach(t => t.render());
      },
      onLine(line) {
        // Each line is read once (label corrections re-send the line)
        if (spoken1.has(line.id)) return;
        spoken1.add(line.id);
        if (panel !== 1 || line.source === 'me' || line.speaker === 'me') return;
        enqueue(line.translation || line.text);
      },
      // Must run inside a click: lets later playback start without a gesture (iPhone)
      unlock() {
        try {
          const ctx = audioCtx();
          const buf = ctx.createBuffer(1, 1, 22050);
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(ctx.destination);
          src.start(0);
          if (!audio.src) {
            audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA=';
            audio.play().then(() => audio.pause()).catch(() => {});
          }
        } catch (err) {
          // ignore
        }
      },
      onPanel(n, p) {
        if (n === 2) { const t = R.panel2Speech(p, spoken2); if (panel === 2) enqueue(t); }
        if (n === 3) { const t = R.panel3Speech(p, spoken3); if (panel === 3) enqueue(t); }
      },
      play() {
        this.unlock();
        paused = false;
        if (synth && synth.paused) { synth.resume(); status('Speaking…'); return; }
        if (audio.src && audio.paused && !audio.ended && busy) { audio.play(); status('Speaking…'); } else pump();
      },
      pause() {
        paused = true;
        audio.pause();
        if (synth && synth.speaking) synth.pause();
        status('Paused');
      },
      replay() {
        if (!last) return status('Nothing to replay yet');
        paused = false;
        queue.length = 0;
        if (!last.url) { busy = true; browserSay(last.text); return; }
        audio.src = last.url;
        busy = true;
        audio.play().then(() => status('Replaying…')).catch(() => { busy = false; });
      },
      toggleMute() {
        muted = !muted;
        if (muted) { queue.length = 0; audio.pause(); if (synth) synth.cancel(); busy = false; }
        status(muted ? 'Muted' : 'Unmuted');
        $('#pb-mute').textContent = muted ? '🔈 Unmute' : '🔇 Mute';
        state.targets.forEach(t => t.render());
      },
      stopAll() { queue.length = 0; audio.pause(); if (synth) synth.cancel(); busy = false; },
      async setSink(id) {
        if (audio.setSinkId) await audio.setSinkId(id).catch(() => toast('Could not switch output device', 'error'));
      },
      init() {
        $('#speak-panel').value = String(panel);
        highlight();
        status(panel ? 'Waiting for new content…' : 'Off');
      },
    };
  })();

  // Output device picker (Chrome supports setSinkId)
  async function initSinks() {
    if (!('setSinkId' in HTMLMediaElement.prototype) || !navigator.mediaDevices?.enumerateDevices) return;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput');
    if (devices.length < 2 || !devices.some(d => d.label)) return;
    const sel = $('#sink-select');
    sel.innerHTML = devices.map(d => `<option value="${esc(d.deviceId)}">${esc(d.label || 'Output')}</option>`).join('');
    sel.classList.remove('hidden');
    sel.addEventListener('change', () => Speaker.setSink(sel.value));
  }

  $('#speak-panel').addEventListener('change', (e) => Speaker.setPanel(e.target.value));
  $('#pb-play').addEventListener('click', () => Speaker.play());
  $('#pb-pause').addEventListener('click', () => Speaker.pause());
  $('#pb-replay').addEventListener('click', () => Speaker.replay());
  $('#pb-mute').addEventListener('click', () => Speaker.toggleMute());

  // =============================================================
  // POP-OUT WINDOW
  // =============================================================
  let popout = null;

  function buildPopout(win, isPip) {
    const doc = win.document;
    doc.title = 'Sales Copilot';
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('/copilot/assets/copilot.css', location.href).href;
    doc.head.appendChild(link);
    doc.body.className = 'pip';
    doc.body.innerHTML = `
      <div class="pip-wrap">
        <div class="pip-tabs">
          <button data-tab="1">1 · Talk</button>
          <button data-tab="2">2 · Ask</button>
          <button data-tab="3">3 · Reply</button>
          <button data-tab="4" title="Read my screen">📷</button>
          <button id="pip-hide" title="Hide this window (reopen with Pop out)" style="flex:0 0 auto">✕</button>
        </div>
        ${isPip ? '' : '<div class="notice" style="margin:6px;font-size:0.75rem">Always-on-top is not available in this browser (needs Chrome/Edge 116+). This is a normal popup window.</div>'}
        <div class="pip-body" id="pip-body"></div>
        <div class="pip-controls">
          <select id="pip-speak">
            <option value="0">🎧 Off</option><option value="1">🎧 Panel 1</option><option value="2">🎧 Panel 2</option><option value="3">🎧 Panel 3</option>
          </select>
          <button id="pip-play">▶</button><button id="pip-pause">❚❚</button><button id="pip-replay">↺</button><button id="pip-mute">🔇</button>
          <span class="small muted" id="pip-status"></span>
        </div>
      </div>`;

    let tab = Number(pref('pipTab') || 3);
    const body = doc.getElementById('pip-body');
    const target = {
      render() {
        doc.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', Number(b.dataset.tab) === tab));
        const stick = nearBottom(body);
        if (tab === 1) body.innerHTML = R.transcriptHtml(state.lines, { limit: 60 });
        if (tab === 2) body.innerHTML = R.panel2Html(state.panel2, state.done);
        if (tab === 3) body.innerHTML = R.panel3Html(state.panel3);
        if (tab === 4) {
          body.innerHTML = `<button class="btn-go" id="pip-read" style="width:100%;justify-content:center;margin-bottom:10px">📷 Read my screen</button>
            <div class="small muted" style="margin-bottom:10px">Pick the window with the email, document, slide or chart. You get a translation and draft replies to copy.</div>
            ${lastScreen ? lastScreen.html : ''}`;
          doc.getElementById('pip-read').addEventListener('click', () => readScreen(win));
        }
        if (tab === 1 && stick) body.scrollTop = body.scrollHeight;
        doc.getElementById('pip-speak').value = String(Speaker.panel);
        doc.getElementById('pip-mute').textContent = Speaker.muted ? '🔈' : '🔇';
      },
      status(msg) { doc.getElementById('pip-status').textContent = msg; },
      showScreen() { tab = 4; target.render(); },
    };
    doc.getElementById('pip-hide').addEventListener('click', () => win.close());

    doc.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
      tab = Number(b.dataset.tab);
      pref('pipTab', tab);
      target.render();
      if (tab === 1) body.scrollTop = body.scrollHeight;
    }));
    doc.getElementById('pip-speak').addEventListener('change', (e) => { Speaker.setPanel(e.target.value); $('#speak-panel').value = e.target.value; });
    doc.getElementById('pip-play').addEventListener('click', () => Speaker.play());
    doc.getElementById('pip-pause').addEventListener('click', () => Speaker.pause());
    doc.getElementById('pip-replay').addEventListener('click', () => Speaker.replay());
    doc.getElementById('pip-mute').addEventListener('click', () => Speaker.toggleMute());
    // Copy buttons + checklist inside the pop-out
    doc.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-copy]');
      if (btn) Copilot.copyText(btn.dataset.copy, btn);
    });
    doc.addEventListener('change', onActionToggle);
    doc.addEventListener('click', onFixSpeaker);

    state.targets.add(target);
    target.render();
    win.addEventListener('pagehide', () => { state.targets.delete(target); popout = null; });
    return target;
  }

  async function openPopout() {
    if (popout && !popout.closed) { popout.focus(); return; }
    if ('documentPictureInPicture' in window) {
      try {
        popout = await window.documentPictureInPicture.requestWindow({ width: 380, height: 560 });
        buildPopout(popout, true);
        return;
      } catch (err) {
        toast(`Picture-in-Picture failed (${err.message}) — opening a normal popup.`, 'error');
      }
    } else {
      toast('This browser does not support always-on-top windows (Document Picture-in-Picture, Chrome/Edge 116+). Opening a normal popup instead.', 'error');
    }
    popout = window.open('', 'copilot-popout', 'width=400,height=620');
    if (!popout) return toast('Pop-up blocked. Allow pop-ups for this site and try again.', 'error');
    popout.document.open();
    popout.document.write('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>');
    popout.document.close();
    buildPopout(popout, false);
  }

  function closePopout() {
    if (popout && !popout.closed) popout.close();
    popout = null;
    state.targets.clear();
  }

  $('#popout-btn').addEventListener('click', openPopout);
  $('#screen-btn').addEventListener('click', () => readScreen(window));
  $('#device-btn').addEventListener('click', showDeviceLink);
  // Phones/tablets have no always-on-top windows
  if (!('documentPictureInPicture' in window) && /Android|iPhone|iPad/i.test(navigator.userAgent)) $('#popout-btn').classList.add('hidden');

  // =============================================================
  // WIRING
  // =============================================================
  $('#start-btn').addEventListener('click', start);
  $('#stop-btn').addEventListener('click', stop);
  $('#resume-btn').addEventListener('click', resume);
  $('#refresh-btn').addEventListener('click', () => {
    if (!state.session) return;
    api(`/sessions/${state.session.id}/analyze`, { method: 'POST' }).catch(err => toast(err.message, 'error'));
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.session && state.recorders.length) { e.preventDefault(); e.returnValue = ''; }
  });

  Speaker.init();
  initSinks().catch(() => {});

  const reopenId = new URLSearchParams(location.search).get('id');
  if (reopenId) {
    loadSetup().catch(() => {});
    reopen(reopenId);
  } else {
    loadSetup().catch(err => toast(err.message, 'error'));
  }
})();
