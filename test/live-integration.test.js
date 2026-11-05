'use strict';
// Two channel switches through the real server and real ffmpeg on local test patterns (see fixture-live.js), on a temp port.
// A client polls the constant playlist the whole time, as a player would. Takes about 40 s.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { cfg } = require('../src/config');

const FFPROBE = path.join(path.dirname(cfg.FFMPEG), 'ffprobe' + path.extname(cfg.FFMPEG));
const skip = spawnSync(cfg.FFMPEG, ['-hide_banner', '-version']).status === 0 ? false : 'ffmpeg not available';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-live-int-'));
const SECRET = 'live-test-secret-live-test-secret-012345';
const sleep = ms => new Promise(ok => setTimeout(ok, ms));
let base, proc;

function jwt(roles, sub = 'u1') {
  const b = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ sub, roles, exp: Math.floor(Date.now() / 1000) + 600 })}`;
  return `${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`;
}
const Cookie = `msv_session=${jwt(['tv-admin'])}`;
// Synchronous ffprobe checks can outlast the server's HTTP keepalive timeout.
// Do not leave pooled sockets to expire while the test's event loop is blocked.
const get = (p, o = {}) => fetch(base + p, { ...o, headers: { Cookie, Connection: 'close' } });
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { Cookie, Connection: 'close', 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const status = async () => (await get('/api/status')).json();

function parse(text) {
  const lines = text.trim().split('\n'), head = t => +lines.find(l => l.startsWith(t)).slice(t.length);
  const seq0 = head('#EXT-X-MEDIA-SEQUENCE:'), dseq = head('#EXT-X-DISCONTINUITY-SEQUENCE:');
  const segs = []; let dsn = dseq, disc = false, pdt, dur;
  for (const l of lines) {
    if (l === '#EXT-X-DISCONTINUITY') { disc = true; dsn++; }
    else if (l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pdt = Date.parse(l.slice(25));
    else if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8));
    else if (!l.startsWith('#')) { segs.push({ seq: seq0 + segs.length, uri: l, dsn, disc, pdt, dur }); disc = false; pdt = undefined; }
  }
  return { seq0, dseq, segs };
}

// Records every playlist version the client sees until stopped, and fetches each segment when first listed, as a player would.
function watcher(rendition) {
  const seen = new Map(), bad = [];
  const w = { seen, bad, polls: 0, stop: false, last: null, offset: 0 };
  w.done = (async () => {
    while (!w.stop) {
      const r = await get(`/hls/live/${rendition}/index.m3u8`);
      if (r.status !== 200) { bad.push(`playlist ${r.status}`); await sleep(200); continue; }
      const p = parse(await r.text());
      w.polls++;
      if (w.last) {
        if (p.seq0 < w.last.seq0) bad.push(`media sequence went back ${w.last.seq0} -> ${p.seq0}`);
        if (p.dseq < w.last.dseq) bad.push(`discontinuity sequence went back ${w.last.dseq} -> ${p.dseq}`);
      }
      for (const s of p.segs) {
        const had = seen.get(s.seq);
        if (had && (had.dsn !== s.dsn || had.uri !== s.uri || had.pdt !== s.pdt)) bad.push(`segment ${s.seq} changed: ${JSON.stringify([had, s])}`);
        if (!Number.isFinite(s.pdt)) bad.push(`segment ${s.seq} has no PDT`);
        if (!had) {
          seen.set(s.seq, s);
          const seg = await get(`/hls/live/${rendition}/${s.uri}`);
          if (seg.status === 200) s.data = Buffer.from(await seg.arrayBuffer()); else bad.push(`segment ${s.seq}: ${seg.status}`);
        }
      }
      // Clock drift concerns the live edge, not older entries in the initial window.
      const edge = p.segs.at(-1);
      w.offset = Math.max(w.offset, Math.abs(Date.now() - (edge.pdt + edge.dur * 1000)));
      w.last = p;
      await sleep(150);
    }
  })();
  return w;
}
// Every source has its own video size: 640x270 and 480x270 test patterns, 1280x720 slate.
function probe(data) {
  const f = path.join(root, `probe-${crypto.randomUUID()}.ts`);
  fs.writeFileSync(f, data);
  const r = JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,width,height,pix_fmt,sample_rate,channels', '-of', 'json', f], { encoding: 'utf8' }).stdout);
  fs.rmSync(f);
  return { v: r.streams.find(s => s.codec_type === 'video'), a: r.streams.find(s => s.codec_type === 'audio') };
}
// The video width of each run of segments from one source, checking that a tag sits on every boundary and nowhere else.
function sources(segs) {
  const out = [];
  for (const [i, s] of segs.entries()) {
    const width = probe(s.data).v.width;
    if (i) assert.equal(s.disc, width !== out.at(-1), `segment ${s.seq}: width ${width} after ${out.at(-1)}, tag ${s.disc}`);
    if (width !== out.at(-1)) out.push(width);
  }
  return out;
}
async function waitFor(what, f, ms = 30e3) {
  for (const t = Date.now(); Date.now() - t < ms; await sleep(100)) { const v = await f(); if (v) return v; }
  throw new Error(`timed out waiting for ${what}`);
}
const running = id => waitFor(`${id} on air`, async () => { const s = await status(); return s.live && s.live.id === id && s.channels.find(c => c.id === id).ready; });

// Reads SSE state events in the background.
function events() {
  const got = [], ctl = new AbortController();
  (async () => {
    const r = await get('/api/events', { signal: ctl.signal }), dec = new TextDecoder();
    let buf = '';
    for await (const c of r.body) {
      buf += dec.decode(c, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const b = buf.slice(0, i); buf = buf.slice(i + 2);
        if (b.startsWith('event: state')) got.push(JSON.parse(b.split('\n')[1].slice(6)));
      }
    }
  })().catch(() => {});
  return { got, stop: () => ctl.abort() };
}

before(async () => {
  if (skip) return;
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'jwt'), SECRET);
  fs.writeFileSync(path.join(root, 'data', 'state.json'), JSON.stringify({ selected: [{ id: '1', name: 'Channel 1' }] }));
  const port = await new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => ok(n)); }); });
  base = `http://127.0.0.1:${port}/tv`;
  proc = spawn(process.execPath, [path.join(__dirname, 'fixture-live.js')], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, TEST_ROOT: root, HOST: '127.0.0.1', PORT: String(port), BASE_PATH: '/tv', EPG_AUTO: '0', DEV_AUTH: '0' },
  });
  await new Promise((ok, bad) => {
    proc.stdout.on('data', d => { if (/listening on/.test(d)) ok(); });
    proc.once('exit', c => bad(new Error(`server exited ${c}`)));
  });
});
after(async () => {
  // Killing the server would orphan a running ffmpeg, so stop the channels first, whatever the test got up to.
  if (proc) {
    for (const id of ['1', '2']) await post('/api/stop', { id }).catch(() => {});
    proc.removeAllListeners('exit'); proc.kill();
    await new Promise(ok => proc.once('exit', ok));
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('two channel switches: one continuous stream, exact discontinuities, old segments still served', { skip, timeout: 120e3 }, async () => {
  await waitFor('slate', async () => (await get('/hls/live/phone/index.m3u8')).status === 200);

  // Before anything plays: pure slate, on both renditions, and it matches the channel encodes.
  const slate = parse(await (await get('/hls/live/phone/index.m3u8')).text());
  const sp = probe(Buffer.from(await (await get(`/hls/live/phone/${slate.segs[0].uri}`)).arrayBuffer()));
  assert.deepEqual([sp.v.codec_name, sp.v.width, sp.v.height, sp.v.pix_fmt, sp.a.codec_name, sp.a.sample_rate, sp.a.channels], ['h264', 1280, 720, 'yuv420p', 'aac', '48000', 2]);
  await waitFor('tv slate', async () => (await get('/hls/live/tv/index.m3u8')).status === 200);
  const tvSlate = parse(await (await get('/hls/live/tv/index.m3u8')).text());
  const tp = probe(Buffer.from(await (await get(`/hls/live/tv/${tvSlate.segs[0].uri}`)).arrayBuffer()));
  assert.deepEqual([tp.v.width, tp.v.height, tp.a.codec_name], [1920, 1080, 'aac']);

  const ev = events(), w = watcher('phone'), tv = watcher('tv');
  await sleep(1500);
  const startDsn = w.last.segs.at(-1).dsn;

  await (await post('/api/select', { id: '1' })).json();
  await running('1');
  await waitFor('segments of 1', () => w.seen.size > 12);
  await sleep(4000);

  // Nobody in particular is watching: a playlist poll is no viewer, a segment fetch is. A separate user, so the watcher above does not count.
  const poller = { Cookie: `msv_session=${jwt(['tv'], 'poller')}`, Connection: 'close' }, viewers = async () => (await status()).channels[0].viewers;
  const had = await viewers();
  for (let i = 0; i < 3; i++) assert.equal((await fetch(`${base}/hls/live/phone/index.m3u8`, { headers: poller })).status, 200);
  assert.equal(await viewers(), had, 'playlist polls are not viewer activity');
  assert.equal((await fetch(`${base}/hls/live/phone/${w.last.segs.at(-1).uri}`, { headers: poller })).status, 200);
  assert.equal(await viewers(), had + 1, 'a segment fetch is');

  // Switch 1. Remember what the client was last told, to fetch it after the old channel's directory is gone.
  const before = w.last.segs;
  assert.equal((await post('/api/replace', { old: '1', id: '2' })).status, 200);
  assert.equal(fs.existsSync(path.join(root, 'hls', '1')), false, 'old channel directory is gone');
  for (const s of before) {
    const r = await get(`/hls/live/phone/${s.uri}`);
    assert.equal(r.status, 200, `${s.uri} after the switch`);
    assert.ok((await r.arrayBuffer()).byteLength > 0);
  }
  await running('2');
  await sleep(5000);

  // Per-channel paths work beside the live ones.
  const own = await get('/hls/2/index.m3u8');
  assert.equal(own.status, 200);
  assert.match(await own.text(), /#EXT-X-PROGRAM-DATE-TIME/);

  // Switch 2, back to the first channel.
  assert.equal((await post('/api/replace', { old: '2', id: '1' })).status, 200);
  await running('1');
  await sleep(5000);
  w.stop = tv.stop = true;
  await Promise.all([w.done, tv.done]);
  ev.stop();
  assert.deepEqual(w.bad, []);
  assert.deepEqual(tv.bad, []);

  // Walk the whole stream: no holes in the sequence, and a discontinuity exactly where the source changes.
  const all = [...w.seen.values()].sort((a, b) => a.seq - b.seq);
  for (let i = 1; i < all.length; i++) assert.equal(all[i].seq, all[i - 1].seq + 1);
  for (let i = 1; i < all.length; i++) assert.equal(all[i].pdt, all[i - 1].pdt + Math.round(all[i - 1].dur * 1000), `PDT at segment ${all[i].seq}`);
  assert.ok(w.offset < 4000, `PDT strayed ${w.offset} ms from the clock`);
  const stretches = sources(all);
  // Slate between channels shows only if the old channel's last segment runs out before the new one's first exists.
  assert.deepEqual(stretches.filter(x => x !== 1280), [640, 480, 640], `sources: ${stretches}`);
  assert.equal(stretches[0], 1280);
  assert.ok(stretches.length >= 4);
  const discs = all.filter(s => s.disc).length;
  assert.equal(discs, stretches.length - 1, `sources: ${stretches}`);
  assert.equal(all.at(-1).dsn - startDsn, discs);
  const lastRun = all.filter(s => s.dsn === all.at(-1).dsn).reduce((n, s) => n + s.dur, 0);
  assert.ok(lastRun >= 4, `the last stretch has ${lastRun} s`);

  // The TV playlist makes the same changes. libx264 has no TV output, so it carries the phone segments.
  const tvAll = [...tv.seen.values()].sort((a, b) => a.seq - b.seq);
  for (let i = 1; i < tvAll.length; i++) assert.equal(tvAll[i].pdt, tvAll[i - 1].pdt + Math.round(tvAll[i - 1].dur * 1000), `TV PDT at segment ${tvAll[i].seq}`);
  assert.deepEqual(sources(tvAll).filter(x => x !== 1920), [640, 480, 640]);
  assert.equal(tvAll.filter(s => s.disc).length, sources(tvAll).length - 1);

  // SSE told the client about each change of channel, and about the slate.
  const ids = ev.got.map(e => e.live && e.live.id).filter((x, i, a) => x !== a[i - 1]);
  assert.deepEqual(ids, ['1', '2', '1']);
  assert.ok(ev.got.some(e => e.live.slate) && ev.got.some(e => !e.live.slate));
  assert.equal(ev.got.at(-1).live.slate, false);
  assert.equal(ev.got.at(-1).channels[0].status, 'running');

  // Leaves nothing running behind.
  await post('/api/stop', { id: '1' });
  await sleep(300);
  assert.equal((await status()).live, null);
});
