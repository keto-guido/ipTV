'use strict';
const fs = require('fs');
const path = require('path');
const { cfg, getProvider, log } = require('./config');

const FILE = path.join(cfg.DATA, 'channels.json');
let cache = null, lastFetch = 0, inflight = null;

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { cache = null; }
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
  cache = data; lastFetch = data.fetchedAt;
  log(`provider: ${data.channels.length} channels, ${data.categories.length} categories cached`);
  return data;
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
  return c && c.channels.find(x => x.id === String(id));
}

function streamUrl(id) {
  const p = getProvider();
  return `${p.origin}/live/${encodeURIComponent(p.username)}/${encodeURIComponent(p.password)}/${encodeURIComponent(id)}.m3u8`;
}

module.exports = { getList, refresh, channel, streamUrl, load };
