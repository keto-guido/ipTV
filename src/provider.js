'use strict';
const fs = require('fs');
const path = require('path');
const { cfg, getProvider, log } = require('./config');

const FILE = path.join(cfg.DATA, 'channels.json');
let cache = null, lastFetch = 0, inflight = null;

// ---- variant merging (in memory only; channels.json keeps the raw list) ----
// We restream at 720p, so one representative per channel: plain/SD > HD > FHD > UHD/4K, non-backup first.
const TAGS = /\b(?:UHD|FHD|HD|SD|[48]K|HEVC|H\.?26[45]|[256]0 ?FPS|BACKUP ?\d?|BK|B\/U|ALT|RAW)\b/g;
const BACKUP = /\b(?:BACKUP|BK|B\/U|ALT)\b/;
function norm(name) {
  return String(name).toUpperCase().replace(/[���]/g, '').replace(TAGS, ' ')
    .replace(/[^\p{L}\p{N}:&+'|-]+/gu, ' ').replace(/(\s*[-|:]\s*)+$/, '').replace(/\(\s*\)|\[\s*\]/g, ' ').replace(/\s+/g, ' ').trim();
}
function rank(name) {
  const s = String(name).toUpperCase().replace(/[���]/g, '');
  const tier = /\b(?:UHD|[48]K)\b/.test(s) ? 3 : /\bFHD\b/.test(s) ? 2 : /\bHD\b/.test(s) ? 1 : 0;
  return tier * 4 + (BACKUP.test(s) ? 2 : 0) + (/\b(?:HEVC|H\.?265)\b/.test(s) ? 1 : 0);
}
function merge(raw) {
  const groups = new Map();
  for (const c of raw.channels) {
    const n = norm(c.name) || c.name;
    const key = /^[\p{L}\p{N}]{1,6} ?[-|:] /u.test(n) ? n : c.cat + '|' + n; // cross-category only with a prefix like "US - "
    (groups.get(key) || groups.set(key, []).get(key)).push(c);
  }
  const channels = [], rep = new Map(), alts = new Map();
  for (const g of groups.values()) {
    g.sort((a, b) => rank(a.name) - rank(b.name) || a.name.length - b.name.length || a.id - b.id);
    const best = { ...g[0] };
    if (!best.epg) { const e = g.find(x => x.epg); if (e) best.epg = e.epg; }
    channels.push(best);
    for (const x of g) rep.set(x.id, best.id);
    if (g.length > 1) alts.set(best.id, g.slice(1).map(x => ({ id: x.id, name: x.name })));
  }
  const order = new Map(raw.channels.map((c, i) => [c.id, i]));
  channels.sort((a, b) => order.get(a.id) - order.get(b.id));
  return { ...raw, channels, rawCount: raw.channels.length, all: raw.channels, rep, alts };
}
function repOf(id) { const c = load(); return (c && c.rep.get(String(id))) || String(id); }

function load() {
  if (cache) return cache;
  try { cache = merge(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { cache = null; }
  if (cache) lastFetch = cache.fetchedAt || 0;
  return cache;
}

async function api(action) {
  const p = getProvider();
  if (!p) throw new Error('provider credentials missing (config/secrets.env)');
  const q = new URLSearchParams({ username: p.username, password: p.password });
  if (action) q.set('action', action);
  const r = await fetch(`${p.origin}/player_api.php?${q}`, {
    headers: { 'User-Agent': cfg.UA }, signal: AbortSignal.timeout(60e3),
  });
  if (!r.ok) throw new Error(`provider HTTP ${r.status}`);
  return r.json();
}

async function fetchList() {
  log('provider: fetching channel list');
  const cats = await api('get_live_categories');
  const streams = await api('get_live_streams');
  const catName = {};
  for (const c of cats || []) catName[c.category_id] = c.category_name;
  const data = {
    fetchedAt: Date.now(),
    categories: (cats || []).map(c => ({ id: String(c.category_id), name: c.category_name })),
    channels: (streams || []).map(s => ({
      id: String(s.stream_id), name: s.name, cat: String(s.category_id ?? ''),
      icon: s.stream_icon || '', epg: s.epg_channel_id || '',
    })),
  };
  fs.mkdirSync(cfg.DATA, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data));
  cache = merge(data); lastFetch = data.fetchedAt;
  log(`provider: ${data.channels.length} channels, ${data.categories.length} categories cached`);
  return cache;
}

// Returns cached list; fetches only if missing or older than 12h.
async function getList() {
  const c = load();
  if (c && Date.now() - c.fetchedAt < cfg.LIST_TTL_MS) return c;
  if (!inflight) inflight = fetchList().finally(() => { inflight = null; });
  try { return await inflight; } catch (e) { if (c) return c; throw e; }
}

// Manual refresh, rate limited.
async function refresh() {
  load();
  const wait = lastFetch + cfg.REFRESH_MIN_MS - Date.now();
  if (wait > 0) { const e = new Error('rate limited'); e.retryAfter = Math.ceil(wait / 1000); throw e; }
  lastFetch = Date.now();
  if (!inflight) inflight = fetchList().finally(() => { inflight = null; });
  return inflight;
}

function channel(id) {
  const c = load();
  return c && c.all.find(x => x.id === String(id)); // alternates stay resolvable (saved state, old links)
}

function streamUrl(id) {
  const p = getProvider();
  return `${p.origin}/live/${encodeURIComponent(p.username)}/${encodeURIComponent(p.password)}/${encodeURIComponent(id)}.m3u8`;
}

module.exports = { getList, refresh, channel, streamUrl, load, repOf, alts: id => { const c = load(); return (c && c.alts.get(String(id))) || []; } };
