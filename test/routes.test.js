'use strict';
// /hls routes against the real server. Runs on a random loopback port from a temp root (see fixture-server.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-route-test-'));
const SECRET = 'route-test-secret-route-test-secret-0123';
const ID = '123';
let base, proc;

function jwt(payload, secret = SECRET) {
  const b = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 300, ...payload })}`;
  return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
}
const get = (p, token) => fetch(base + p, { headers: token ? { Cookie: `msv_session=${token}` } : {}, redirect: 'manual' });
const tvUser = jwt({ roles: ['tv'] });

before(async () => {
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'jwt'), SECRET);
  fs.writeFileSync(path.join(root, 'data', 'state.json'), JSON.stringify({ selected: [{ id: ID, name: 'Test' }] }));
  const port = await new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => ok(n)); }); });
  base = `http://127.0.0.1:${port}/tv`;
  proc = spawn(process.execPath, [path.join(__dirname, 'fixture-server.js')], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, TEST_ROOT: root, HOST: '127.0.0.1', PORT: String(port), BASE_PATH: '/tv', EPG_AUTO: '0', DEV_AUTH: '0' },
  });
  await new Promise((ok, bad) => {
    proc.stdout.on('data', d => { if (/listening on/.test(d)) ok(); });
    proc.once('exit', c => bad(new Error(`server exited ${c}`)));
  });
  // After listen: init() has already cleared the HLS dir.
  const d = path.join(root, 'hls', ID);
  fs.mkdirSync(path.join(d, 'tv'), { recursive: true });
  for (const [f, s] of [['index.m3u8', '#EXTM3U phone'], ['seg_00001.ts', 'phone-seg'], ['tv/index.m3u8', '#EXTM3U tv'], ['tv/seg_00001.ts', 'tv-seg'], ['tv/notes.txt', 'x']])
    fs.writeFileSync(path.join(d, f), s);
});
after(() => { proc.removeAllListeners('exit'); proc.kill(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

test('TV playlist and segment are served, with the same headers as phone', async () => {
  for (const f of ['index.m3u8', 'seg_00001.ts']) {
    const phone = await get(`/hls/${ID}/${f}`, tvUser), tv = await get(`/hls/${ID}/tv/${f}`, tvUser);
    assert.equal(tv.status, 200);
    for (const h of ['content-type', 'cache-control', 'x-content-type-options']) assert.equal(tv.headers.get(h), phone.headers.get(h), h);
  }
  assert.equal(await (await get(`/hls/${ID}/tv/index.m3u8`, tvUser)).text(), '#EXTM3U tv');
  assert.equal(await (await get(`/hls/${ID}/index.m3u8`, tvUser)).text(), '#EXTM3U phone');
  assert.equal((await get(`/hls/${ID}/tv/index.m3u8`, tvUser)).headers.get('cache-control'), 'no-store');
  assert.equal((await get(`/hls/${ID}/tv/seg_00001.ts`, tvUser)).headers.get('cache-control'), 'private, max-age=60');
});

test('TV routes use the same JWT auth', async () => {
  for (const f of ['tv/index.m3u8', 'tv/seg_00001.ts']) {
    assert.equal((await get(`/hls/${ID}/${f}`)).status, 401);
    assert.equal((await get(`/hls/${ID}/${f}`, jwt({ roles: ['tv'] }, 'x'.repeat(40)))).status, 401);
    assert.equal((await get(`/hls/${ID}/${f}`, jwt({ roles: ['tv'], exp: 1 }))).status, 401);
    assert.equal((await get(`/hls/${ID}/${f}`, jwt({ roles: ['nas'] }))).status, 403);
  }
});

test('only playlist and segment names resolve under tv/', async () => {
  // Paths the route rejects fall through to the admin gate, so a tv user gets 403 and an admin 404.
  const admin = jwt({ roles: ['tv-admin'] });
  for (const f of ['notes.txt', 'tv/index.m3u8', '..%2f..%2f..%2fjwt']) {
    assert.equal((await get(`/hls/${ID}/tv/${f}`, tvUser)).status, 403, f);
    assert.equal((await get(`/hls/${ID}/tv/${f}`, admin)).status, 404, f);
  }
  assert.equal((await get(`/hls/${ID}/tv/seg_99999.ts`, tvUser)).status, 404);
  assert.equal((await get('/hls/999/tv/index.m3u8', tvUser)).status, 404);
});

test('fetching the TV playlist counts as viewer activity', async () => {
  const viewers = async () => (await (await get('/api/status', jwt({ roles: ['tv'], sub: 'watcher' }))).json()).channels[0].viewers;
  const n = await viewers();
  await get(`/hls/${ID}/tv/index.m3u8`, jwt({ roles: ['tv'], sub: 'tv-box' }));
  assert.equal(await viewers(), n + 1);
});

const post = (p, token = tvUser) => fetch(base + p, { method: 'POST', headers: { Cookie: `msv_session=${token}`, 'Content-Type': 'application/json' }, body: '{}' });

test('keepalive on a stopped channel starts nothing and counts no viewer', async () => {
  const status = async () => (await (await get('/api/status', tvUser)).json()).channels[0];
  const was = await status();
  const r = await post(`/api/watch/${ID}?keepalive=1`, jwt({ roles: ['tv'], sub: 'heartbeat' }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'idle');
  const now = await status();
  assert.equal(now.status, 'idle');
  assert.equal(now.viewers, was.viewers);
  assert.equal((await post('/api/watch/999?keepalive=1')).status, 404);
});

test('retry leaves a channel that is not down alone', async () => {
  const r = await post(`/api/retry/${ID}`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'idle');
  assert.equal((await post('/api/retry/999')).status, 404);
});
