'use strict';
// The media switcher: constant phone and TV playlists that follow the current channel, with a slate while nothing plays.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { cfg, log } = require('./config');
const ch = require('./channels');
const { LivePlaylist, parseMedia } = require('./playlist');

const POLL_MS = 250;
const SLATE_SECS = 60, SLATE_RETRY_MS = 60e3;
const lists = {}; // rendition -> LivePlaylist
const slates = new Map(); // height -> { key, list } once ready, { failedAt } after a failure, {} while generating

function loadSlate(dir) {
  try {
    const list = parseMedia(fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf8')).map(s => ({ file: path.join(dir, s.uri), dur: s.dur }));
    return list.length && list.every(s => fs.existsSync(s.file)) ? list : null;
  } catch { return null; }
}

// Black and silent with the same codecs as the channel encodes, one keyframe per segment. Timestamps run across the
// whole set; the live writer retimes each loop to keep MPEG timestamps continuous.
function slateArgs(h, dir) {
  const w = Math.round(h * 16 / 9 / 2) * 2;
  return ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:r=30`,
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', String(SLATE_SECS), '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-bf', '0', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', h > 720 ? '160k' : '128k', '-ac', '2', '-ar', '48000',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(dir, 's_%03d.ts'), path.join(dir, 'index.m3u8')];
}

function makeSlate(h, dir) {
  const tmp = dir + '.tmp', fail = why => { log(`slate ${h}p failed: ${why}`); slates.set(h, { failedAt: Date.now() }); };
  try {
    fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
  } catch (e) { return fail(e.message); }
  const p = spawn(cfg.FFMPEG, slateArgs(h, tmp), { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let err = '';
  p.stderr.on('data', d => { err = (err + d).slice(-500); });
  p.on('error', e => fail(e.message));
  p.on('exit', code => {
    if (code !== 0) return fail(`ffmpeg exit ${code}: ${err}`);
    try {
      fs.renameSync(tmp, dir);
      const list = loadSlate(dir);
      if (!list) return fail('no segments');
      slates.set(h, { key: `slate:${h}`, list, retime: true });
      log(`slate ${h}p ready`);
    } catch (e) { fail(e.message); }
  });
}

// Generated on first need, then cached in data/ across restarts. Null until it exists.
function slate(h) {
  let s = slates.get(h);
  if (!s || Date.now() - (s.failedAt || Date.now()) > SLATE_RETRY_MS) {
    const dir = path.join(cfg.DATA, 'slate', `v2-${h}p`), list = loadSlate(dir);
    slates.set(h, list ? { key: `slate:${h}`, list, retime: true } : {});
    if (!list) makeSlate(h, dir);
    s = slates.get(h);
  }
  return s.list ? s : null;
}

function step() {
  const src = ch.liveSource(), now = Date.now();
  // A channel running without the TV output still feeds the TV playlist: 720p beats a black screen.
  lists.phone.step(now, src, slate(ch.settings.resolution === 480 ? 480 : 720));
  lists.tv.step(now, src && (src.tv ? { key: src.key, dir: path.join(src.dir, 'tv') } : src), slate(1080));
}

module.exports = {
  init() {
    for (const r of ['phone', 'tv']) {
      lists[r] = new LivePlaylist({ dir: path.join(cfg.HLS, 'live', r) });
      fs.mkdirSync(lists[r].dir, { recursive: true });
    }
    step();
    setInterval(() => { try { step(); } catch (e) { log('live step failed:', e.message); } }, POLL_MS).unref();
  },
  playlist: r => lists[r].render(),
  segment: (r, seq) => lists[r].file(+seq),
  get onSlate() { return lists.phone.onSlate; },
};
