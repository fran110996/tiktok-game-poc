// =============================================================
// copilot/services/auth.js
// Single-user login: credentials from env, HMAC-signed httpOnly cookie.
// =============================================================

const crypto = require('crypto');
const config = require('../config');

const COOKIE_NAME = 'copilot_session';
const loginAttempts = new Map(); // ip → { count, first }

function sign(value) {
  return crypto.createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab); // keep timing similar
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function isConfigured() {
  return Boolean(config.userEmail && config.userPassword);
}

function checkCredentials(email, password) {
  if (!isConfigured()) return false;
  const okEmail = safeEqual(String(email || '').trim().toLowerCase(), config.userEmail);
  const okPass = safeEqual(String(password || ''), config.userPassword);
  return okEmail && okPass;
}

// Basic brute-force guard: 10 attempts per 15 minutes per IP.
function rateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.first > 15 * 60 * 1000) {
    loginAttempts.set(ip, { count: 1, first: now });
    return false;
  }
  entry.count += 1;
  return entry.count > 10;
}

function createToken(userId) {
  const expires = Date.now() + config.sessionDays * 24 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ u: userId, e: expires })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!safeEqual(sig, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.e || data.e < Date.now()) return null;
    return { userId: data.u };
  } catch (err) {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try { out[key] = decodeURIComponent(val); } catch (err) { out[key] = val; }
  }
  return out;
}

function userFromCookieHeader(header) {
  return verifyToken(parseCookies(header)[COOKIE_NAME]);
}

function setSessionCookie(req, res, userId) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie(COOKIE_NAME, createToken(userId), {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: config.sessionDays * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

// Express middleware for /api/copilot/* (JSON 401).
function requireApiAuth(req, res, next) {
  const user = userFromCookieHeader(req.headers.cookie);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.copilotUser = user;
  next();
}

// Express middleware for /copilot pages (redirect to login).
function requirePageAuth(req, res, next) {
  const user = userFromCookieHeader(req.headers.cookie);
  if (!user) {
    const nextUrl = encodeURIComponent(req.originalUrl || '/copilot');
    return res.redirect(`/copilot/login?next=${nextUrl}`);
  }
  req.copilotUser = user;
  next();
}

module.exports = {
  isConfigured,
  checkCredentials,
  rateLimited,
  setSessionCookie,
  clearSessionCookie,
  userFromCookieHeader,
  requireApiAuth,
  requirePageAuth,
};
