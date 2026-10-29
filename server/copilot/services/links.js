// =============================================================
// copilot/services/links.js
// Confirms that links the AI cites really exist. A link that was not in
// the web search results is opened by the server; if the page loads it
// counts as verified. Invented links usually fail (404 / no such host).
// =============================================================

const cache = new Map(); // url → Promise<boolean>

async function linkWorks(url, timeoutMs = 5000) {
  if (!/^https?:\/\//i.test(url || '')) return false;
  if (!cache.has(url)) {
    cache.set(url, (async () => {
      try {
        const res = await fetch(url, {
          method: 'GET',
          redirect: 'follow',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,*/*',
          },
        });
        // Don't download the page body
        res.body?.cancel?.().catch(() => {});
        return res.status < 400;
      } catch (err) {
        return false;
      }
    })());
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
  }
  return cache.get(url);
}

// items: objects with { url, verified }. Checks only the unverified ones,
// in parallel, and marks those whose page loads as verified.
async function confirmLinks(items, timeoutMs) {
  await Promise.all((items || []).map(async (it) => {
    if (it && it.verified === false && await linkWorks(it.url, timeoutMs)) it.verified = true;
  }));
  return items;
}

module.exports = { linkWorks, confirmLinks };
