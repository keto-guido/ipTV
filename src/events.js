'use strict';
// Server-sent events: every client gets the current state on connect and again whenever it changes.
const PING_MS = 15e3, MAX_CLIENTS = 64, MAX_PER_USER = 8, MAX_QUEUED = 1 << 20, DAY_MS = 86400e3;

function createHub({ pingMs = PING_MS, maxClients = MAX_CLIENTS, maxPerUser = MAX_PER_USER } = {}) {
  const clients = new Set();
  let last = null; // serialized state
  const put = (c, s) => { if (c.res.writableLength > MAX_QUEUED) c.res.destroy(); else c.res.write(s); };
  const frame = () => `event: state\ndata: ${last}\n\n`;
  setInterval(() => { for (const c of clients) put(c, ': ping\n\n'); }, pingMs).unref(); // also keeps proxies from timing the stream out
  return {
    get size() { return clients.size; },
    // Same auth as any route (the cookie is sent on same-origin EventSource requests), so no token ever goes in a URL.
    // The JWT is only checked when the stream opens, so it ends at expiry and the reconnect is checked again.
    add(req, res, user) {
      if (clients.size >= maxClients || [...clients].filter(c => c.sub === user.sub).length >= maxPerUser) return false;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
      const c = { res, sub: user.sub };
      clients.add(c);
      res.write(`retry: 3000\n\n${last === null ? '' : frame()}`);
      const end = user.exp ? setTimeout(() => res.end(), Math.min(user.exp * 1000 - Date.now(), DAY_MS)) : null;
      if (end) end.unref();
      req.on('close', () => { clients.delete(c); clearTimeout(end); });
      return true;
    },
    publish(state) {
      const s = JSON.stringify(state);
      if (s === last) return false;
      last = s;
      for (const c of clients) put(c, frame());
      return true;
    },
  };
}

module.exports = { createHub };
