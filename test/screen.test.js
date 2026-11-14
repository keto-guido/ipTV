'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const cp = require('child_process');
const { cfg } = require('../src/config');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-screen-test-'));
Object.assign(cfg, { DATA: path.join(tmp, 'data'), HLS: path.join(tmp, 'hls'), SECRETS_FILE: path.join(tmp, 'none') });
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const realSpawn = cp.spawn, realSync = cp.spawnSync;
let procs, screen, ch, providerCalls, devices, audioProbes, holdAudio;
const originalAudioDevice = process.env.SCREEN_AUDIO_DEVICE;
beforeEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  procs = []; providerCalls = []; devices = ''; audioProbes = []; holdAudio = false;
  delete process.env.SCREEN_AUDIO_DEVICE;
  cp.spawnSync = () => ({ status: 1 });
  cp.spawn = (bin, args) => {
    const p = new EventEmitter();
    Object.assign(p, { args, stderr: new EventEmitter(), stdin: { write() { queueMicrotask(() => p.emit('exit', 0)); } }, kill() { p.killed = true; } });
    if (args.includes('-list_devices')) {
      audioProbes.push(p);
      if (!holdAudio) queueMicrotask(() => { p.stderr.emit('data', devices); p.emit('exit', 1); });
    } else if (args.includes('-frames:v')) queueMicrotask(() => p.emit('exit', args.some(a => a.startsWith('ddagrab=')) ? 1 : 0));
    else procs.push(p);
    return p;
  };
  for (const m of ['screen', 'channels', 'provider']) delete require.cache[require.resolve('../src/' + m)];
  const provider = require('../src/provider');
  provider.channel = id => { assert.notEqual(id, 'screen'); providerCalls.push(id); return { name: 'Test' }; };
  provider.streamUrl = id => { assert.notEqual(id, 'screen'); return 'http://stub.invalid/test'; };
  screen = require('../src/screen'); ch = require('../src/channels'); ch.init();
});
afterEach(async () => { await ch.shutdown(); cp.spawn = realSpawn; cp.spawnSync = realSync;
  if (originalAudioDevice === undefined) delete process.env.SCREEN_AUDIO_DEVICE; else process.env.SCREEN_AUDIO_DEVICE = originalAudioDevice;
});
const settle = () => new Promise(resolve => setImmediate(resolve));
async function enable() { ch.setSettings({ mckinleyScreen: true }); await screen.init('mock'); }

test('local args retain output codecs, GOP, bitrates and HLS; no provider options', () => {
  for (const encoder of ['h264_nvenc', 'libx264']) for (const height of [480, 720]) for (const grab of ['gdigrab', 'ddagrab']) {
    const a = screen.ffArgs({ encoder, height, grab, tv: true, out: tmp });
    const opt = k => a[a.indexOf(k) + 1];
    assert.ok(!a.includes('-user_agent')); assert.ok(!a.includes('-rw_timeout')); assert.ok(!a.some(x => /https?:/.test(x)));
    assert.ok(a.includes('anullsrc=r=48000:cl=stereo')); assert.ok(a.includes(grab === 'ddagrab' ? '0:a:0' : '1:a:0'));
    assert.equal(opt('-g'), '15'); assert.equal(opt('-force_key_frames'), 'expr:gte(t,n_forced*0.5)');
    assert.equal(opt('-hls_time'), '0.5'); assert.equal(opt('-hls_list_size'), '4'); assert.equal(opt('-b:v'), height === 720 ? '2200k' : '1200k');
    assert.equal(opt('-bf'), '0'); assert.equal(opt('-fflags'), 'nobuffer'); assert.equal(opt('-flags'), 'low_delay'); assert.ok(!a.includes('-re'));
    if (encoder === 'h264_nvenc') {
      assert.equal(opt('-preset'), 'p1'); assert.equal(opt('-tune'), 'ull'); assert.equal(opt('-rc'), 'cbr');
      for (const k of ['-rc-lookahead', '-delay']) assert.equal(opt(k), '0');
      assert.equal(opt('-zerolatency'), '1');
    }
    assert.ok(a.includes('7000k')); assert.ok(a.includes('160k')); assert.ok(opt('-filter_complex').includes('split=2'));
    if (grab === 'ddagrab') assert.ok(opt('-filter_complex').includes('hwdownload,format=bgra'));
  }
  const a = screen.ffArgs({ encoder: 'libx264', tv: false, out: tmp, audioDevice: 'Stereo Mix' });
  assert.ok(a.includes('audio=Stereo Mix')); assert.ok(!a.includes('anullsrc=r=48000:cl=stereo'));
});
test('ddagrab uses a filter source and input 0 audio; gdigrab retains input 1 audio', () => {
  const source = 'ddagrab=output_idx=0:framerate=30:draw_mouse=1,hwdownload,format=bgra,';
  for (const grab of ['ddagrab', 'gdigrab']) for (const tv of [false, true]) for (const audioDevice of [null, 'Stereo Mix']) {
    const a = screen.ffArgs({ encoder: 'libx264', grab, tv, audioDevice, out: tmp });
    const maps = a.flatMap((arg, i) => arg === '-map' ? [a[i + 1]] : []);
    const inputs = a.flatMap((arg, i) => arg === '-i' ? [a[i + 1]] : []);
    const audioInput = audioDevice ? 'audio=Stereo Mix' : 'anullsrc=r=48000:cl=stereo';
    if (grab === 'ddagrab') {
      assert.deepEqual(inputs, [audioInput]);
      assert.ok(!inputs.some(input => input.startsWith('ddagrab=')));
      const filter = a[a.indexOf('-filter_complex') + 1];
      assert.ok(filter.startsWith(source));
      assert.equal(filter, tv
        ? `${source}split=2[p][t];[p]scale=-2:min(720\\,ih),format=yuv420p[pv];[t]scale=-2:min(1080\\,ih),format=yuv420p[tv]`
        : `${source}scale=-2:min(720\\,ih),format=yuv420p[pv]`);
      assert.deepEqual(maps, tv ? ['[pv]', '0:a:0', '[tv]', '0:a:0'] : ['[pv]', '0:a:0']);
      assert.ok(!a.includes('-vf')); assert.ok(!a.includes('0:v:0'));
      if (audioDevice) assert.deepEqual(a.slice(a.indexOf('-f'), a.indexOf('-i') + 2), ['-f', 'dshow', '-thread_queue_size', '64', '-i', audioInput]);
    } else {
      assert.equal(a[a.indexOf('-f') + 1], 'gdigrab');
      assert.deepEqual(inputs, ['desktop', audioInput]);
      assert.deepEqual(maps, tv ? ['[pv]', '1:a:0', '[tv]', '1:a:0'] : ['0:v:0', '1:a:0']);
      if (!tv) assert.ok(a.includes('-vf'));
    }
  }
});

