'use strict';
// The live playlist writer, driven directly with a fake clock and fake segment files. No ffmpeg.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LivePlaylist, parseMedia, LIST, RETAIN, MAX_LAG_MS } = require('../src/playlist');

let tmp, list, now, A, B, slate;

// A fake ffmpeg output directory; push() adds a finished segment as ffmpeg would, deleting the ones outside its list.
function source(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  const s = {
    key: `${name}:1`, dir,
    push(dur = 1) {
      fs.writeFileSync(path.join(dir, `seg_${String(n).padStart(5, '0')}.ts`), `${name}-${n}`);
      n++;
      const first = Math.max(0, n - 6);
      fs.rmSync(path.join(dir, `seg_${String(first - 1).padStart(5, '0')}.ts`), { force: true });
      let t = `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${first}\n`;
      for (let i = first; i < n; i++) t += `#EXTINF:${dur.toFixed(6)},\nseg_${String(i).padStart(5, '0')}.ts\n`;
      fs.writeFileSync(path.join(dir, 'index.m3u8'), t);
    },
  };
  return s;
}
// One second of wall time, polled the way live.js does.
function second(src, sl = slate) { now += 1000; list.step(now, src, sl); }
function parse(text = list.render()) {
  const lines = text.trim().split('\n'), num = t => { const l = lines.find(x => x.startsWith(t)); return l ? +l.slice(t.length) : undefined; };
  const segs = []; let dsn = num('#EXT-X-DISCONTINUITY-SEQUENCE:'), disc = false, pdt, dur;
  for (const l of lines) {
    if (l === '#EXT-X-DISCONTINUITY') { disc = true; dsn++; }
    else if (l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pdt = Date.parse(l.slice(25));
    else if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8));
    else if (!l.startsWith('#')) { segs.push({ uri: l, disc, dsn, pdt, dur, seq: +l.match(/\d+/)[0] }); disc = false; pdt = undefined; }
  }
  return { seq: num('#EXT-X-MEDIA-SEQUENCE:'), dseq: num('#EXT-X-DISCONTINUITY-SEQUENCE:'), target: num('#EXT-X-TARGETDURATION:'), segs, text };
}
const body = uri => fs.readFileSync(list.file(+uri.match(/\d+/)[0]), 'utf8');
// PDT + EXTINF of each listed segment is the next one's PDT, read from the playlist text and to the ms.
function assertContinuous(segs) {
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i].pdt, segs[i - 1].pdt + Math.round(segs[i - 1].dur * 1000), `seq ${segs[i].seq}`);
}
// Runs a scenario, collecting every segment ever listed, so a check also covers what scrolled off between looks.
function collector() {
  const all = new Map();
  return { look() { for (const s of parse().segs) { const had = all.get(s.seq); if (had) assert.deepEqual(s, had); all.set(s.seq, s); } }, get segs() { return [...all.values()].sort((a, b) => a.seq - b.seq); } };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-live-test-'));
  fs.mkdirSync(path.join(tmp, 'live'));
  now = Date.UTC(2026, 10, 4);
  list = new LivePlaylist({ dir: path.join(tmp, 'live'), now, buffer: 0 });
  A = source('a'); B = source('b');
  const files = [0, 1, 2, 3].map(i => { const file = path.join(tmp, `slate${i}.ts`); fs.writeFileSync(file, `slate-${i}`); return { file, dur: 1 }; });
  slate = { key: 'slate:720', list: files };
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('parseMedia reads ffmpeg playlists, CRLF included', () => {
  assert.deepEqual(parseMedia('#EXTM3U\r\n#EXT-X-PROGRAM-DATE-TIME:x\r\n#EXTINF:1.001000,\r\nseg_00012.ts\r\n#EXTINF:0.5,\r\nsub/seg_13.ts\r\n'),
    [{ num: 12, uri: 'seg_00012.ts', dur: 1.001 }, { num: 13, uri: 'sub/seg_13.ts', dur: 0.5 }]);
});

test('no slate and no source: no playlist yet, rather than an invalid one', () => {
  list.step(now, null, null);
  assert.equal(list.render(), null);
});


test('eight entries and stable target duration', () => {
 list.step(now,null,slate); assert.equal(parse().segs.length,8); assert.equal(parse().target,2);
 for(let i=0;i<20;i++) second(null); assert.equal(parse().target,2);
});
test('re-anchor in either direction only on source change', () => {
 for(const drift of [-55000,55000]) {
 list.step(now,null,slate); list.end=now+drift;
 const dsn=list.dsn; A.push(2); list.step(now,A,slate);
 assert.equal(list.end,now); assert.equal(list.entries.at(-1).pdt,now-2000); assert.equal(list.dsn,dsn+1);
 now+=2000; A.push(2); list.step(now,A,slate); assert.equal(list.entries.at(-1).pdt,now-2000); assert.equal(list.dsn,dsn+1);
 now+=6000; list.step(now,null,slate);
 }
});
test('jitter and fresh input after a pause do not trigger slate; threshold is five seconds', () => {
 A.push(2); list.step(now,A,slate); const dsn=list.dsn,seq=list.seq;
 now+=4999; list.step(now,A,slate); assert.equal(list.seq,seq);
 A.push(2); list.step(now,A,slate); assert.equal(list.onSlate,false); assert.equal(list.dsn,dsn);
 now+=4999; list.step(now,A,slate); assert.equal(list.onSlate,false);
 now++; list.step(now,A,slate); assert.equal(list.onSlate,true); assert.equal(list.dsn,dsn+1);
});
test('startup bursts are paced with continuous PDT', () => {
 A.push(2); list.step(now,A,slate); const start=list.seq,dsn=list.dsn;
 for(let i=0;i<5;i++) A.push(2);
 for(let i=0;i<40;i++) {now+=250;list.step(now,A,null);assert.ok(list.end<=now+250);}
 assert.equal(list.seq,start+5); assert.equal(list.dsn,dsn); assertContinuous(parse().segs);
});
test('thirty seconds retention after leaving playlist survives source deletion', () => {
 A.push(2);list.step(now,A,slate); const seq=list.entries.at(-1).seq,file=list.file(seq);
 for(let i=0;i<8;i++){now+=2000;A.push(2);list.step(now,A,slate);}
 const left=now;fs.rmSync(A.dir,{recursive:true,force:true});
 now=left+RETAIN;list.step(now,null,slate);assert.ok(list.file(seq));assert.ok(fs.existsSync(file));
 now++;list.step(now,null,slate);assert.equal(list.file(seq),null);assert.ok(!fs.existsSync(file));
});
test('slate loops do not invent discontinuities',()=>{
 list.step(now,null,slate);const dsn=list.dsn;for(let i=0;i<100;i++)second(null);assert.equal(list.dsn,dsn);
});
test('same channel restart inserts exactly one discontinuity',()=>{
 A.push(2);list.step(now,A,slate);const dsn=list.dsn;now+=2000;A.key='a:2';A.push(2);list.step(now,A,slate);assert.equal(list.dsn,dsn+1);
});

test('a discontinuity sequence number never changes for a segment, also as tags scroll off', () => {
  const seen = new Map();
  const check = () => {
    const p = parse();
    for (const s of p.segs) { if (seen.has(s.seq)) assert.equal(s.dsn, seen.get(s.seq), `seq ${s.seq}`); seen.set(s.seq, s.dsn); }
  };
  list.step(now, null, slate); check();
  const c = source('c');
  A.push(); second(A); check();
  second(null); check();
  c.push(); second(c); check();
  for (let i = 0; i < 12; i++) { c.push(); second(c); check(); }
  // The tag has left the list, and DISCONTINUITY-SEQUENCE has taken it over.
  const p = parse();
  assert.ok(p.segs.every(s => !s.disc));
  assert.equal(p.dseq, list.dsn);
});


test('a tag on the first listed segment is rendered, not yet counted in DISCONTINUITY-SEQUENCE', () => {
  list.step(now, null, slate);
  const before = list.dsn;
  A.push(); second(A);
  for (let i = 0; i < LIST - 1; i++) { A.push(); second(A); }
  const p = parse();
  assert.equal(p.segs[0].disc, true);
  assert.equal(p.dseq, before);
  assert.equal(p.segs[0].dsn, before + 1);
});


test('ffmpeg deleting its older segments does not disturb ingest', () => {
  list.step(now, null, slate);
  for (let i = 0; i < 20; i++) { A.push(); second(A); }
  assert.equal(list.entries.filter(e => e.owned).length, 20);
  assert.equal(list.dsn - parse().dseq, 0);
});


test('joining a source that is already running takes its newest segment, not its whole list', () => {
  list.step(now, null, slate);
  for (let i = 0; i < 6; i++) A.push();
  const seq = list.seq, end = list.end;
  second(A);
  assert.equal(list.seq, seq + 1);
  assert.equal(list.end, end + 1000);
  assert.equal(body(parse().segs.at(-1).uri), 'a-5');
  A.push(); second(A);
  assert.equal(body(parse().segs.at(-1).uri), 'a-6');
});


test('segment URIs stay relative and seg_<digits>.ts, whatever the source calls them', () => {
  list.step(now, null, slate);
  A.push(); second(A); second(null); second(null);
  for (const s of parse().segs) assert.match(s.uri, /^seg_\d+\.ts$/);
});


test('numbers keep rising across a restart', () => {
  const later = new LivePlaylist({ dir: list.dir, now: now + 5000 });
  for (let i = 0; i < 3; i++) second(null);
  assert.ok(later.seq > list.seq - LIST - 1);
  assert.ok(later.seq < 2 ** 31 && later.dsn < 2 ** 31, 'fits a player that keeps these in 32 bits');
  assert.ok(new LivePlaylist({ dir: list.dir, now: now + 3600e3 }).seq > list.seq + 3600);
});

test('slate TS retiming advances video/audio PTS, DTS, PCR and packet counters across wraps', () => {
 const {retime}=require('../src/slate-ts');
 const decode=(b,i)=>(b[i]>>1&7)*2**30+b[i+1]*2**22+(b[i+2]>>1)*2**15+b[i+3]*128+(b[i+4]>>1);
 for(const id of [0xe0,0xc0]){
  const b=Buffer.alloc(188,255);b.set([0x47,0x41,0,0x30,7,0x10,0,0,0,0,0x7e,0]);
  b.set([0,0,1,id,0,0,0x80,0xc0,10,0x31,0,1,0,1,0x11,0,1,0,1],12);
  const counters=new Map(),a=retime(b,180000,counters),c=retime(b,2**33+180000,counters);
  assert.equal(decode(a,21),180000);assert.equal(decode(a,26),180000);
  const pcr=a[6]*2**25+a[7]*2**17+a[8]*512+a[9]*2+(a[10]>>7);
  assert.equal(pcr,180000);assert.equal(a[3]&15,0);assert.equal(c[3]&15,1);
  assert.equal(decode(c,21),180000);assert.equal(decode(b,21),0);
 }
});
test('queued channel segments survive a directory deletion during switching',()=>{
 list.buffer=2; for(let i=0;i<3;i++){A.push(2);now+=2000;list.step(now,A,slate);}
 assert.equal(list.pending.length,2); const dsn=list.dsn;
 fs.rmSync(A.dir,{recursive:true,force:true});
 now+=2000;list.step(now,null,slate); assert.equal(list.dsn,dsn); assert.equal(list.onSlate,false);
 now+=2000;list.step(now,null,slate); assert.equal(list.dsn,dsn);assert.equal(list.pending.length,0);
 for(let i=0;i<3;i++)B.push(2);now+=1000;list.step(now,B,slate);assert.equal(list.dsn,dsn+1);
});
