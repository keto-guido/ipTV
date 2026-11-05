'use strict';
// ffmpeg arg builder and TV fallback logic. ffmpeg is mocked: nothing is spawned and no provider is contacted.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { cfg } = require('../src/config');

// Must happen before channels.js loads: its init() wipes cfg.HLS, and production uses the default one.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-tv-test-'));
Object.assign(cfg, { DATA: path.join(tmp, 'data'), HLS: path.join(tmp, 'hls'), SECRETS_FILE: path.join(tmp, 'none') });
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const OUT = path.join('C:', 'out', '123');
const URL_STUB = 'http://stub.invalid/x.m3u8';

// The full phone-only argument list. tv=true must keep this output apart from moving the scale into the split.
function phoneOnly(codec, h, br) {
  return ['-hide_banner', '-nostats', '-loglevel', 'warning', '-user_agent', 'VLC/3.0.20 LibVLC/3.0.20',
    '-rw_timeout', '15000000', '-i', URL_STUB, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
    '-vf', `scale=-2:min(${h}\\,ih),format=yuv420p`, ...codec, ...br, ...(codec === NVENC ? ['-no-scenecut', '1', '-forced-idr', '1'] : ['-sc_threshold', '0']),
    '-g', '60', '-force_key_frames', 'expr:gte(t,n_forced*1)',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
    '-f', 'hls', '-hls_time', '1', '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+independent_segments+omit_endlist+program_date_time',
    '-hls_segment_filename', path.join(OUT, 'seg_%05d.ts'), path.join(OUT, 'index.m3u8')];
}
const NVENC = ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'cbr'];
const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency'];
const BR720 = ['-b:v', '2200k', '-maxrate', '2500k', '-bufsize', '4400k'];
const BR480 = ['-b:v', '1200k', '-maxrate', '1400k', '-bufsize', '2400k'];

let procs, realSpawn, realSync;

// Fresh copy of channels.js (it keeps encoder/fallback state per process) with one selected channel.
function boot({ nvenc = true, probe = true, settings } = {}) {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(cfg.DATA, { recursive: true });
  fs.writeFileSync(path.join(cfg.DATA, 'state.json'), JSON.stringify({ selected: [{ id: '123', name: 'Test' }] }));
  if (settings) fs.writeFileSync(path.join(cfg.DATA, 'settings.json'), JSON.stringify(settings));
  cp.spawnSync = (bin, args) => ({ status: (args.includes('-filter_complex') ? probe : nvenc) ? 0 : 1 });
  cp.spawn = (bin, args) => {
    const p = new EventEmitter();
    Object.assign(p, { args, stderr: new EventEmitter(), stdin: { write() {} }, kill() {} });
    procs.push(p);
    return p;
  };
  for (const m of ['../src/channels', '../src/provider']) delete require.cache[require.resolve(m)];
  require('../src/provider').streamUrl = () => URL_STUB;
  const ch = require('../src/channels');
  ch.init();
  return ch;
}
const die = (p, msg, code = 1) => { if (msg) p.stderr.emit('data', Buffer.from(msg)); p.emit('exit', code); };

beforeEach(() => { procs = []; realSpawn = cp.spawn; realSync = cp.spawnSync; delete process.env.TV_RENDITION; });
afterEach(() => { cp.spawn = realSpawn; cp.spawnSync = realSync; delete process.env.TV_RENDITION; });

test('tv=false: phone-only args (NVENC 720p)', () => {
  assert.deepEqual(boot().ffArgs('123', OUT, false), phoneOnly(NVENC, 720, BR720));
});

test('tv=false: phone-only args (NVENC 480p)', () => {
  assert.deepEqual(boot({ settings: { resolution: 480 } }).ffArgs('123', OUT, false), phoneOnly(NVENC, 480, BR480));
});

test('tv=false: phone-only args (libx264), with no NVENC-only options', () => {
  assert.deepEqual(boot({ nvenc: false }).ffArgs('123', OUT, false), phoneOnly(X264, 720, BR720));
});

