'use strict';
// Exit classification, circuit breaker, retry and keepalive. ffmpeg is mocked: nothing is spawned and no provider is contacted.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { cfg } = require('../src/config');

// Must happen before channels.js loads: its init() wipes cfg.HLS, and production uses the default one.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-recovery-test-'));
Object.assign(cfg, { DATA: path.join(tmp, 'data'), HLS: path.join(tmp, 'hls'), SECRETS_FILE: path.join(tmp, 'none') });
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const FORBIDDEN = 'HTTP error 403 Forbidden\nFailed to reload playlist 0';
const REFUSED_AT_OPEN = 'Server returned 403 Forbidden (access denied)';
const realSpawn = cp.spawn, realSync = cp.spawnSync;
let procs = [];

function boot(selected = [{ id: '123', name: 'Test' }]) {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(cfg.DATA, { recursive: true });
  fs.writeFileSync(path.join(cfg.DATA, 'state.json'), JSON.stringify({ selected }));
  cp.spawnSync = () => ({ status: 1 });
  cp.spawn = (bin, args) => {
    const p = new EventEmitter();
    Object.assign(p, { args, stderr: new EventEmitter(), stdin: { write() { p.quit = true; } }, kill() {} });
    procs.push(p);
    return p;
  };
  for (const m of ['../src/channels', '../src/provider']) delete require.cache[require.resolve(m)];
  require('../src/provider').streamUrl = () => 'http://stub.invalid/x.m3u8';
  const ch = require('../src/channels');
  ch.init();
  return ch;
}
const die = (p, msg, code = 1) => { if (msg) p.stderr.emit('data', Buffer.from(msg)); p.emit('exit', code); };
const segments = ch => fs.writeFileSync(path.join(ch.dir('123'), 'index.m3u8'), '#EXTM3U');
const state = ch => ch.list()[0];
const timers = t => t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1e12 });

beforeEach(() => { procs = []; });
afterEach(() => { cp.spawn = realSpawn; cp.spawnSync = realSync; });

// ---- classifyExit ----
const { classifyExit } = boot();

test('403 with no segments ever is fatal, however long it took', () => {
  for (const ranMs of [2e3, 14e3, 90e3]) {
    const r = classifyExit({ err: REFUSED_AT_OPEN, ranMs });
    assert.equal(r.action, 'down');
    assert.match(r.reason, /403/);
  }
  assert.equal(classifyExit({ err: 'Forbidden' }).action, 'down');
});

test('403 or EOF after segments is retried, and the failure is counted', () => {
  assert.deepEqual(classifyExit({ err: FORBIDDEN, segments: true, ranMs: 30e3, failures: 1 }),
    { action: 'retry', failures: 2, reason: 'provider refused (403), retrying' });
  assert.deepEqual(classifyExit({ err: 'End of file', segments: true, ranMs: 30e3 }),
    { action: 'retry', failures: 1, reason: 'stream ended, retrying' });
});

test('a long healthy run starts a new streak', () => {
  assert.equal(classifyExit({ err: FORBIDDEN, segments: true, ranMs: 146e3, failures: 3 }).failures, 1);
});

test('403 on a retry of a stream that was live is retried, not fatal', () => {
  assert.equal(classifyExit({ err: FORBIDDEN, wasLive: true, ranMs: 1e3, failures: 1 }).action, 'retry');
});

test('repeated 403 trips the breaker after 3 retries, other failures after 6', () => {
  assert.equal(classifyExit({ err: FORBIDDEN, wasLive: true, failures: 2 }).action, 'retry');
  const r = classifyExit({ err: FORBIDDEN, wasLive: true, failures: 3 });
  assert.equal(r.action, 'down');
  assert.equal(r.reason, 'provider kept refusing (403), gave up after 3 retries');
  assert.equal(classifyExit({ err: 'End of file', failures: 5 }).action, 'retry');
  assert.equal(classifyExit({ err: 'End of file', failures: 6 }).reason, 'stream kept failing, gave up after 6 retries');
});

test('401, 429 and 509 stay fatal even mid-stream', () => {
  for (const err of ['HTTP error 401 Unauthorized', 'HTTP error 429 Too Many Requests', 'Server returned 509'])
    assert.equal(classifyExit({ err, segments: true, wasLive: true, ranMs: 146e3 }).action, 'down', err);
});

test('a failure that is not a refusal is retried even with no segments', () => {
  assert.equal(classifyExit({ err: 'Connection timed out' }).action, 'retry');
  assert.equal(classifyExit({}).action, 'retry');
});

// ---- channel lifecycle ----
test('the reported sequence: 403 then code 0 at 146 s restarts on the backoff', t => {
  timers(t);
  const ch = boot();
  ch.touch('123', 'u', true);
  segments(ch);
  t.mock.timers.tick(146e3);
  ch.touch('123', 'u', false);
  die(procs[0], FORBIDDEN, 0);
  assert.equal(state(ch).status, 'backoff');
  assert.equal(state(ch).reason, 'provider refused (403), retrying');
  t.mock.timers.tick(3999);
  assert.equal(procs.length, 1);
  t.mock.timers.tick(2100);
  assert.equal(procs.length, 2);
  assert.equal(state(ch).reason, undefined);
});