test('off is unavailable; enabling persists and never starts capture', async () => {
  assert.deepEqual(ch.select('screen'), { error: 'unavailable' });
  await enable(); assert.equal(procs.length, 0);
  assert.equal(screen.result().grab, 'gdigrab'); assert.equal(screen.result().audio, 'silent AAC');
  assert.equal(JSON.parse(fs.readFileSync(path.join(cfg.DATA, 'settings.json'))).mckinleyScreen, true);
  assert.equal(ch.setSettings({ idleSec: 60 }).mckinleyScreen, true);
});
test('screen starts at provider cap without provider lookup; view supports nowplaying', async () => {
  ch.select('123'); assert.equal(ch.busy(), 1);
  await enable(); const r = ch.select('screen'); assert.equal(r.ok, true); assert.equal(ch.busy(), 1);
  await settle(); assert.equal(procs.length, 2); assert.deepEqual(providerCalls, ['123']);
  fs.writeFileSync(path.join(ch.dir('screen'), 'index.m3u8'), '#EXTM3U');
  const v = ch.list().find(c => c.id === 'screen');
  assert.equal(screen.nowPlaying(v).playing, true); assert.equal(screen.nowPlaying(v).state, 'running');
  assert.deepEqual(ch.liveChannel(), { id: 'screen', name: 'McKinley Screen' });
  assert.equal(ch.liveSource().lowLatency, true);
});
test('running screen consumes no provider slot and disabling stops it', async () => {
  await enable(); ch.select('screen'); await settle(); assert.equal(ch.busy(), 0);
  ch.select('123'); assert.equal(ch.busy(), 1);
  await ch.stop('123'); ch.select('screen');
  ch.setSettings({ mckinleyScreen: false }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(ch.screen().ready, false); assert.equal(ch.screen().status, 'down');
  assert.deepEqual(ch.select('screen'), { error: 'unavailable' });
});
test('replace works in both directions', async () => {
  await enable(); ch.select('123'); assert.equal((await ch.replace('123', 'screen')).ok, true);
  assert.equal((await ch.replace('screen', '456')).ok, true); assert.deepEqual(providerCalls, ['123', '456', '456']);
});
test('screen failures use bounded local retries even with 403 text', () => {
  assert.equal(screen.classifyExit({ err: '403', failures: 0 }).action, 'retry');
  assert.equal(screen.classifyExit({ err: '401', failures: 3 }).action, 'down');
});
test('loopback detection never chooses microphones', () => {
  assert.equal(screen.loopbackDevice('"Microphone (Loopback)" (audio)'), null);
  assert.equal(screen.loopbackDevice('"Stereo Mix" (audio)'), 'Stereo Mix');
  const stream = 'SteelSeries Sonar - Stream (SteelSeries Sonar Virtual Audio Device)';
  assert.equal(screen.loopbackDevice('"' + stream + '" (audio)'), stream);
  assert.equal(screen.loopbackDevice('"SteelSeries Sonar - Microphone (SteelSeries Sonar Virtual Audio Device)" (audio)'), null);
});
test('LAN checks use forwarded client addresses; loopback always allowed', () => {
  const req = (ip, headers = {}) => ({ socket: { remoteAddress: ip }, headers });
  for (const ip of ['127.0.0.1', '::1', '192.168.10.208', '::ffff:192.168.10.208']) assert.equal(screen.isLan(req(ip)), true);
  assert.equal(screen.isLan(req('8.8.8.8')), false);
  assert.equal(screen.isLan(req('8.8.8.8', { 'x-forwarded-for': '192.168.10.2' })), false);
  assert.equal(screen.isLan(req('192.168.10.2', { 'x-forwarded-for': '8.8.8.8, 192.168.10.2' })), false);
  assert.equal(screen.isLan(req('192.168.10.2', { 'x-real-ip': '8.8.8.8' })), false);
});

test('hung grab probe is killed at the wall-clock timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let p;
  cp.spawn = () => { p = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => { p.killed = true; }; return p; };
  const result = screen.probe('mock', [], 4000);
  t.mock.timers.tick(4000);
  assert.equal((await result).ok, false); assert.equal(p.killed, true);
});
test('restored screen remains stopped on viewer touch; explicit selection starts it', async () => {
  fs.mkdirSync(cfg.DATA, { recursive: true });
  fs.writeFileSync(path.join(cfg.DATA, 'settings.json'), JSON.stringify({ mckinleyScreen: true }));
  fs.writeFileSync(path.join(cfg.DATA, 'state.json'), JSON.stringify({ live: 'screen', selected: [{ id: 'screen', name: screen.NAME }] }));
  delete require.cache[require.resolve('../src/channels')]; ch = require('../src/channels'); ch.init();
  await screen.init('mock'); ch.touch('screen', 'viewer', true);
  assert.equal(procs.length, 0); assert.equal(ch.liveSource(), null);
  ch.select('screen'); await settle(); assert.equal(procs.length, 1);
});

