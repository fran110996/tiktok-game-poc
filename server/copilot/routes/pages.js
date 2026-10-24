// =============================================================
// copilot/routes/pages.js
// /copilot pages. Everything except the login page and static
// assets requires the session cookie. This router is mounted before
// the app-wide express.static so copilot HTML is never served raw.
// =============================================================

const express = require('express');
const path = require('path');
const auth = require('../services/auth');

const PAGES_DIR = path.join(__dirname, '../../../public/copilot');

const PAGES = {
  '/': 'index.html',
  '/session': 'session.html',
  '/history': 'history.html',
  '/reply': 'reply.html',
  '/library': 'library.html',
  '/contacts': 'contacts.html',
  '/upcoming': 'upcoming.html',
  '/monitor': 'monitor.html',
};

const router = express.Router({ strict: false });

router.use('/assets', express.static(path.join(PAGES_DIR, 'assets'), { fallthrough: false }));

router.get('/login', (req, res) => {
  if (auth.userFromCookieHeader(req.headers.cookie)) return res.redirect('/copilot');
  res.sendFile(path.join(PAGES_DIR, 'login.html'));
});

router.use(auth.requirePageAuth);

router.get(Object.keys(PAGES), (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PAGES_DIR, PAGES[req.path.replace(/\/+$/, '') || '/']));
});

// Anything else under /copilot (including raw *.html) → home
router.use((req, res) => res.redirect('/copilot'));

module.exports = router;
