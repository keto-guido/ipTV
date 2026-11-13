'use strict';
// Mock ffmpeg and use isolated paths; no provider connections.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const EventEmitter = require('events');
const { cfg } = require('../src/config');

function boot(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1e12 });
  const root = fs.mkdtempSync(path.join(__dirname, '.idle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  Object.assign(cfg, { DATA: path.join(root, 'data'), HLS: path.join(root, 'hls'), SECRETS_FILE: path.join(root, 'none') });
  fs.mkdirSync(cfg.DATA);
  fs.writeFileSync(path.join(cfg.DATA, 'state.json'), JSON.stringify({ selected: [{ id: '123', name: 'Test' }] }));
  const procs = [], logs = [];
  t.mock.method(cp, 'spawnSync', () => ({ status: 1 }));
  t.mock.method(cp, 'spawn', () => {
    const p = new EventEmitter();
    Object.assign(p, { stderr: new EventEmitter(), stdin: { write() { p.quit = true; p.emit('exit', 0); } }, kill() {} });
    procs.push(p); return p;
  });
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  for (const m of ['../src/channels', '../src/provider']) delete require.cache[require.resolve(m)];
  require('../src/provider').streamUrl = () => 'http://stub.invalid/not-contacted';
  const ch = require('../src/channels'); ch.init(); ch.settings.idleSec = 90;
  return { ch, procs, logs };
}

test('keepalive extends a running deadline; idle keepalive starts nothing', t => {
  const { ch, procs, logs } = boot(t);
  ch.keepalive('123', 'idle');
  assert.equal(procs.length, 0);
  ch.select('123');
  t.mock.timers.tick(60e3); ch.keepalive('123', 'viewer');
  t.mock.timers.tick(45e3);
  assert.equal(procs[0].quit, undefined);
  t.mock.timers.tick(60e3);
  assert.equal(procs[0].quit, true);
  assert.equal(ch.list()[0].status, 'idle');
  assert.ok(logs.some(s => /idle stop 123 \(no viewer activity for 105s; idleSec 90; ran 165s; viewers seen this run: 1\)/.test(s)));
  for (let i = 0; i < 4; i++) { ch.keepalive('123', 'idle'); t.mock.timers.tick(30e3); }
  assert.equal(procs.length, 1);
  assert.equal(ch.list()[0].viewers, 0);
});

test('a run without viewer activity stops after idleSec', t => {
  const { ch, procs, logs } = boot(t);
  ch.select('123'); t.mock.timers.tick(105e3);
  assert.equal(procs[0].quit, true);
  assert.ok(logs.some(s => /idle stop 123 .*viewers seen this run: 0/.test(s)));
});

test('viewer diagnostics log first activity and gaps over 60s, resetting per run', t => {
  const { ch, logs } = boot(t);
  const lines = () => logs.filter(s => s.includes('viewers 123:'));
  ch.select('123'); ch.keepalive('123', 'one');
  for (let i = 0; i < 4; i++) { t.mock.timers.tick(30e3); ch.touch('123', 'two', false); }
  assert.equal(lines().length, 1);
  t.mock.timers.tick(60e3); ch.keepalive('123', 'two');
  assert.equal(lines().length, 1);
  t.mock.timers.tick(61e3); ch.touch('123', 'three', false);
  assert.equal(lines().length, 2);
  assert.match(lines()[1], /activity from three \(1 active\)/);
  t.mock.timers.tick(105e3); ch.select('123'); ch.keepalive('123', 'new-run');
  assert.equal(lines().length, 3);
});

test('authenticated live phone and TV playlists leave the selected channel idle', async t => {
  const net = require('net'), crypto = require('crypto');
  const root = fs.mkdtempSync(path.join(__dirname, '.idle-route-'));
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'state.json'), JSON.stringify({ selected: [{ id: '123', name: 'Test' }] }));
  const secret = 'idle-test-secret-012345678901234567890';
  fs.writeFileSync(path.join(root, 'jwt'), secret);
  const port = await new Promise(ok => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); });
  });
  const proc = cp.spawn(process.execPath, [path.join(__dirname, 'fixture-server.js')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TEST_ROOT: root, HOST: '127.0.0.1', PORT: String(port), BASE_PATH: '/tv', EPG_AUTO: '0', DEV_AUTH: '0' },
  });
  let output = '';
  proc.stdout.on('data', d => { output += d; });
  t.after(async () => {
    if (proc.exitCode === null) {
      const done = new Promise(ok => proc.once('exit', ok)); proc.kill(); await done;
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await new Promise((ok, bad) => {
    proc.stdout.on('data', () => { if (output.includes('listening on')) ok(); });
    proc.once('error', bad); proc.once('exit', code => bad(new Error(`fixture exited ${code}`)));
  });
  const b = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ sub: 'viewer', roles: ['tv'], exp: Math.floor(Date.now() / 1000) + 300 })}`;
  const token = `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
  const get = p => fetch(`http://127.0.0.1:${port}/tv${p}`, { headers: { Cookie: `msv_session=${token}` } });
  for (const rendition of ['phone', 'tv']) {
    // No slate or ffmpeg: this exercises the starting response too.
    const res = await get(`/hls/live/${rendition}/index.m3u8`);
    assert.equal(res.status, 503); await res.text();
    const status = await (await get('/api/status')).json();
    assert.equal(status.channels[0].status, 'idle');
    assert.equal(status.channels[0].viewers, 0);
  }
  assert.doesNotMatch(output, /\bstart 123\b/);
});
