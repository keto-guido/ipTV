'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { cfg, log, redact } = require('./config');
const { userFor } = require('./auth');
const provider = require('./provider');
const ch = require('./channels');
const epg = require('./epg');

// Per-user favorites keyed by JWT sub.
const FAV_FILE = path.join(cfg.DATA, 'favorites.json');
let favs = {};
try { favs = JSON.parse(fs.readFileSync(FAV_FILE, 'utf8')); } catch {}
function saveFavs() { fs.mkdirSync(cfg.DATA, { recursive: true }); fs.writeFileSync(FAV_FILE, JSON.stringify(favs)); }
// Cache-only channel lookups (never touch the provider).
function slim(c) { return { id: c.id, name: c.name, cat: c.cat, icon: c.icon }; }
function byIds(ids) {
  const l = provider.load(); if (!l) return [];
  const m = new Map(l.channels.map(c => [c.id, c]));
  return ids.map(i => m.get(i)).filter(Boolean).map(slim);
}
const idList = q => (q || '').split(',').filter(x => /^[0-9A-Za-z_-]{1,20}$/.test(x)).slice(0, 300);
function gz(req, res, obj) {
  const j = JSON.stringify(obj);
  if (j.length > 1400 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) return send(res, 200, zlib.gzipSync(j), 'application/json', { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
  return send(res, 200, j);
}

// Per-user hidden groups (category ids) keyed by JWT sub.
const HID_FILE = path.join(cfg.DATA, 'hidden.json');
let hid = {};
try { hid = JSON.parse(fs.readFileSync(HID_FILE, 'utf8')); } catch {}
function saveHid() { fs.mkdirSync(cfg.DATA, { recursive: true }); fs.writeFileSync(HID_FILE, JSON.stringify(hid)); }
let gcache = null; // group counts, rebuilt when the cached list changes
function groupList() {
  const l = provider.load(); if (!l) return [];
  if (gcache && gcache.l === l) return gcache.g;
  const n = new Map();
  for (const c of l.channels) n.set(c.cat, (n.get(c.cat) || 0) + 1);
  const g = l.categories.filter(c => n.get(c.id)).map(c => ({ id: c.id, name: c.name, n: n.get(c.id) }));
  gcache = { l, g }; return g;
}

const B = cfg.BASE;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

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

  const isHtml = p === '/' || p === '/admin' || p === '/guide';
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
    return send(res, 200, { me: { name: user.name, admin: user.admin }, max: ch.settings.maxStreams, channels: ch.list() });
  if (m === 'GET' && p === '/guide') return send(res, 200, page('guide.html'), TYPES['.html']);
  // ---- guide & favorites: served from local cache only ----
  if (m === 'GET' && p === '/api/favorites') return send(res, 200, byIds(favs[user.sub] || []));
  if (m === 'POST' && p === '/api/favorites') {
    const b = await body(req), id = String(b.id || '');
    if (!idList(id).length) return send(res, 400, { error: 'bad id' });
    const f = new Set(favs[user.sub] || []);
    if (b.on) { if (f.size < 500) f.add(id); } else f.delete(id);
    favs[user.sub] = [...f]; saveFavs();
    return send(res, 200, favs[user.sub]);
  }
  if (m === 'GET' && p === '/api/categories') { const l = provider.load(); return send(res, 200, l ? l.categories : []); }
  if (m === 'GET' && p === '/api/lineup') {
    const l = provider.load(); if (!l) return send(res, 200, []);
    const cat = url.searchParams.get('cat') || '';
    return gz(req, res, l.channels.filter(c => c.cat === cat).map(slim));
  }
  if (m === 'GET' && p === '/api/epg/now') return gz(req, res, epg.nowNext(idList(url.searchParams.get('ids'))));
  if (m === 'GET' && p === '/api/epg/range') {
    const from = +url.searchParams.get('from') || Math.floor(Date.now() / 1000), hrs = Math.min(+url.searchParams.get('hours') || 4, 12);
    return gz(req, res, epg.range(idList(url.searchParams.get('ids')), from, from + hrs * 3600));
  }
  // ---- groups (TiviMate-style browsing), cache only ----
  if (m === 'GET' && p === '/api/groups') {
    const h = new Set(hid[user.sub] || []);
    return gz(req, res, { fav: (favs[user.sub] || []).length, groups: groupList().map(g => ({ ...g, hidden: h.has(g.id) || undefined })) });
  }
  if (m === 'POST' && p === '/api/groups/hidden') {
    const b = await body(req);
    const ids = Array.isArray(b.ids) ? b.ids.map(String).filter(x => /^[0-9A-Za-z_-]{1,20}$/.test(x)).slice(0, 5000) : null;
    if (!ids) return send(res, 400, { error: 'bad ids' });
    hid[user.sub] = [...new Set(ids)]; saveHid();
    return send(res, 200, { hidden: hid[user.sub].length });
  }
  if (m === 'GET' && p === '/api/browse') {
    const l = provider.load(); if (!l) return send(res, 200, { total: 0, items: [] });
    const q = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 100), cat = url.searchParams.get('cat') || '';
    const off = Math.max(0, +url.searchParams.get('offset') || 0), lim = Math.max(1, Math.min(100, +url.searchParams.get('limit') || 60));
    const h = new Set(hid[user.sub] || []), fav = new Set(favs[user.sub] || []);
    const items = []; let total = 0;
    for (const c of l.channels) {
      if (cat === '*') { if (!fav.has(c.id)) continue; } // favorites stay visible even in hidden groups
      else if (h.has(c.cat) || (cat && c.cat !== cat)) continue;
      if (q && !c.name.toLowerCase().includes(q)) continue;
      if (total >= off && items.length < lim) items.push(slim(c));
      total++;
    }
    return gz(req, res, { total, items });
  }
  if (m === 'POST' && (mm = p.match(/^\/api\/watch\/([0-9A-Za-z_-]+)$/))) {
    const v = ch.touch(mm[1], user.sub, true);
    return v ? send(res, 200, v) : send(res, 404, { error: 'not active' });
  }

  // ---- admin ----
  if (!user.admin) return isHtml ? send(res, 302, '', 'text/plain', { Location: B + '/' }) : send(res, 403, { error: 'forbidden' });
  if (m === 'GET' && p === '/admin') return send(res, 200, page('admin.html'), TYPES['.html']);
  if (m === 'GET' && p === '/api/channels') {
    try { return gz(req, res, await provider.getList()); }
    catch (e) { return send(res, 502, { error: redact(e.message) }); }
  }
  // Server-side search/paging so phones never download the full list.
  if (m === 'GET' && p === '/api/search') {
    let l;
    try { l = await provider.getList(); } catch (e) { return send(res, 502, { error: redact(e.message) }); }
    const q = (url.searchParams.get('q') || '').trim().toLowerCase(), cat = url.searchParams.get('cat') || '';
    const off = Math.max(0, +url.searchParams.get('offset') || 0), lim = Math.min(200, +url.searchParams.get('limit') || 100);
    const fav = new Set(favs[user.sub] || []);
    const hit = l.channels.filter(c => (cat === '*' ? fav.has(c.id) : !cat || c.cat === cat) && (!q || c.name.toLowerCase().includes(q)));
    return gz(req, res, { total: hit.length, fetchedAt: l.fetchedAt, count: l.channels.length, items: hit.slice(off, off + lim).map(slim) });
  }
  if (m === 'POST' && p === '/api/refresh') {
    try { const d = await provider.refresh(); epg.reindex(); return send(res, 200, { ok: true, fetchedAt: d.fetchedAt, count: d.channels.length }); }
    catch (e) { return send(res, e.retryAfter ? 429 : 502, { error: redact(e.message), retryAfter: e.retryAfter }); }
  }
  if (m === 'GET' && p === '/api/epg/info') return send(res, 200, epg.info());
  if (m === 'POST' && p === '/api/epg/refresh') {
    try { return send(res, 200, await epg.refresh()); }
    catch (e) { return send(res, e.retryAfter ? 429 : 502, { error: redact(e.message), retryAfter: e.retryAfter }); }
  }
  if (m === 'GET' && p === '/api/settings') return send(res, 200, { ...ch.settings, encoder: ch.encoder });
  if (m === 'POST' && p === '/api/settings') return send(res, 200, ch.setSettings(await body(req)));
  if (m === 'POST' && p === '/api/select') {
    const r = ch.select((await body(req)).id);
    return send(res, r.error ? 409 : 200, r);
  }
  // Replace: stop the old upstream first (awaits ffmpeg exit), then start the new one, so the cap is never exceeded.
  if (m === 'POST' && p === '/api/replace') {
    const b = await body(req);
    const r = await ch.replace(String(b.old || ''), String(b.id || ''));
    return send(res, r.error ? 409 : 200, r);
  }
  if (m === 'POST' && p === '/api/stop') { await ch.stop((await body(req)).id); return send(res, 200, { ok: true }); }
  return send(res, 404, { error: 'not found' });
}

ch.init();
epg.init();
const server = http.createServer((req, res) => {
  handle(req, res).catch(e => { log('error', e.stack || e.message); if (!res.headersSent) send(res, 500, { error: 'error' }); });
});
server.listen(cfg.PORT, cfg.HOST, () => log(`listening on ${cfg.HOST}:${cfg.PORT}${B}/${cfg.DEV_AUTH ? ' (DEV_AUTH)' : ''}`));
if (process.env.DEV_AUTH === '1' && !cfg.DEV_AUTH) log('DEV_AUTH ignored: only allowed with HOST=127.0.0.1');

async function quit() { log('shutting down'); await ch.shutdown(); process.exit(0); }
process.on('SIGINT', quit); process.on('SIGTERM', quit);