test('screen audio is re-probed on each start and exposed in diagnostics', async () => {
  await enable(); ch.select('screen'); ch.select('screen'); await settle();
  assert.equal(procs.length, 1); assert.equal(audioProbes.length, 1);
  assert.ok(procs[0].args.includes('anullsrc=r=48000:cl=stereo'));
  await ch.stop('screen');
  const device = 'SteelSeries Sonar - Stream (SteelSeries Sonar Virtual Audio Device)';
  devices = '"' + device + '" (audio)';
  ch.select('screen'); await settle();
  assert.equal(audioProbes.length, 2); assert.equal(procs.length, 2);
  assert.ok(procs[1].args.includes('audio=' + device));
  assert.equal(ch.screen().audioDevice, device); assert.equal(ch.screen().audio, device);
});

test('settings override persists, env wins, and clearing restores detection', async () => {
  await enable(); devices = '"Stereo Mix" (audio)';
  ch.setSettings({ screenAudioDevice: '  Custom capture  ' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(cfg.DATA, 'settings.json'))).screenAudioDevice, 'Custom capture');
  ch.select('screen'); await settle();
  assert.ok(procs[0].args.includes('audio=Custom capture'));
  await ch.stop('screen');
  process.env.SCREEN_AUDIO_DEVICE = '  Env capture  ';
  ch.select('screen'); await settle();
  assert.ok(procs[1].args.includes('audio=Env capture'));
  await ch.stop('screen'); delete process.env.SCREEN_AUDIO_DEVICE;
  assert.equal(ch.setSettings({ screenAudioDevice: 123 }).screenAudioDevice, 'Custom capture');
  assert.equal(ch.setSettings({ screenAudioDevice: '' }).screenAudioDevice, null);
  ch.select('screen'); await settle();
  assert.ok(procs[2].args.includes('audio=Stereo Mix'));
  assert.equal(ch.setSettings({ screenAudioDevice: 'Other' }).screenAudioDevice, 'Other');
  assert.equal(ch.setSettings({ screenAudioDevice: null }).screenAudioDevice, null);
});

test('stop during audio probe prevents capture spawn', async () => {
  await enable(); holdAudio = true;
  ch.select('screen'); await settle();
  assert.equal(ch.screen().status, 'probing'); assert.equal(audioProbes.length, 1);
  await ch.stop('screen');
  audioProbes[0].emit('exit', 1); await settle();
  assert.equal(procs.length, 0); assert.equal(ch.has('screen'), false);
});

test('disabling or shutdown during audio probe prevents capture spawn', async () => {
  await enable(); holdAudio = true;
  ch.select('screen'); await settle();
  ch.setSettings({ mckinleyScreen: false });
  audioProbes[0].emit('exit', 1); await settle();
  assert.equal(procs.length, 0);
  ch.setSettings({ mckinleyScreen: true }); ch.select('screen'); await settle();
  await ch.shutdown(); audioProbes[1].emit('exit', 1); await settle();
  assert.equal(procs.length, 0);
});
