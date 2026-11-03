'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { cfg, log, redact } = require('./config');
const { userFor } = require('./auth');
const provider = require('./provider');
const ch = require('./channels');

const B = cfg.BASE;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.json': 'application/json' };

function send(res, code, body, type = 'application/json', extra = {}) {
  const b = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(b);
}
function file(res, f, cache = 'no-store') {
  fs.readFile(f, (e, d) => {
    if (e) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
    res.end(d);
  });
}
function body(req) {
  return new Promise((ok, bad) => {
    let s = '';
    req.on('data', d => { s += d; if (s.length > 1e5) req.destroy(); });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } });
    req.on('error', bad);
  });
}
function page(name) {
  return fs.readFileSync(path.join(cfg.PUBLIC, name), 'utf8').replace(/__BASE__/g, B);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname;
  if (p === B) return send(res, 302, '', 'text/plain', { Location: B + '/' });
  if (!p.startsWith(B + '/')) return send(res, 404, { error: 'not found' });
  p = p.slice(B.length);

  const isHtml = p === '/' || p === '/admin';
  const user = userFor(req);
  if (!user || !user.watch) {
    if (isHtml && !user) return send(res, 302, '', 'text/plain', { Location: `${cfg.LOGIN_PATH}?next=${encodeURIComponent(req.url)}` });
    return send(res, user ? 403 : 401, { error: user ? 'forbidden' : 'unauthorized' });
  }
  const m = req.method;
  if (m === 'POST') {
    // CSRF: JSON only, no cross-site.
    if (!(req.headers['content-type'] || '').startsWith('application/json') || req.headers['sec-fetch-site'] === 'cross-site')
      return send(res, 403, { error: 'forbidden' });
  }

  if (m === 'GET' && p === '/') return send(res, 200, page('index.html'), TYPES['.html']);
  if (m === 'GET' && p.startsWith('/static/')) {
    const f = path.normalize(path.join(cfg.PUBLIC, p.slice(8)));
    if (!f.startsWith(cfg.PUBLIC + path.sep)) return send(res, 404, { error: 'not found' });
    return file(res, f, 'private, max-age=3600');
  }
  let mm;
  if (m === 'GET' && (mm = p.match(/^\/hls\/([0-9A-Za-z_-]+)\/(index\.m3u8|seg_\d+\.ts)$/))) {
    if (!ch.has(mm[1])) return send(res, 404, { error: 'not found' });
    ch.touch(mm[1], user.sub, false);
    return file(res, path.join(ch.dir(mm[1]), mm[2]), mm[2].endsWith('.ts') ? 'private, max-age=60' : 'no-store');
  }
  if (m === 'GET' && p === '/api/status')
    return send(res, 200, { me: { name: user.name, admin: user.admin }, channels: ch.list() });
  if (m === 'POST' && (mm = p.match(/^\/api\/watch\/([0-9A-Za-z_-]+)$/))) {
    const v = ch.touch(mm[1], user.sub, true);
    return v ? send(res, 200, v) : send(res, 404, { error: 'not active' });
  }

  // ---- admin ----
  if (!user.admin) return isHtml ? send(res, 302, '', 'text/plain', { Location: B + '/' }) : send(res, 403, { error: 'forbidden' });
  if (m === 'GET' && p === '/admin') return send(res, 200, page('admin.html'), TYPES['.html']);
  if (m === 'GET' && p === '/api/channels') {
    try {
      const j = JSON.stringify(await provider.getList());
      if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return send(res, 200, zlib.gzipSync(j), 'application/json', { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
      return send(res, 200, j);
    }
    catch (e) { return send(res, 502, { error: redact(e.message) }); }
  }
  if (m === 'POST' && p === '/api/refresh') {
    try { const d = await provider.refresh(); return send(res, 200, { ok: true, fetchedAt: d.fetchedAt, count: d.channels.length }); }
    catch (e) { return send(res, e.retryAfter ? 429 : 502, { error: redact(e.message), retryAfter: e.retryAfter }); }
  }
  if (m === 'GET' && p === '/api/settings') return send(res, 200, { ...ch.settings, encoder: ch.encoder });
  if (m === 'POST' && p === '/api/settings') return send(res, 200, ch.setSettings(await body(req)));
  if (m === 'POST' && p === '/api/select') {
    const r = ch.select((await body(req)).id);
    return send(res, r.error ? 409 : 200, r);
  }
  if (m === 'POST' && p === '/api/stop') { await ch.stop((await body(req)).id); return send(res, 200, { ok: true }); }
  return send(res, 404, { error: 'not found' });
}

ch.init();
const server = http.createServer((req, res) => {
  handle(req, res).catch(e => { log('error', e.stack || e.message); if (!res.headersSent) send(res, 500, { error: 'error' }); });
});
server.listen(cfg.PORT, cfg.HOST, () => log(`listening on ${cfg.HOST}:${cfg.PORT}${B}/${cfg.DEV_AUTH ? ' (DEV_AUTH)' : ''}`));
if (process.env.DEV_AUTH === '1' && !cfg.DEV_AUTH) log('DEV_AUTH ignored: only allowed with HOST=127.0.0.1');

async function quit() { log('shutting down'); await ch.shutdown(); process.exit(0); }
process.on('SIGINT', quit); process.on('SIGTERM', quit);