test('tv=true: phone output keeps every option; only the scale moves into the split', () => {
  for (const [res, br] of [[720, BR720], [480, BR480]]) {
    const a = boot({ settings: { resolution: res } }).ffArgs('123', OUT, true);
    const fc = a[a.indexOf('-filter_complex') + 1];
    assert.equal(fc, `[0:v:0]split=2[p][t];[p]scale=-2:min(${res}\\,ih),format=yuv420p[pv];[t]scale=-2:min(1080\\,ih),format=yuv420p[tv]`);
    // Undo the permitted change and cut at the end of the phone output: must be the phone-only args.
    const phoneEnd = a.indexOf(path.join(OUT, 'index.m3u8')) + 1;
    const phone = a.slice(0, phoneEnd);
    phone.splice(phone.indexOf('-filter_complex'), 2);
    phone[phone.indexOf('[pv]')] = '0:v:0';
    const want = phoneOnly(NVENC, res, br);
    want.splice(want.indexOf('-vf'), 2);
    assert.deepEqual(phone, want);
  }
});

test('tv=true: TV output has the 1080p / 1 s keyframe / 1 s segment / PDT options', () => {
  const a = boot().ffArgs('123', OUT, true);
  const tv = a.slice(a.indexOf(path.join(OUT, 'index.m3u8')) + 1);
  const opt = k => tv[tv.indexOf(k) + 1];
  assert.deepEqual(tv.slice(0, 4), ['-map', '[tv]', '-map', '0:a:0?']);
  assert.equal(opt('-c:v'), 'h264_nvenc'); assert.equal(opt('-preset'), 'p4'); assert.equal(opt('-rc'), 'cbr');
  assert.equal(opt('-b:v'), '7000k'); assert.equal(opt('-maxrate'), '8000k'); assert.equal(opt('-bufsize'), '14000k');
  assert.equal(opt('-force_key_frames'), 'expr:gte(t,n_forced*1)');
  assert.equal(opt('-no-scenecut'), '1');
  assert.equal(opt('-b:a'), '160k'); assert.equal(opt('-ar'), '48000'); assert.equal(opt('-ac'), '2');
  assert.equal(opt('-hls_time'), '1'); assert.equal(opt('-hls_list_size'), '6');
  assert.equal(opt('-hls_flags'), 'delete_segments+independent_segments+omit_endlist+program_date_time');
  assert.equal(opt('-hls_segment_filename'), path.join(OUT, 'tv', 'seg_%05d.ts'));
  assert.equal(tv.at(-1), path.join(OUT, 'tv', 'index.m3u8'));
});

test('tv=true: one input only, so one provider connection', () => {
  const a = boot().ffArgs('123', OUT, true);
  assert.equal(a.filter(x => x === '-i').length, 1);
  assert.equal(a.filter(x => x === URL_STUB).length, 1);
});

test('default: a started channel gets the TV output and its directory', () => {
  const ch = boot();
  assert.equal(ch.settings.tvRendition, true);
  const v = ch.touch('123', 'u', true);
  assert.equal(procs.length, 1);
  assert.ok(procs[0].args.includes('-filter_complex'));
  assert.ok(fs.statSync(path.join(ch.dir('123'), 'tv')).isDirectory());
  assert.equal(v.tv, true);
});

test('settings tvRendition=false: started channel is phone-only', () => {
  const ch = boot({ settings: { tvRendition: false } });
  const v = ch.touch('123', 'u', true);
  assert.ok(!procs[0].args.includes('-filter_complex'));
  assert.equal(v.tv, false);
  assert.ok(!fs.existsSync(path.join(ch.dir('123'), 'tv')));
});

test('env TV_RENDITION=0 wins, and is not written into settings.json', () => {
  process.env.TV_RENDITION = '0';
  const ch = boot();
  ch.touch('123', 'u', true);
  assert.ok(!procs[0].args.includes('-filter_complex'));
  ch.setSettings({ idleSec: 200 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(cfg.DATA, 'settings.json'), 'utf8')).tvRendition, true);
});

