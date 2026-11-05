'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { cfg, log, redact } = require('./config');
const provider = require('./provider');

const SETTINGS_FILE = path.join(cfg.DATA, 'settings.json');
const STATE_FILE = path.join(cfg.DATA, 'state.json');
const DEFAULTS = { maxStreams: 1, resolution: 720, idleSec: 180, tvRendition: true };
const WAKE_DEBOUNCE_MS = 30e3;
const BACKOFF_BASE = 5e3, BACKOFF_MAX = 300e3, RETRY_CAP = 6, STABLE_MS = 60e3;
const REFUSED_RETRY_CAP = 3; // a 403 is retried far less patiently than a dropped connection
const LOOP_WINDOW_MS = 30 * 60e3, LOOP_CAP = 5; // restarts after "played, then 403" allowed per rolling window
const BLOCKED = /\b(401|429|509)\b|Unauthorized|Too Many Requests/i; // bad credentials or over the connection limit: never retried
const REFUSED = /\b403\b|Forbidden/i; // fatal only if the stream never got going
const TV_FAIL = /OpenEncodeSessionEx|No capable devices|No NVENC|out of memory|InitializeEncoder|Error while opening encoder/i;

// Pure: decides what a finished ffmpeg run means. err: its stderr tail; segments: this run produced HLS output;
// wasLive: an earlier run in the current streak did (so a 403 now is a blip, e.g. the old connection not yet released).
// loops: restarts in the rolling window after a run that played past STABLE_MS and then got a 403. Each such run resets
// `failures`, so without this count the cycle would go on forever; a counted restart comes back with loop: true.
function classifyExit({ err = '', segments = false, wasLive = false, ranMs = 0, failures = 0, loops = 0 }) {
  if (BLOCKED.test(err)) return { action: 'down', failures, reason: 'provider rejected the connection (auth or connection limit)' };
  const refused = REFUSED.test(err);
  if (refused && !segments && !wasLive) return { action: 'down', failures, reason: 'provider refused (403) before the stream started' };
  const loop = refused && segments && ranMs > STABLE_MS;
  if (loop && loops >= LOOP_CAP) return { action: 'down', failures, reason: `provider keeps cutting the stream (403 after playback), gave up after ${LOOP_CAP} restarts in ${LOOP_WINDOW_MS / 60e3} min` };
  const n = (ranMs > STABLE_MS ? 0 : failures) + 1, cap = refused ? REFUSED_RETRY_CAP : RETRY_CAP;
  if (n > cap) return { action: 'down', failures: n, reason: `${refused ? 'provider kept refusing (403)' : 'stream kept failing'}, gave up after ${cap} retries` };
  return { action: 'retry', failures: n, reason: refused ? 'provider refused (403), retrying' : 'stream ended, retrying', ...(loop && { loop }) };
}

function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function writeJson(f, v) { fs.mkdirSync(cfg.DATA, { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); }

const settings = Object.assign({}, DEFAULTS, readJson(SETTINGS_FILE, {}));
const chans = new Map(); // id -> channel state
let liveId = null; // the channel the live playlists follow: the latest one selected
let incoming = null; // the channel a replace is switching to, so clients never see "nothing on" while the old one stops
let encoder = null;
let tvBroken = false; // set once by the startup probe or a runtime encoder failure; lasts for this process

function detectEncoder() {
  // Local-only test (no provider traffic).
  const r = spawnSync(cfg.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
    '-t', '1', '-c:v', 'h264_nvenc', '-preset', 'p4', '-f', 'null', '-'], { timeout: 20e3 });
  encoder = r.status === 0 ? 'h264_nvenc' : 'libx264';
  log('encoder:', encoder);
  if (encoder === 'h264_nvenc') probeTv();
}

// Local-only test (no provider traffic): can NVENC run the 720p and 1080p encodes side by side?
function probeTv() {
  const nvenc = ['-c:v', 'h264_nvenc', '-preset', 'p4', '-f', 'null', '-'];
  const r = spawnSync(cfg.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-t', '1', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
    '-filter_complex', '[0:v]split=2[a][b];[a]scale=-2:720[p];[b]scale=-2:1080[t]',
    '-map', '[p]', ...nvenc, '-map', '[t]', ...nvenc], { timeout: 20e3 });
  tvBroken = r.status !== 0;
  log('tv rendition probe:', tvBroken ? 'failed, phone output only' : 'ok');
}

// libx264 never gets the TV output: the CPU would not cope.
function tvOn() {
  return settings.tvRendition !== false && process.env.TV_RENDITION !== '0' && encoder === 'h264_nvenc' && !tvBroken;
}

