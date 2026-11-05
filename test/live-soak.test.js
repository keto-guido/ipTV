'use strict';
// Three-minute opt-in loopback lavfi soak through the real channel/live pipeline.
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

function probe(data) {
  const f = path.join(root, `probe-${crypto.randomUUID()}.ts`);
  fs.writeFileSync(f, data);
  const r = JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,width,height,pix_fmt,sample_rate,channels', '-of', 'json', f], { encoding: 'utf8' }).stdout);
  fs.rmSync(f);
  return { v: r.streams.find(s => s.codec_type === 'video'), a: r.streams.find(s => s.codec_type === 'audio') };
}
async function waitFor(what, f, ms = 30e3) {
  for (const t = Date.now(); Date.now() - t < ms; await sleep(100)) { const v = await f(); if (v) return v; }
  throw new Error(`timed out waiting for ${what}`);
}
const running = id => waitFor(`${id} on air`, async () => { const s = await status(); return s.live && s.live.id === id && s.channels.find(c => c.id === id).ready; });

before(async () => {
  if (skip || process.env.IPTV_SOAK !== '1') return;
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


test('three minute lavfi soak: real channel/live pipeline', {skip: process.env.IPTV_SOAK !== '1' ? 'set IPTV_SOAK=1' : skip, timeout:240000}, async()=>{
 await post('/api/select',{id:'1'}); await running('1');
 await waitFor('live source',async()=>{const r=await get('/hls/live/phone/index.m3u8');if(r.status!==200)return false;const p=parse(await r.text());const edge=p.segs.at(-1),f=await get('/hls/live/phone/'+edge.uri);return f.status===200&&probe(Buffer.from(await f.arrayBuffer())).v.width===640;});
 const start=Date.now(), seen=new Map(), retired=new Map(), targets=new Set();let last=-1,polls=0,fetches=0,maxDrift=0,maxPublicationDrift=0,stalePolls=0,switched=false,initialDsn,finalDsn;
 while(Date.now()-start<185000){
  const r=await get('/hls/live/phone/index.m3u8');assert.equal(r.status,200);
  const text=await r.text(),p=parse(text),time=Date.now();polls++;
  targets.add(+text.match(/#EXT-X-TARGETDURATION:(\d+)/)[1]);
  assert.ok(p.seq0>=last,'sequence never goes backwards');last=p.seq0;
  const active=new Set(p.segs.map(s=>s.seq));
  for(const [seq,s] of seen) if(!active.has(seq)&&!retired.has(seq))retired.set(seq,{s,at:time});
  for(const seg of p.segs){
   const had=seen.get(seg.seq);if(had)assert.deepEqual([seg.pdt,seg.dsn],[had.pdt,had.dsn]);else seen.set(seg.seq,seg);
   const f=await get('/hls/live/phone/'+seg.uri);assert.equal(f.status,200,'listed '+seg.uri);assert.ok((await f.arrayBuffer()).byteLength);fetches++;
  }
  for(const [seq,{s,at}] of retired){
   if(time-at<=30000){const f=await get('/hls/live/phone/'+s.uri);assert.equal(f.status,200,'retained '+s.uri);await f.arrayBuffer();fetches++;}
  }
  const edge=p.segs.at(-1);initialDsn??=edge.dsn;finalDsn=edge.dsn;
  const drift=Math.abs(time-edge.pdt-edge.dur*1000);maxDrift=Math.max(maxDrift,drift);
  if(drift>2500)stalePolls++;
  if(!seen.get(edge.seq).publishedAt){seen.get(edge.seq).publishedAt=time;maxPublicationDrift=Math.max(maxPublicationDrift,drift);}
  if(!switched&&time-start>65000){assert.equal((await post('/api/replace',{old:'1',id:'2'})).status,200);switched=true;}
  await sleep(Math.max(0,500-(Date.now()-time)));
 }
 console.log(JSON.stringify({durationMs:Date.now()-start,polls,segments:seen.size,segmentFetches:fetches,retentionChecks:'every poll through 30 seconds after leaving',discontinuities:finalDsn-initialDsn,maxEdgeDriftMs:maxDrift,maxPublicationDriftMs:maxPublicationDrift,stalePolls,targetDuration:[...targets]}));
 assert.equal(switched,true,'a channel switch occurred');
 const all=[...seen.values()].sort((a,b)=>a.seq-b.seq);
 for(let i=1;i<all.length;i++){
  assert.equal(all[i].seq,all[i-1].seq+1,'no sequence holes');
  if(!all[i].disc)assert.equal(all[i].pdt,all[i-1].pdt+Math.round(all[i-1].dur*1000),'PDT continuous within source');
 }
 assert.equal(finalDsn-initialDsn,1,'exactly one discontinuity per channel switch');assert.deepEqual([...targets],[2]);
 assert.ok(maxDrift<=2500,'PDT edge drift '+maxDrift+' ms across '+stalePolls+' polls');
});
