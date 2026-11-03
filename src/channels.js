'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { cfg, log, redact } = require('./config');
const provider = require('./provider');

const SETTINGS_FILE = path.join(cfg.DATA, 'settings.json');
const STATE_FILE = path.join(cfg.DATA, 'state.json');
const DEFAULTS = { maxStreams: 1, resolution: 720, idleSec: 180 };
const WAKE_DEBOUNCE_MS = 30e3;
const BACKOFF_BASE = 5e3, BACKOFF_MAX = 300e3, RETRY_CAP = 6, STABLE_MS = 60e3;
const FATAL = /\b(401|403|429|509)\b|Unauthorized|Forbidden|Too Many Requests/i;

function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function writeJson(f, v) { fs.mkdirSync(cfg.DATA, { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); }

const settings = Object.assign({}, DEFAULTS, readJson(SETTINGS_FILE, {}));
const chans = new Map(); // id -> channel state
let encoder = null;

function detectEncoder() {
  // Local-only test (no provider traffic).
  const r = spawnSync(cfg.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
    '-t', '1', '-c:v', 'h264_nvenc', '-preset', 'p4', '-f', 'null', '-'], { timeout: 20e3 });
  encoder = r.status === 0 ? 'h264_nvenc' : 'libx264';
  log('encoder:', encoder);
}

function saveState() {
  writeJson(STATE_FILE, { selected: [...chans.values()].map(c => ({ id: c.id, name: c.name, down: c.status === 'down' })) });
}

function dirOf(id) { return path.join(cfg.HLS, String(id).replace(/[^0-9A-Za-z_-]/g, '')); }
function clean(id) { try { fs.rmSync(dirOf(id), { recursive: true, force: true }); } catch {} }

function busy() { return [...chans.values()].filter(c => c.proc || c.status === 'backoff').length; }

function ffArgs(id, out) {
  const h = settings.resolution === 480 ? 480 : 720;
  const v = encoder === 'h264_nvenc'
    ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'cbr']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency'];
  const br = h === 720 ? ['-b:v', '2200k', '-maxrate', '2500k', '-bufsize', '4400k'] : ['-b:v', '1200k', '-maxrate', '1400k', '-bufsize', '2400k'];
  return ['-hide_banner', '-nostats', '-loglevel', 'warning', '-user_agent', cfg.UA,
    '-rw_timeout', '15000000', '-i', provider.streamUrl(id),
    '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
    '-vf', `scale=-2:min(${h}\\,ih),format=yuv420p`, ...v, ...br,
    '-g', '60', '-force_key_frames', 'expr:gte(t,n_forced*3)',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
    '-f', 'hls', '-hls_time', '3', '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+independent_segments+omit_endlist',
    '-hls_segment_filename', path.join(out, 'seg_%05d.ts'), path.join(out, 'index.m3u8')];
}

