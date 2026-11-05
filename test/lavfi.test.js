'use strict';
// Real ffmpeg + NVENC on a local test pattern, writing to a temp dir: the provider is never contacted.
// Uses the real arg builder; only the input is swapped. Skipped where NVENC is unavailable.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { cfg } = require('../src/config');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-lavfi-test-'));
Object.assign(cfg, { DATA: path.join(tmp, 'data'), HLS: path.join(tmp, 'hls'), SECRETS_FILE: path.join(tmp, 'none') });
after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const provider = require('../src/provider');
provider.streamUrl = () => 'http://stub.invalid/x.m3u8';
const ch = require('../src/channels');
ch.init();
const skip = ch.encoder === 'h264_nvenc' ? false : 'NVENC not available';
const FFPROBE = path.join(path.dirname(cfg.FFMPEG), 'ffprobe' + path.extname(cfg.FFMPEG));

function encode(name, tv, rate, secs) {
  const out = path.join(tmp, name);
  fs.mkdirSync(path.join(out, 'tv'), { recursive: true });
  const a = ch.ffArgs('x', out, tv);
  // Replaces -user_agent ... -rw_timeout ... -i <url>; the two lavfi pads become 0:v:0 and 0:a:0, so the maps stay as they are.
  a.splice(a.indexOf('-user_agent'), 6, '-re', '-t', String(secs), '-f', 'lavfi',
    '-i', `testsrc2=size=1920x1080:rate=${rate}[out0];sine=frequency=440:sample_rate=48000[out1]`);
  return new Promise((ok, bad) => {
    const p = spawn(cfg.FFMPEG, a, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    const t = setTimeout(() => p.kill(), (secs + 20) * 1000);
    p.stderr.on('data', d => { err += d; });
    p.on('error', bad);
    p.on('exit', code => { clearTimeout(t); code === 0 ? ok(out) : bad(new Error(`ffmpeg exit ${code}: ${err.slice(-800)}`)); });
  });
}
function probe(f, ...args) {
  return spawnSync(FFPROBE, ['-v', 'error', ...args, '-of', 'json', f], { encoding: 'utf8' });
}
function video(f) { return JSON.parse(probe(f, '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,pix_fmt').stdout).streams[0]; }
function audio(f) { return JSON.parse(probe(f, '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels').stdout).streams[0]; }
function keys(f) {
  const r = probe(f, '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time');
  return JSON.parse(r.stdout).frames.map(x => +x.pts_time);
}
// Parses a playlist into [{ uri, dur, pdt }].
function playlist(dir) {
  const segs = []; let dur, pdt;
  for (const l of fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf8').split(/\r?\n/)) {
    if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8));
    else if (l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pdt = Date.parse(l.slice(25));
    else if (l && !l.startsWith('#')) { segs.push({ uri: l, dur, pdt, file: path.join(dir, l) }); pdt = undefined; }
  }
  return segs;
}
const full = s => s.slice(0, -1); // the last segment is cut short by the end of the test input

let before, split;
test('59.94 fps: phone output is unchanged by the split, TV output meets the brief', { skip }, async () => {
  before = await encode('phone-only', false, '60000/1001', 13);
  split = await encode('split', true, '60000/1001', 13);

  // ---- phone ----
  const a = playlist(before), b = playlist(split);
  assert.deepEqual(b.map(s => [s.uri, s.dur]), a.map(s => [s.uri, s.dur]));
  assert.ok(a.length >= 4);
  for (const s of full(b)) assert.ok(Math.abs(s.dur - 2) < 0.1, `phone segment ${s.dur}`);
  assert.ok(b.every(s => Number.isFinite(s.pdt)), 'every phone segment carries PDT');
  assert.ok(!fs.existsSync(path.join(before, 'tv', 'index.m3u8')));
  const seg = b[1].file;
  assert.deepEqual(video(seg), video(a[1].file));
  assert.equal(video(seg).width, 1280); assert.equal(video(seg).height, 720);
  assert.deepEqual(keys(seg), keys(a[1].file));
  const size = l => l.reduce((n, s) => n + fs.statSync(s.file).size, 0);
  const ratio = size(b) / size(a);
  assert.ok(ratio > 0.9 && ratio < 1.1, `phone size ratio ${ratio}`);

  // ---- tv ----
  const dir = path.join(split, 'tv'), t = playlist(dir);
  assert.ok(t.length >= 5);
  for (const s of full(t)) assert.ok(Math.abs(s.dur - 2) < 0.1, `tv segment ${s.dur}`);
  assert.ok(t.every(s => Number.isFinite(s.pdt)), 'every segment carries PDT');
  for (let i = 1; i < t.length; i++) assert.ok(Math.abs(t[i].pdt - t[i - 1].pdt - t[i - 1].dur * 1000) < 2, 'PDT follows durations');
  const v = video(t[1].file);
  assert.deepEqual([v.codec_name, v.width, v.height, v.pix_fmt], ['h264', 1920, 1080, 'yuv420p']);
  const au = audio(t[1].file);
  assert.deepEqual([au.codec_name, au.sample_rate, au.channels], ['aac', '48000', 2]);
  const mbps = size(full(t)) * 8 / full(t).reduce((n, s) => n + s.dur, 0) / 1e6;
  assert.ok(mbps > 5.5 && mbps < 8.5, `tv bitrate ${mbps}`);

  // PDT stays near the wall clock: a segment's end is stamped about when its file is finished.
  const skew = full(t).map(s => s.pdt + s.dur * 1000 - fs.statSync(s.file).mtimeMs);
  const maxSkew = Math.max(...skew.map(Math.abs));
  assert.ok(maxSkew < 3000, `PDT skew ${maxSkew} ms`);
  console.log(`measured: tv ${mbps.toFixed(2)} Mbit/s TS, phone size ratio ${ratio.toFixed(3)}, PDT-vs-file-time skew ${Math.round(Math.min(...skew))}..${Math.round(Math.max(...skew))} ms`);
});

for (const [label, rate, secs] of [['59.94', '60000/1001', 0], ['29.97', '30000/1001', 9], ['25', '25', 9]]) {
  test(`${label} fps: keyframes every 1 s on both renditions, and every segment opens on one`, { skip }, async () => {
    const out = secs ? await encode(`r${rate.replace('/', '-')}`, true, rate, secs) : split;
    for (const dir of [out, path.join(out, 'tv')]) {
      const segs = full(playlist(dir));
      const k = segs.flatMap(s => keys(s.file));
      const gaps = k.slice(1).map((t, i) => t - k[i]);
      assert.ok(gaps.length >= 3);
      for (const g of gaps) assert.ok(g > 0.95 && g < 1.05, `keyframe gap ${g} in ${gaps}`);
      for (const s of segs) {
        const first = JSON.parse(probe(s.file, '-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_entries', 'frame=key_frame,pict_type').stdout).frames[0];
        assert.deepEqual([first.key_frame, first.pict_type], [1, 'I'], s.uri);
      }
      console.log(`measured ${label} fps: ${k.length} keyframes, gaps ${Math.min(...gaps).toFixed(3)}..${Math.max(...gaps).toFixed(3)} s`);
    }
  });
}