test('after a mid-stream 403, a provider that keeps refusing is bounded, then down with a reason', t => {
  timers(t);
  const ch = boot();
  ch.touch('123', 'u', true);
  segments(ch);
  die(procs[0], FORBIDDEN);
  for (const wait of [6100, 12100]) { // the first two retries, each refused before any segment
    t.mock.timers.tick(wait);
    die(procs.at(-1), REFUSED_AT_OPEN);
    assert.equal(state(ch).status, 'backoff');
  }
  t.mock.timers.tick(24100);
  assert.equal(procs.length, 4);
  die(procs[3], REFUSED_AT_OPEN);
  assert.equal(state(ch).status, 'down');
  assert.equal(state(ch).reason, 'provider kept refusing (403), gave up after 3 retries');
  t.mock.timers.tick(600e3);
  assert.equal(procs.length, 4);
});

test('down survives a server restart with its reason', t => {
  timers(t);
  let ch = boot();
  ch.touch('123', 'u', true);
  die(procs[0], REFUSED_AT_OPEN);
  ch = boot(JSON.parse(fs.readFileSync(path.join(cfg.DATA, 'state.json'), 'utf8')).selected);
  assert.equal(state(ch).status, 'down');
  assert.equal(state(ch).reason, 'provider refused (403) before the stream started');
});

test('viewer polling never wakes a down channel', t => {
  timers(t);
  const ch = boot();
  ch.touch('123', 'u', true);
  die(procs[0], REFUSED_AT_OPEN);
  t.mock.timers.tick(60e3);
  ch.touch('123', 'u', true);
  ch.keepalive('123', 'u');
  assert.equal(procs.length, 1);
  assert.equal(state(ch).status, 'down');
});

for (const how of ['select', 'retry']) {
  test(`${how} revives a down channel once the 30 s debounce has passed`, t => {
    timers(t);
    const ch = boot();
    ch.touch('123', 'u', true);
    die(procs[0], REFUSED_AT_OPEN);
    t.mock.timers.tick(31e3);
    ch[how]('123');
    assert.equal(procs.length, 2);
    assert.equal(state(ch).status, 'starting');
  });

  test(`${how} inside the debounce waits it out, however often it is asked`, t => {
    timers(t);
    const ch = boot();
    ch.touch('123', 'u', true);
    die(procs[0], REFUSED_AT_OPEN);
    t.mock.timers.tick(10e3);
    for (let i = 0; i < 5; i++) ch[how]('123');
    assert.equal(procs.length, 1);
    assert.equal(state(ch).status, 'backoff');
    assert.equal(state(ch).retryIn, 20);
    t.mock.timers.tick(19999);
    assert.equal(procs.length, 1);
    t.mock.timers.tick(2);
    assert.equal(procs.length, 2);
  });
}

test('a retried channel gets a fresh verdict: a new 403 before any segment is fatal again', t => {
  timers(t);
  const ch = boot();
  ch.touch('123', 'u', true);
  segments(ch);
  die(procs[0], FORBIDDEN);
  for (const wait of [6100, 12100, 24100]) { t.mock.timers.tick(wait); die(procs.at(-1), REFUSED_AT_OPEN); }
  assert.equal(state(ch).status, 'down');
  t.mock.timers.tick(31e3);
  ch.retry('123');
  die(procs[4], REFUSED_AT_OPEN);
  assert.equal(state(ch).status, 'down');
  assert.equal(state(ch).reason, 'provider refused (403) before the stream started');
});

test('retry of an unselected channel opens nothing', () => {
  const ch = boot();
  assert.equal(ch.retry('999'), null);
  assert.equal(procs.length, 0);
});

// ---- keepalive ----
test('keepalive extends the idle timer of a running channel', t => {
  timers(t);
  const ch = boot();
  ch.touch('123', 'u', true);
  t.mock.timers.tick(170e3);
  assert.equal(ch.keepalive('123', 'hb').viewers, 1);
  t.mock.timers.tick(30e3); // 200 s after the last touch, past the 180 s idle limit
  assert.ok(!procs[0].quit);
  t.mock.timers.tick(170e3);
  assert.ok(procs[0].quit);
});

test('keepalive never starts an idle channel', t => {
  timers(t);
  const ch = boot();
  const v = ch.keepalive('123', 'hb');
  assert.equal(v.status, 'idle');
  assert.equal(v.viewers, 0);
  t.mock.timers.tick(60e3);
  assert.equal(procs.length, 0);
  assert.equal(ch.keepalive('999', 'hb'), null);
});

test('keepalive during a backoff does not make the restart happen', t => {
  timers(t);
  const ch = boot();
  ch.setSettings({ idleSec: 30 });
  ch.touch('123', 'u', true);
  for (const wait of [6100, 12100, 24100]) { die(procs.at(-1), 'End of file'); t.mock.timers.tick(wait); }
  assert.equal(procs.length, 4);
  die(procs[3], 'End of file'); // fourth backoff is 32-48 s, longer than the 30 s idle limit
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(10e3); ch.keepalive('123', 'hb'); }
  assert.equal(state(ch).status, 'idle');
  assert.equal(procs.length, 4);
});