function start(c) {
  if (c.proc || c.status === 'down' || c.status === 'backoff') return false;
  if (busy() >= settings.maxStreams) { c.status = 'idle'; return false; }
  const out = dirOf(c.id);
  clean(c.id); fs.mkdirSync(out, { recursive: true });
  c.status = 'starting'; c.startedAt = Date.now(); c.stopping = false; c.err = '';
  c.lastAccess = Date.now();
  log(`start ${c.id} (${c.name}) ${encoder} ${settings.resolution}p`);
  const p = spawn(cfg.FFMPEG, ffArgs(c.id, out), { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  c.proc = p;
  p.stderr.on('data', d => {
    const s = redact(d.toString()).trim();
    if (!s) return;
    c.err = (c.err + '\n' + s).slice(-2000);
    log(`ffmpeg ${c.id}: ${s.split('\n').slice(-3).join(' | ')}`);
  });
  p.on('error', e => log(`ffmpeg ${c.id} spawn error: ${e.message}`));
  p.on('exit', code => onExit(c, p, code));
  return true;
}

function onExit(c, p, code) {
  if (c.proc !== p) return;
  c.proc = null;
  const ran = Date.now() - c.startedAt;
  log(`ffmpeg ${c.id} exited code=${code} after ${Math.round(ran / 1000)}s${c.stopping ? ' (stopped)' : ''}`);
  if (c.stopping || !chans.has(c.id)) { if (c.status !== 'down') c.status = 'idle'; return pump(); }
  if (FATAL.test(c.err)) { c.status = 'down'; c.reason = 'provider refused'; saveState(); return pump(); }
  if (ran > STABLE_MS) c.failures = 0;
  c.failures = (c.failures || 0) + 1;
  if (c.failures > RETRY_CAP) { c.status = 'down'; c.reason = 'retry cap'; saveState(); return pump(); }
  const delay = Math.min(BACKOFF_BASE * 2 ** (c.failures - 1), BACKOFF_MAX) * (0.8 + Math.random() * 0.4);
  c.status = 'backoff'; c.retryAt = Date.now() + delay;
  log(`backoff ${c.id} #${c.failures} ${Math.round(delay / 1000)}s`);
  c.timer = setTimeout(() => {
    c.timer = null;
    if (c.status !== 'backoff') return;
    c.status = 'idle';
    if (Date.now() - c.lastAccess < settings.idleSec * 1000) start(c);
  }, delay);
}

function kill(c) {
  if (c.timer) { clearTimeout(c.timer); c.timer = null; }
  const p = c.proc;
  if (!p) return Promise.resolve();
  c.stopping = true;
  return new Promise(res => {
    p.once('exit', res);
    try { p.stdin.write('q'); } catch {}
    setTimeout(() => { try { p.kill(); } catch {} }, 3000);
  });
}

// Start waiting channels if capacity frees up.
function pump() {
  for (const c of chans.values()) if (c.status === 'idle' && c.wanted && Date.now() - c.lastAccess < 30e3 && Date.now() - (c.startedAt || 0) > WAKE_DEBOUNCE_MS) start(c);
}

function view(c) {
  const ready = fs.existsSync(path.join(dirOf(c.id), 'index.m3u8'));
  if (c.proc && ready && c.status === 'starting') c.status = 'running';
  const now = Date.now();
  let viewers = 0;
  for (const t of c.viewers.values()) if (now - t < 30e3) viewers++;
  return { id: c.id, name: c.name, status: c.status, ready: !!c.proc && ready, viewers,
    retryIn: c.status === 'backoff' ? Math.ceil((c.retryAt - now) / 1000) : undefined, reason: c.status === 'down' ? c.reason : undefined };
}

function make(id, name) {
  return { id: String(id), name: name || String(id), status: 'idle', proc: null, failures: 0, lastAccess: 0, viewers: new Map() };
}

module.exports = {
  settings,
  init() {
    detectEncoder();
    for (const s of readJson(STATE_FILE, { selected: [] }).selected || []) {
      const c = make(s.id, s.name); if (s.down) { c.status = 'down'; c.reason = 'previously down'; }
      chans.set(c.id, c);
    }
    try { fs.rmSync(cfg.HLS, { recursive: true, force: true }); } catch {}
    setInterval(() => {
      const now = Date.now();
      for (const c of chans.values()) {
        if (c.proc && now - c.lastAccess > settings.idleSec * 1000) { log(`idle stop ${c.id}`); kill(c).then(() => clean(c.id)); }
      }
    }, 15e3).unref();
  },
  get encoder() { return encoder; },
  list() { return [...chans.values()].map(view); },
  has(id) { return chans.has(String(id)); },
  dir: dirOf,
  // Admin selects a channel: (re)arms it and starts it now (probe).
  select(id) {
    id = String(id);
    let c = chans.get(id);
    if (!c) {
      if ([...chans.values()].length >= settings.maxStreams) return { error: 'cap reached' };
      const meta = provider.channel(id);
      if (!meta) return { error: 'unknown channel' };
      c = make(id, meta.name); chans.set(id, c);
    }
    if (c.status === 'down' || c.status === 'backoff') { if (c.timer) clearTimeout(c.timer); c.timer = null; c.status = 'idle'; c.failures = 0; }
    c.wanted = true;
    saveState();
    start(c);
    return { ok: true, channel: view(c) };
  },
  async stop(id) {
    const c = chans.get(String(id));
    if (!c) return;
    chans.delete(c.id);
    saveState();
    await kill(c); clean(c.id); pump();
  },
  // Viewer activity: touch + start on demand.
  touch(id, who, wake) {
    const c = chans.get(String(id));
    if (!c) return null;
    c.lastAccess = Date.now(); c.viewers.set(who, Date.now());
    // Only channels an admin selected exist in `chans`, so a viewer can never open an upstream
    // for anything else. An already-running upstream is never restarted or duplicated (start()
    // bails on c.proc), and restarting an idle-stopped channel is debounced to once per 30s.
    if (wake) {
      c.wanted = true;
      if (!c.proc && c.status === 'idle' && Date.now() - (c.startedAt || 0) > WAKE_DEBOUNCE_MS) start(c);
    }
    return view(c);
  },
  setSettings(s) {
    if (s.maxStreams != null) settings.maxStreams = Math.max(1, Math.min(4, parseInt(s.maxStreams, 10) || 1));
    if (s.resolution != null) settings.resolution = parseInt(s.resolution, 10) === 480 ? 480 : 720;
    if (s.idleSec != null) settings.idleSec = Math.max(30, Math.min(3600, parseInt(s.idleSec, 10) || 180));
    writeJson(SETTINGS_FILE, settings);
    return settings;
  },
  async shutdown() { await Promise.all([...chans.values()].map(kill)); },
};
