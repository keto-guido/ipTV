'use strict';
// XMLTV guide: fetched from the provider at most every 12h (+ rate-limited manual refresh),
// stream-parsed, trimmed to a now-2h..now+24h window and cached in data/epg.json.
// Clients are only ever served from this cache.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');
const { cfg, getProvider, log, redact } = require('./config');
const provider = require('./provider');

const FILE = path.join(cfg.DATA, 'epg.json');
const TTL = 12 * 3600e3, MANUAL_MIN = 3600e3, BEFORE = 2 * 3600, AFTER = 24 * 3600, DESC = 140;
let cache = null, busy = null, lastFetch = 0, lastError = '';
let byStream = new Map(); // stream id -> programmes array
let byEpg = new Map(), lower = new Map(); // epg id -> [stream ids]; epg id -> lowercased 'title desc' per programme

function index() {
  byStream = new Map();
  const list = provider.load();
  if (!cache || !list) return;
  byEpg = new Map(); lower = new Map();
  for (const c of list.channels) if (c.epg && cache.ch[c.epg]) {
    byStream.set(c.id, cache.ch[c.epg]);
    if (!byEpg.has(c.epg)) { byEpg.set(c.epg, []); lower.set(c.epg, cache.ch[c.epg].map(p => (p[2] + ' ' + (p[3] || '')).toLowerCase())); }
    byEpg.get(c.epg).push(c.id);
  }
}
function load() {
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); lastFetch = cache.fetchedAt; } catch { cache = null; }
  index();
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n ? String.fromCodePoint(n) : ''; }
    return ENT[e] ?? m;
  }).replace(/\s+/g, ' ').trim();
}
function time(s) { // "20261103120000 +0000" -> unix seconds
  const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?\s*([+-])?(\d\d)?(\d\d)?/.exec(s || '');
  if (!m) return 0;
  let t = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000;
  if (m[7]) t -= (m[7] === '-' ? -1 : 1) * ((+m[8]) * 3600 + (+m[9] || 0) * 60);
  return t;
}
const attr = (s, n) => { const m = new RegExp(`\\b${n}="([^"]*)"`).exec(s); return m ? m[1] : ''; };
const inner = (s, n) => { const m = new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)</${n}>`).exec(s); return m ? decode(m[1]) : ''; };

async function fetchEpg() {
  const p = getProvider();
  if (!p) throw new Error('provider credentials missing');
  const list = provider.load();
  const wanted = new Set(list ? list.channels.map(c => c.epg).filter(Boolean) : []);
  const t0 = Date.now(), now = Math.floor(t0 / 1000), lo = now - BEFORE, hi = now + AFTER;
  log('epg: fetching guide');
  const r = await fetch(p.epgUrl, { headers: { 'User-Agent': cfg.UA, 'Accept-Encoding': 'gzip' }, signal: AbortSignal.timeout(15 * 60e3) });
  if (!r.ok) throw new Error(`provider HTTP ${r.status}`);
  let src = Readable.fromWeb(r.body);
  // Body may itself be a .gz file regardless of headers: sniff magic bytes.
  const it = src[Symbol.asyncIterator]();
  const first = await it.next();
  const head = first.done ? Buffer.alloc(0) : Buffer.from(first.value);
  const rest = Readable.from((async function* () { yield head; for (let x = await it.next(); !x.done; x = await it.next()) yield x.value; })());
  src = head[0] === 0x1f && head[1] === 0x8b ? rest.pipe(zlib.createGunzip()) : rest;
  src.setEncoding('utf8');

  const ch = Object.create(null);
  let buf = '', bytes = 0, seen = 0, kept = 0;
  for await (const chunk of src) {
    bytes += Buffer.byteLength(chunk);
    buf += chunk;
    let i = 0;
    for (;;) {
      const s = buf.indexOf('<programme', i);
      if (s < 0) { i = Math.max(i, buf.length - 16); break; }
      const e = buf.indexOf('</programme>', s);
      if (e < 0) { i = s; break; }
      const block = buf.slice(s, e); i = e + 12; seen++;
      const head = block.slice(0, block.indexOf('>') + 1);
      const id = decode(attr(head, 'channel'));
      if (!wanted.has(id)) continue;
      const a = time(attr(head, 'start')), b = time(attr(head, 'stop'));
      if (!a || b <= lo || a >= hi) continue;
      let d = inner(block, 'desc'); if (d.length > DESC) d = d.slice(0, DESC - 1) + '…';
      (ch[id] || (ch[id] = [])).push([a, b || a + 1800, inner(block, 'title'), d]);
      kept++;
    }
    buf = buf.slice(i);
    if (buf.length > 4e6) buf = buf.slice(-1e6); // malformed safety
  }
  for (const k in ch) { ch[k].sort((x, y) => x[0] - y[0]); }
  const data = { fetchedAt: t0, ch };
  fs.mkdirSync(cfg.DATA, { recursive: true });
  const json = JSON.stringify(data);
  fs.writeFileSync(FILE, json);
  cache = data; lastFetch = t0; index();
  const stats = { mbIn: +(bytes / 1048576).toFixed(1), programmes: seen, kept, channels: Object.keys(ch).length,
    mbCache: +(json.length / 1048576).toFixed(1), sec: +((Date.now() - t0) / 1000).toFixed(1), rssMb: Math.round(process.memoryUsage().rss / 1048576) };
  cache.stats = stats;
  log('epg:', JSON.stringify(stats));
  return stats;
}

function run() {
  if (!busy) busy = fetchEpg().then(s => { lastError = ''; return s; }, e => { lastError = redact(e.message); log('epg error:', lastError); throw e; }).finally(() => { busy = null; });
  return busy;
}

module.exports = {
  init() {
    load();
    if (process.env.EPG_AUTO === '0') return;
    // Scheduled refresh only when cache is missing/stale; checked every 30 min.
    const check = () => { if (!busy && Date.now() - lastFetch > TTL && provider.load()) { lastFetch = Date.now(); run().catch(() => {}); } };
    setTimeout(check, 60e3).unref(); setInterval(check, 30 * 60e3).unref();
  },
  reindex: index,
  refresh() {
    const wait = lastFetch + MANUAL_MIN - Date.now();
    if (wait > 0) { const e = new Error('rate limited'); e.retryAfter = Math.ceil(wait / 1000); return Promise.reject(e); }
    lastFetch = Date.now();
    return run();
  },
  info() { return { fetchedAt: cache ? cache.fetchedAt : 0, channels: cache ? Object.keys(cache.ch).length : 0, busy: !!busy, error: lastError || undefined, stats: cache && cache.stats }; },
  // [now, next] for each stream id
  nowNext(ids) {
    const t = Date.now() / 1000, out = {};
    for (const id of ids) {
      const a = byStream.get(id); if (!a) continue;
      let k = a.findIndex(p => p[1] > t);
      if (k < 0) continue;
      out[id] = a[k][0] <= t ? a.slice(k, k + 2) : [null, a[k]];
    }
    return out;
  },
  // Programmes airing now..+24h whose title/desc contains q. Earliest match per guide channel; live first.
  search(q, ok, lim = 40) {
    q = String(q || '').toLowerCase().trim(); if (q.length < 2) return [];
    const now = Date.now() / 1000, hi = now + 86400, hits = [];
    for (const [eid, ids] of byEpg) {
      const ps = cache.ch[eid], lc = lower.get(eid);
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i]; if (p[1] <= now || p[0] >= hi || !lc[i].includes(q)) continue;
        for (const id of ids) if (ok(id)) hits.push({ id, p });
        break;
      }
      if (hits.length > 3000) break;
    }
    hits.sort((x, y) => (x.p[0] > now) - (y.p[0] > now) || x.p[0] - y.p[0]);
    return hits.slice(0, lim);
  },
  range(ids, from, to) {
    const out = {};
    for (const id of ids) { const a = byStream.get(id); if (a) out[id] = a.filter(p => p[1] > from && p[0] < to); }
    return out;
  },
};