test('libx264 fallback keeps TV off even with the flag on', () => {
  const ch = boot({ nvenc: false });
  ch.touch('123', 'u', true);
  assert.equal(ch.encoder, 'libx264');
  assert.ok(!procs[0].args.includes('-filter_complex'));
});

test('failed dual-encode probe: TV off, phone pipeline as today', () => {
  const ch = boot({ probe: false });
  ch.touch('123', 'u', true);
  assert.equal(ch.encoder, 'h264_nvenc');
  assert.ok(!procs[0].args.includes('-filter_complex'));
});

test('runtime NVENC error: restarts phone-only, on the normal backoff, once', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1e12 });
  const ch = boot();
  ch.touch('123', 'u', true);
  die(procs[0], '[h264_nvenc @ 0] OpenEncodeSessionEx failed: out of memory (10)');
  assert.equal(ch.list()[0].status, 'backoff');
  // First retry is 5 s +/-20 %: never sooner than 4 s, and no second process meanwhile.
  t.mock.timers.tick(3999);
  assert.equal(procs.length, 1);
  t.mock.timers.tick(2100);
  assert.equal(procs.length, 2);
  assert.ok(!procs[1].args.includes('-filter_complex'));
  // Stays off for the rest of the process.
  die(procs[1], 'Connection reset');
  t.mock.timers.tick(13000);
  assert.equal(procs.length, 3);
  assert.ok(!procs[2].args.includes('-filter_complex'));
});

test('upstream failure does not disable TV', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1e12 });
  const ch = boot();
  ch.touch('123', 'u', true);
  die(procs[0], 'Connection timed out');
  t.mock.timers.tick(6100);
  assert.equal(procs.length, 2);
  assert.ok(procs[1].args.includes('-filter_complex'));
  assert.equal(ch.list()[0].tv, true);
});

test('real ffmpeg 7 encoder failure text disables TV; a bare "before EOF" line does not', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1e12 });
  // Captured from ffmpeg 7.0.2 on the GTX 1060 with an oversized frame.
  const real = '[h264_nvenc @ 0] No capable devices found\n[vost#0:0/h264_nvenc @ 0] Error while opening encoder - maybe incorrect parameters';
  for (const [msg, tvAfter] of [['[vost#0:0/h264_nvenc @ 0] Could not open encoder before EOF', true], [real, false]]) {
    procs = [];
    boot().touch('123', 'u', true);
    die(procs[0], msg);
    t.mock.timers.tick(6100);
    assert.equal(procs.length, 2);
    assert.equal(procs[1].args.includes('-filter_complex'), tvAfter, msg);
  }
});

test('provider refusal still marks the channel down, with no restart', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1e12 });
  const ch = boot();
  ch.touch('123', 'u', true);
  die(procs[0], 'Server returned 403 Forbidden');
  assert.equal(ch.list()[0].status, 'down');
  t.mock.timers.tick(600e3);
  assert.equal(procs.length, 1);
});

test('NVENC error text on a stopped channel does not disable TV', async () => {
  const ch = boot();
  ch.touch('123', 'u', true);
  procs[0].stderr.emit('data', Buffer.from('OpenEncodeSessionEx failed'));
  const stopped = ch.shutdown();
  procs[0].emit('exit', 0);
  await stopped;
  assert.equal(ch.list()[0].status, 'idle');
});

test('tvRendition setting round-trips through setSettings', () => {
  const ch = boot();
  assert.equal(ch.setSettings({ tvRendition: false }).tvRendition, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cfg.DATA, 'settings.json'), 'utf8')).tvRendition, false);
  assert.equal(ch.setSettings({ idleSec: 200 }).tvRendition, false);
  assert.equal(ch.setSettings({ tvRendition: true }).tvRendition, true);
});
