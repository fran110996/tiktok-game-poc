// =============================================================
// Sales Copilot — shared browser helpers
// =============================================================

const Copilot = (() => {
  const NAV = [
    { href: '/copilot', key: 'home', icon: '⌂', label: 'Home' },
    { href: '/copilot/session', key: 'session', icon: '●', label: 'New session' },
    { href: '/copilot/reply', key: 'reply', icon: '✉', label: 'Reply assistant' },
    { href: '/copilot/history', key: 'history', icon: '☰', label: 'History' },
    { sep: true },
    { href: '/copilot/contacts', key: 'contacts', icon: '☺', label: 'Contacts' },
    { href: '/copilot/upcoming', key: 'upcoming', icon: '★', label: 'Upcoming' },
    { href: '/copilot/monitor', key: 'monitor', icon: '☀', label: 'Morning summary' },
    { sep: true },
    { href: '/copilot/library', key: 'library', icon: '❏', label: 'Context & documents' },
    { href: '/copilot/help', key: 'help', icon: '?', label: 'Beginner guide' },
    { href: '/copilot/settings', key: 'settings', icon: '⚙', label: 'Settings' },
  ];

  // ---------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------
  async function api(path, { method = 'GET', body, form } = {}) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (form) {
      opts.body = form;
    } else if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`/api/copilot${path}`, opts);
    if (res.status === 401 && !path.startsWith('/auth/login')) {
      location.href = `/copilot/login?next=${encodeURIComponent(location.pathname + location.search)}`;
      throw new Error('Not logged in');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ---------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function $(sel, root = document) { return root.querySelector(sel); }
  function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

  function toast(msg, type = '') {
    let host = document.getElementById('toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toast-host';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => el.remove(), type === 'error' ? 7000 : 3500);
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      // Fallback for blocked clipboard API
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    if (btn) {
      const old = btn.textContent;
      btn.textContent = 'Copied ✓';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = old; btn.classList.remove('copied'); }, 1600);
    }
  }

  // Any element with data-copy-target="#id" or data-copy="text" copies on click.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy-target],[data-copy]');
    if (!btn) return;
    const text = btn.dataset.copy !== undefined
      ? btn.dataset.copy
      : (document.querySelector(btn.dataset.copyTarget)?.innerText || '');
    copyText(text, btn);
  });

  function fmtDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  }
  function fmtDate(d) {
    if (!d) return '';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00:00`) : new Date(d);
    return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }
  function fmtTime(ms) {
    return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function hostname(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (err) { return url; }
  }

  // Sources list (links) + verification flags
  function sourcesHtml(sources) {
    if (!sources || !sources.length) return '';
    return `<div class="sources"><b>Sources</b><ol>${sources.map(s => `
      <li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title || hostname(s.url))}</a>
      <span class="muted">— ${esc(hostname(s.url))}</span>${s.verified === false ? ' <span class="tag uncertain">Unverified link</span>' : ''}</li>`).join('')}</ol></div>`;
  }

  function uncertainTag(obj) {
    return obj && obj.uncertain ? '<span class="tag uncertain" title="The AI is not sure — check before using">⚠ Uncertain</span>' : '';
  }
  function uncertainNote(obj) {
    return obj && obj.uncertain && obj.uncertainty_note ? `<div class="uncertain-note">⚠ ${esc(obj.uncertainty_note)}</div>` : '';
  }

  // ---------------------------------------------------------------
  // Local preferences (per browser; optional)
  // ---------------------------------------------------------------
  function pref(key, value) {
    try {
      if (value === undefined) return JSON.parse(localStorage.getItem(`copilot:${key}`));
      localStorage.setItem(`copilot:${key}`, JSON.stringify(value));
    } catch (err) {
      return null;
    }
    return value;
  }

  // ---------------------------------------------------------------
  // Meta (languages, tags, channels…)
  // ---------------------------------------------------------------
  let metaPromise = null;
  function meta() {
    if (!metaPromise) metaPromise = api('/meta');
    return metaPromise;
  }

  async function fillLanguages(select, { auto = false, selected } = {}) {
    const m = await meta();
    select.innerHTML = (auto ? '<option value="auto">Auto-detect</option>' : '')
      + Object.entries(m.languages).map(([code, name]) => `<option value="${code}">${esc(name)}</option>`).join('');
    if (selected) select.value = selected;
  }

  function modal(html, { onClose } = {}) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal">${html}</div>`;
    const close = () => { back.remove(); if (onClose) onClose(); };
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    back.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
    document.body.appendChild(back);
    return { el: back.firstElementChild, close };
  }

  // ---------------------------------------------------------------
  // Shell
  // ---------------------------------------------------------------
  async function init(active) {
    const nav = document.getElementById('nav');
    if (nav) {
      nav.innerHTML = `
        <div class="brand"><div class="brand-mark">SC</div><div>SALES COPILOT<small>Your meeting & reply assistant</small></div>
          <button class="btn-ghost btn-sm menu-toggle" id="menu-toggle" aria-label="Menu">☰</button></div>
        <div class="nav-links">
        ${NAV.map(n => n.sep ? '<div class="nav-sep"></div>' : `<a class="nav-link ${n.key === active ? 'active' : ''}" href="${n.href}"><span class="nav-icon">${n.icon}</span>${n.label}</a>`).join('')}
        </div>
        <div class="sidebar-footer"><div id="nav-user"></div><button class="btn-ghost btn-sm" id="logout-btn">Log out</button></div>`;
      document.getElementById('menu-toggle').addEventListener('click', () => nav.classList.toggle('open'));
      document.getElementById('logout-btn').addEventListener('click', async () => {
        await api('/auth/logout', { method: 'POST' }).catch(() => {});
        location.href = '/copilot/login';
      });
      api('/auth/me').then(me => { document.getElementById('nav-user').textContent = me.email; }).catch(() => {});
    }

    // Morning summary: first open of the day starts a run. The server decides
    // (its day is in COPILOT_TIMEZONE), so every page asks; it is a cheap check.
    api('/monitor/auto', { method: 'POST' })
      .then(r => { if (r.started) toast('Preparing today\'s morning summary in the background…'); })
      .catch(() => {});

    meta().then(m => {
      if (m.demo) {
        const main = document.querySelector('.main');
        if (main) main.insertAdjacentHTML('afterbegin', `<div class="notice info"><b>Demo mode</b> — AI answers are examples, nothing is really transcribed, read or searched. ${active === 'settings' ? '' : '<a href="/copilot/settings">Add an OpenAI API key in Settings</a> for real results.'}</div>`);
      }
      if (m.storage === 'local') {
        const main = document.querySelector('.main');
        if (main) main.insertAdjacentHTML('afterbegin', '<div class="notice">Supabase is not reachable for copilot data — saving to a local file on the server instead. Data may be lost when the server restarts. See the guide (copilot_setup.sql + SUPABASE_SERVICE_ROLE_KEY).</div>');
      }
    }).catch(() => {});
  }

  return { api, esc, $, $$, toast, copyText, fmtDateTime, fmtDate, fmtTime, hostname, sourcesHtml, uncertainTag, uncertainNote, pref, meta, fillLanguages, modal, init };
})();
