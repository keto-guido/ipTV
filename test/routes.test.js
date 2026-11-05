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
const SLATE_BYTES = 'slate-bytes';
const tvUser = jwt({ roles: ['tv'] });

before(async () => {
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'jwt'), SECRET);
  fs.writeFileSync(path.join(root, 'data', 'state.json'), JSON.stringify({ selected: [{ id: ID, name: 'Test' }] }));
  // A ready-made slate: this fixture has no ffmpeg to generate one.
  for (const h of [720, 1080]) {
    const d = path.join(root, 'data', 'slate', `v2-${h}p`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 's_000.ts'), SLATE_BYTES);
    fs.writeFileSync(path.join(d, 'index.m3u8'), '#EXTM3U\n#EXTINF:1.000000,\ns_000.ts\n#EXT-X-ENDLIST\n');
  }
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

test('legacy playlists redirect to constant live URLs; channel segments remain fetchable', async () => {
 for(const r of ['', 'tv/']){
  const res=await get('/hls/'+ID+'/'+r+'index.m3u8',tvUser);
  assert.equal(res.status,307);assert.equal(res.headers.get('location'),'/tv/hls/live/'+(r?'tv':'phone')+'/index.m3u8');
  assert.equal(res.headers.get('cache-control'),'no-store');
  const seg=await get('/hls/'+ID+'/'+r+'seg_00001.ts',tvUser);assert.equal(seg.status,200);assert.equal(seg.headers.get('cache-control'),'private, max-age=60');
 }
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

test('fetching a legacy playlist does not start a stream or count a viewer', async () => {
  const viewers = async () => (await (await get('/api/status', jwt({ roles: ['tv'], sub: 'watcher' }))).json()).channels[0].viewers;
  const n = await viewers();
  await get(`/hls/${ID}/tv/index.m3u8`, jwt({ roles: ['tv'], sub: 'tv-box' }));
  assert.equal(await viewers(), n);
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

// ---- live playlists ----
const firstSeg = text => text.split('\n').find(l => l.startsWith('seg_'));

test('live playlists are served with no cache, as HLS, on slate while nothing plays', async () => {
  for (const r of ['phone', 'tv']) {
    const res = await get(`/hls/live/${r}/index.m3u8`, tvUser), text = await res.text();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/vnd.apple.mpegurl');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(text, /^#EXTM3U\n/);
    const seg = await get(`/hls/live/${r}/${firstSeg(text)}`, tvUser);
    assert.equal(seg.status, 200);
    assert.equal(seg.headers.get('content-type'), 'video/mp2t');
    assert.equal(seg.headers.get('cache-control'), 'private, max-age=60');
    assert.equal(await seg.text(), SLATE_BYTES);
  }
});

test('live playlists and segments use the same JWT auth', async () => {
  const seg = firstSeg(await (await get('/hls/live/phone/index.m3u8', tvUser)).text());
  for (const f of ['phone/index.m3u8', `phone/${seg}`, 'tv/index.m3u8', `tv/${seg}`]) {
    assert.equal((await get(`/hls/live/${f}`)).status, 401, f);
    assert.equal((await get(`/hls/live/${f}`, jwt({ roles: ['tv'] }, 'x'.repeat(40)))).status, 401, f);
    assert.equal((await get(`/hls/live/${f}`, jwt({ roles: ['tv'], exp: 1 }))).status, 401, f);
    assert.equal((await get(`/hls/live/${f}`, jwt({ roles: ['nas'] }))).status, 403, f);
  }
});

test('only listed live segments resolve', async () => {
  const admin = jwt({ roles: ['tv-admin'] });
  assert.equal((await get('/hls/live/phone/seg_1.ts', tvUser)).status, 404);
  for (const f of ['phone/notes.txt', 'radio/index.m3u8', 'phone/..%2f..%2f..%2fjwt', 'tv/seg_1234567890123456.ts'])
    assert.equal((await get(`/hls/live/${f}`, admin)).status, 404, f);
});

test('live requests on a stopped channel change nothing: no activity, no start', async () => {
  // Fresh activity is what lets the channel loop start a wanted channel, so even a segment must leave it alone.
  const status = async () => (await (await get('/api/status', jwt({ roles: ['tv'], sub: 'watcher' }))).json());
  const was = await status(), who = jwt({ roles: ['tv'], sub: 'live-viewer' });
  assert.deepEqual(was.live, { id: ID, name: 'Test' });
  const text = await (await get('/hls/live/phone/index.m3u8', who)).text();
  assert.equal((await get(`/hls/live/phone/${firstSeg(text)}`, who)).status, 200);
  const now = await status();
  assert.equal(now.channels[0].viewers, was.channels[0].viewers);
  assert.equal(now.channels[0].status, 'idle');
});

// ---- events ----
async function firstEvent(r) {
  const dec = new TextDecoder(); let buf = '';
  for await (const c of r.body) {
    buf += dec.decode(c, { stream: true });
    const m = buf.match(/event: state\ndata: (.*)\n\n/);
    if (m) return JSON.parse(m[1]);
  }
}

test('/api/events: same auth as the rest, cookie only', async () => {
  assert.equal((await get('/api/events')).status, 401);
  assert.equal((await get(`/api/events?token=${tvUser}`)).status, 401);
  assert.equal((await get('/api/events', jwt({ roles: ['tv'], exp: 1 }))).status, 401);
  assert.equal((await get('/api/events', jwt({ roles: ['nas'] }))).status, 403);
});

test('/api/events opens with the current state, without leaking anything upstream', async () => {
  const ctl = new AbortController();
  const r = await fetch(`${base}/api/events`, { headers: { Cookie: `msv_session=${tvUser}` }, signal: ctl.signal });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/event-stream');
  const s = await firstEvent(r);
  ctl.abort();
  assert.deepEqual(s.live, { id: ID, name: 'Test', slate: true });
  assert.equal(s.channels[0].status, 'idle');
  assert.deepEqual(Object.keys(s.channels[0]).sort(), ['id', 'name', 'ready', 'status', 'tv']); // reason is dropped while undefined
});

test('/api/events ends when the JWT expires', async () => {
  const exp = Math.floor(Date.now() / 1000) + 2;
  const r = await get('/api/events', jwt({ roles: ['tv'], sub: 'short', exp }));
  assert.equal(r.status, 200);
  await r.text(); // returns only when the server closes the stream
  assert.ok(Date.now() / 1000 >= exp - 0.1);
});