function saveState() {
  writeJson(STATE_FILE, { live: liveId, selected: [...chans.values()].map(c => ({ id: c.id, name: c.name, down: c.status === 'down', reason: c.status === 'down' ? c.reason : undefined })) });
}

function dirOf(id) { return path.join(cfg.HLS, String(id).replace(/[^0-9A-Za-z_-]/g, '')); }
function clean(id) { try { fs.rmSync(dirOf(id), { recursive: true, force: true }); } catch {} }

function liveCh() { return chans.get(liveId) || [...chans.values()].pop() || null; }

function busy() { return [...chans.values()].filter(c => c.proc || c.status === 'backoff').length; }

function ffArgs(id, out, tv) {
  const h = settings.resolution === 480 ? 480 : 720;
  const v = encoder === 'h264_nvenc'
    ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'cbr']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency'];
  const br = h === 720 ? ['-b:v', '2200k', '-maxrate', '2500k', '-bufsize', '4400k'] : ['-b:v', '1200k', '-maxrate', '1400k', '-bufsize', '2400k'];
  const input = ['-hide_banner', '-nostats', '-loglevel', 'warning', '-user_agent', cfg.UA,
    '-rw_timeout', '15000000', '-i', provider.streamUrl(id)];
  const scale = `scale=-2:min(${h}\\,ih),format=yuv420p`;
  // Both outputs: an IDR every second and 1 s segments, for the latency of the live playlists.
  // Source fps is unknown without probing upstream, so -g is the ceiling for inputs up to 60 fps; the forced keyframes set the real GOP.
  const gop = [...(encoder === 'h264_nvenc' ? ['-no-scenecut', '1', '-forced-idr', '1'] : ['-sc_threshold', '0']),
    '-g', '60', '-force_key_frames', 'expr:gte(t,n_forced*1)'];
  const hls = ['-f', 'hls', '-hls_time', '1', '-hls_list_size', '6', '-hls_flags', 'delete_segments+independent_segments+omit_endlist+program_date_time'];
  const phone = [...v, ...br, ...gop,
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
    ...hls,
    '-hls_segment_filename', path.join(out, 'seg_%05d.ts'), path.join(out, 'index.m3u8')];
  if (!tv) return [...input, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-vf', scale, ...phone];
  return [...input,
    '-filter_complex', `[0:v:0]split=2[p][t];[p]${scale}[pv];[t]scale=-2:min(1080\\,ih),format=yuv420p[tv]`,
    '-map', '[pv]', '-map', '0:a:0?', '-sn', '-dn', ...phone,
    '-map', '[tv]', '-map', '0:a:0?', '-sn', '-dn',
    ...v, '-b:v', '7000k', '-maxrate', '8000k', '-bufsize', '14000k', ...gop,
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000',
    ...hls,
    '-hls_segment_filename', path.join(out, 'tv', 'seg_%05d.ts'), path.join(out, 'tv', 'index.m3u8')];
}

