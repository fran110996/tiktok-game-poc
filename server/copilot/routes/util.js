// =============================================================
// copilot/routes/util.js
// =============================================================

// Wrap async handlers so errors become JSON responses.
function handle(fn) {
  return async (req, res) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
      if (status >= 500) console.error('[Copilot]', req.method, req.originalUrl, '→', err.message);
      if (!res.headersSent) res.status(status).json({ error: err.message || 'Server error' });
    }
  };
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

module.exports = { handle, httpError };