function start(c) {
  if (c.proc || c.status === 'down' || c.status === 'backoff') return false;
  if (busy() >= settings.maxStreams) { c.status = 'idle'; return false; }
  const out = dirOf(c.id);
  c.tv = tvOn();
  clean(c.id); fs.mkdirSync(c.tv ? path.join(out, 'tv') : out, { recursive: true });
  c.run = (c.run || 0) + 1;
  c.status = 'starting'; c.startedAt = Date.now(); c.stopping = false; c.err = ''; c.reason = undefined;
  c.lastAccess = Date.now();
  log(`start ${c.id} (${c.name}) ${encoder} ${settings.resolution}p${c.tv ? ' + tv 1080p' : ''}`);
  const p = spawn(cfg.FFMPEG, ffArgs(c.id, out, c.tv), { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
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
  if (c.stopping || !chans.has(c.id)) { if (c.status !== 'down') c.status = 'idle'; c.wasLive = false; return pump(); }
  // Only flips the flag: the normal backoff below still decides when (and whether) the channel restarts.
  if (c.tv && !tvBroken && TV_FAIL.test(c.err)) { tvBroken = true; log(`tv rendition off until restart: encoder error on ${c.id}`); }
  const segments = fs.existsSync(path.join(dirOf(c.id), 'index.m3u8')); // written once the first segment is complete
  const now = Date.now();
  c.loops = c.loops.filter(t => now - t < LOOP_WINDOW_MS);
  const r = classifyExit({ err: c.err, segments, wasLive: c.wasLive, ranMs: ran, failures: c.failures, loops: c.loops.length });
  c.wasLive = c.wasLive || segments; c.failures = r.failures; c.reason = r.reason;
  if (r.loop) c.loops.push(now);
  if (r.action === 'down') { c.status = 'down'; log(`down ${c.id}: ${r.reason}`); saveState(); return pump(); }
  const delay = Math.min(BACKOFF_BASE * 2 ** (c.failures - 1), BACKOFF_MAX) * (0.8 + Math.random() * 0.4);
  log(`backoff ${c.id} #${c.failures} ${Math.round(delay / 1000)}s`);
  restartIn(c, delay);
}

function restartIn(c, delay) {
  c.status = 'backoff'; c.retryAt = Date.now() + delay;
  c.timer = setTimeout(() => {
    c.timer = null;
    if (c.status !== 'backoff') return;
    c.status = 'idle';
    if (Date.now() - c.lastAccess < settings.idleSec * 1000) start(c);
  }, delay);
}

// Explicit user request: clears down/backoff and restarts, at most once per 30 s however often it is asked.
function rearm(c) {
  if (c.status === 'down' || c.status === 'backoff') {
    if (c.timer) clearTimeout(c.timer);
    c.timer = null; c.status = 'idle'; c.failures = 0; c.wasLive = false; c.reason = undefined; c.loops = [];
  }
  c.wanted = true;
  saveState();
  const wait = (c.startedAt || 0) + WAKE_DEBOUNCE_MS - Date.now();
  if (c.proc || wait <= 0) return start(c);
  c.lastAccess = Date.now(); c.reason = 'retry requested';
  restartIn(c, wait);
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
  return { id: c.id, name: c.name, status: c.status, ready: !!c.proc && ready, tv: !!c.proc && c.tv, viewers,
    retryIn: c.status === 'backoff' ? Math.ceil((c.retryAt - now) / 1000) : undefined, reason: c.status === 'down' || c.status === 'backoff' ? c.reason : undefined };
}

function make(id, name) {
  return { id: String(id), name: name || String(id), status: 'idle', proc: null, failures: 0, loops: [], lastAccess: 0, viewers: new Map() };
}

module.exports = {
  settings,
  ffArgs, // exported for tests
  classifyExit,
  init() {
    detectEncoder();
    const saved = readJson(STATE_FILE, { selected: [] });
    liveId = saved.live || null;
    for (const s of saved.selected || []) {
      const c = make(s.id, s.name); if (s.down) { c.status = 'down'; c.reason = s.reason || 'previously down'; }
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
  liveChannel() { const c = incoming || liveCh(); return c && { id: c.id, name: c.name }; },
  // The running output the live playlists should follow; a new key means a new ffmpeg run, so new timestamps.
  liveSource() { const c = liveCh(); return c && c.proc ? { key: `${c.id}:${c.run}`, dir: dirOf(c.id), tv: !!c.tv } : null; },
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
    liveId = id;
    rearm(c);
    return { ok: true, channel: view(c) };
  },
  // Any viewer may retry a down channel: it is already admin-selected, so no new upstream can be opened this way.
  retry(id) {
    const c = chans.get(String(id));
    if (!c) return null;
    if (c.status === 'down') rearm(c);
    return view(c);
  },
  async replace(oldId, id) {
    if (!/^[0-9A-Za-z_-]{1,20}$/.test(id)) return { error: 'bad id' };
    const meta = provider.channel(id);
    if (!meta) return { error: 'unknown channel' };
    incoming = { id, name: meta.name };
    try { if (oldId && oldId !== id && chans.has(oldId)) await module.exports.stop(oldId); }
    finally { incoming = null; }
    return module.exports.select(id);
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
  // Heartbeat: extends the idle timer of a running upstream. On anything else it changes nothing, because a fresh
  // lastAccess is what lets pump() and the backoff timer start a channel.
  keepalive(id, who) {
    const c = chans.get(String(id));
    if (!c) return null;
    if (c.proc) { c.lastAccess = Date.now(); c.viewers.set(who, Date.now()); }
    return view(c);
  },
  setSettings(s) {
    if (s.maxStreams != null) settings.maxStreams = Math.max(1, Math.min(4, parseInt(s.maxStreams, 10) || 1));
    if (s.resolution != null) settings.resolution = parseInt(s.resolution, 10) === 480 ? 480 : 720;
    if (s.idleSec != null) settings.idleSec = Math.max(30, Math.min(3600, parseInt(s.idleSec, 10) || 180));
    if (s.tvRendition != null) settings.tvRendition = !!s.tvRendition;
    writeJson(SETTINGS_FILE, settings);
    return settings;
  },
  async shutdown() { await Promise.all([...chans.values()].map(kill)); },
};
