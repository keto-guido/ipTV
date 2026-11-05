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
  list = new LivePlaylist({ dir: path.join(tmp, 'live'), now });
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

test('first playlist is full, valid and PDT-stamped on slate alone', () => {
  list.step(now, null, { key: slate.key, list: Array(60).fill(slate.list[0]) });
  const p = parse();
  assert.equal(p.segs.length, LIST);
  assert.equal(p.target, 1);
  assert.ok(p.text.startsWith('#EXTM3U\n'));
  assert.ok(p.text.includes('#EXT-X-INDEPENDENT-SEGMENTS'));
  assert.ok(!p.text.includes('#EXT-X-ENDLIST'));
  assert.ok(p.segs.every(s => Number.isFinite(s.pdt)));
  assert.ok(p.segs.every(s => !s.disc));
  assert.equal(list.onSlate, true);
});

test('slate keeps the playlist moving in real time, with no discontinuity until the loop wraps', () => {
  list.step(now, null, slate);
  now += 1; list.step(now, null, slate); // the timeline has reached now, so the next segment is due
  const start = parse();
  now += 400; list.step(now, null, slate); // less than a segment later
  assert.equal(parse().seq, start.seq);
  for (let i = 0; i < 9; i++) second(null);
  const p = parse();
  assert.equal(p.seq, start.seq + 9);
  // 16 segments over a 4-file loop: wrapped three times.
  assert.equal(list.dsn - start.dseq, 3);
  assert.equal(p.segs.filter(s => s.disc).length, list.dsn - p.dseq);
  // Every wrap lands on the first slate file, and only there.
  for (const s of p.segs) assert.equal(s.disc, body(s.uri) === 'slate-0');
});

test('sequence continues across a source change, with a discontinuity on each change', () => {
  list.step(now, null, slate);
  const start = list.seq, dsn = list.dsn;
  A.push(); second(A); A.push(); second(A);          // slate -> a
  assert.equal(list.dsn, dsn + 1);
  second(null); second(null);                        // a -> slate
  assert.equal(list.dsn, dsn + 2);
  B.push(); second(B); B.push(); second(B);          // slate -> b
  assert.equal(list.dsn, dsn + 3);
  assert.equal(list.seq, start + 6);
  const p = parse();
  assert.deepEqual(p.segs.map(s => body(s.uri)).slice(-6), ['a-0', 'a-1', `slate-0`, `slate-1`, 'b-0', 'b-1']);
  assert.deepEqual(p.segs.slice(-6).map(s => s.disc), [true, false, true, false, true, false]);
  for (let i = 1; i < p.segs.length; i++) assert.equal(p.segs[i].seq, p.segs[i - 1].seq + 1);
  assert.equal(list.onSlate, false);
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

test('segments listed before a switch survive ffmpeg deleting its directory, until they age out', () => {
  list.step(now, null, slate);
  for (let i = 0; i < 3; i++) { A.push(); second(A); }
  const listed = parse().segs.filter(s => /^a-/.test(body(s.uri)));
  assert.equal(listed.length, 3);
  fs.rmSync(A.dir, { recursive: true, force: true }); // what clean() does on a switch
  for (const s of listed) assert.match(body(s.uri), /^a-/);
  // Still fetchable after leaving the playlist, then gone from disk and from lookup.
  const f = list.file(listed[0].seq);
  for (let i = 0; i < LIST + 1; i++) second(null);
  assert.ok(!parse().segs.some(s => s.seq === listed[0].seq));
  assert.equal(fs.readFileSync(list.file(listed[0].seq), 'utf8'), 'a-0');
  for (let i = 0; i < RETAIN; i++) second(null);
  assert.equal(list.file(listed[0].seq), null);
  assert.ok(!fs.existsSync(f));
  assert.ok(list.entries.length <= LIST + RETAIN);
  assert.deepEqual(fs.readdirSync(list.dir), []);
});

test('the slate files themselves are never deleted', () => {
  for (let i = 0; i < 60; i++) second(null);
  for (const s of slate.list) assert.ok(fs.existsSync(s.file));
});

test('ffmpeg deleting its older segments does not disturb ingest', () => {
  list.step(now, null, slate);
  for (let i = 0; i < 20; i++) { A.push(); second(A); }
  assert.equal(list.entries.filter(e => e.owned).length, 20);
  assert.equal(list.dsn - parse().dseq, 0);
});

test('a short pause between segments gets no slate', () => {
  list.step(now, null, slate);
  A.push(); second(A);
  const seq = list.seq;
  now += 1000; list.step(now, A, slate); // waiting, under the stall limit
  assert.equal(list.seq, seq);
});

test('a stalled source gets slate, and coming back counts as a change', () => {
  // Isolate source changes from the separate, intentional slate-loop tags.
  slate = { ...slate, list: Array(60).fill(slate.list[0]) };
  list.step(now, null, slate);
  A.push(); second(A);
  const dsn = list.dsn, seq = list.seq;
  for (let t = 0; t < 6000; t += 250) { now += 250; list.step(now, A, slate); }
  assert.equal(list.onSlate, true);
  assert.ok(list.seq > seq);
  assert.equal(list.dsn, dsn + 1);
  A.push(); second(A);
  assert.equal(list.dsn, dsn + 2);
  assert.equal(list.onSlate, false);
});

test('a restart of the same channel is a new source', () => {
  list.step(now, null, slate);
  A.push(); second(A);
  const dsn = list.dsn;
  fs.rmSync(A.dir, { recursive: true, force: true });
  const again = source('a'); again.key = 'a:2';
  again.push(); second(again);
  assert.equal(list.dsn, dsn + 1);
  assert.equal(body(parse().segs.at(-1).uri), 'a-0');
});

test('a segment missed inside one run is a discontinuity too', () => {
  list.step(now, null, slate);
  A.push(); second(A); A.push(); second(A);
  const dsn = list.dsn;
  A.push(); A.push();
  fs.rmSync(path.join(A.dir, 'seg_00002.ts'));
  second(A);
  assert.equal(list.dsn, dsn + 1);
  assert.equal(body(parse().segs.at(-1).uri), 'a-3');
});

test('the first playlist ends at the clock, with PDT continuous through it', () => {
  list.step(now, null, { key: slate.key, list: [{ file: slate.list[0].file, dur: 1.033 }, { file: slate.list[1].file, dur: 0.967 }] });
  const p = parse();
  assert.ok(p.segs.every(s => Number.isFinite(s.pdt)));
  assertContinuous(p.segs);
  assert.equal(list.end, now);
  assert.equal(p.segs[0].pdt, now - 6000);
});

test('PDT is continuous across channel switches, slate and discontinuities', () => {
  const c = collector();
  list.step(now, null, slate); c.look();
  for (let i = 0; i < 4; i++) { A.push(); second(A); c.look(); }
  for (let i = 0; i < 3; i++) { second(null); c.look(); }
  for (let i = 0; i < 4; i++) { B.push(1.033); second(B); c.look(); } // a different length, so rounding would show
  second(null); c.look();
  const again = source('a'); again.key = 'a:2';
  for (let i = 0; i < 4; i++) { again.push(0.967); second(again); c.look(); }
  assertContinuous(c.segs);
  assert.ok(c.segs.filter(s => s.disc).length >= 4);
  assert.equal(c.segs.at(-1).seq - c.segs[0].seq + 1, c.segs.length);
});

test('a direct switch with no wait stays continuous, whichever way the clock falls', () => {
  list.step(now, null, slate);
  for (let i = 0; i < 3; i++) { A.push(); second(A); }
  const end = list.end, tail = list.entries.at(-1);
  B.push(); now += 300; list.step(now, B, slate);
  const e = list.entries.at(-1);
  assert.equal(e.pdt, end);
  assert.equal(e.pdt, tail.pdt + 1000);
  assert.equal(e.disc, true);
});

test('slate fills a shortfall in one go, PDT continuous, ending at the clock', () => {
  const c = collector();
  list.step(now, null, slate); c.look();
  for (let i = 0; i < 3; i++) { A.push(); second(A); c.look(); }
  const end = list.end, seq = list.seq, dsn = list.dsn;
  now += 3200; list.step(now, A, slate); c.look(); // a running source gone quiet, seen late
  assert.equal(list.seq, seq + 4, 'enough slate to cover 3.2 s');
  assert.equal(list.end, end + 4000);
  assert.ok(list.end >= now && list.end - now < 1000);
  assert.equal(list.dsn, dsn + 1, 'one discontinuity going in');
  assertContinuous(c.segs);
});

test('a shortfall longer than the whole retained window is still filled without a gap', () => {
  list.step(now, null, slate);
  A.push(); second(A);
  now += 60e3; list.step(now, null, slate);
  assert.ok(list.end >= now && list.end - now < 1000);
  assert.ok(list.entries.length <= LIST + RETAIN);
  for (let i = 1; i < list.entries.length; i++) assert.equal(list.entries[i].pdt, list.entries[i - 1].pdt + 1000);
  assertContinuous(parse().segs);
});

test('a fresh segment cannot hide a wall-clock shortfall, and an empty poll fills only once', () => {
  slate = { ...slate, list: Array(60).fill(slate.list[0]) };
  const c = collector();
  list.step(now, null, slate); c.look();
  A.push(); second(A); c.look();
  const end = list.end, dsn = list.dsn;
  A.push(); now += 3200; list.step(now, A, slate); c.look();
  assert.equal(list.end, end + 5000, 'four slate segments followed by fresh media');
  assert.equal(list.dsn, dsn + 2, 'source to slate and back');
  assert.equal(list.onSlate, false);
  assertContinuous(c.segs);
  now = list.end + 3000;
  list.step(now, A, slate); c.look();
  assert.equal(list.end, now, 'no extra slate from filling twice in one poll');
  assertContinuous(c.segs);
});

test('slate stays out of a running source until it is more than the limit behind the clock', () => {
  list.step(now, null, slate);
  A.push(); second(A);
  const seq = list.seq;
  for (; now - list.end + 250 < MAX_LAG_MS;) { now += 250; list.step(now, A, slate); assert.equal(list.seq, seq); }
  now += 250; list.step(now, A, slate);
  assert.ok(list.seq > seq);
  assert.equal(list.onSlate, true);
});

test('a source running in real time is not interrupted, even with some jitter', () => {
  list.step(now, null, slate);
  A.push(); now += 3000; list.step(now, A, slate);                 // the wait for a first segment
  assert.ok(list.end >= now, 'slate covers the wait before the first source segment');
  assertContinuous(parse().segs);
  const dsn = list.dsn;
  for (let i = 0; i < 30; i++) {
    const late = i % 3 ? 1000 : 1250, early = 2000 - late;
    for (const wait of [late, early]) { A.push(); for (let t = 0; t < wait; t += 250) { now += 250; list.step(now, A, slate); } }
  }
  assert.equal(list.onSlate, false);
  assert.equal(list.dsn, dsn);
});

test('a new segment ahead of the clock just continues, and slate then waits for the clock', () => {
  const c = collector();
  list.step(now, null, slate); c.look();
  for (let i = 0; i < 5; i++) { B.push(); now += 100; list.step(now, B, slate); c.look(); } // a provider burst
  assert.ok(list.end > now + 4000, 'ahead of the clock');
  const end = list.end, seq = list.seq;
  now += 1000; list.step(now, null, slate); c.look(); // off air, but nothing is due yet
  assert.equal(list.seq, seq);
  assert.equal(list.end, end);
  now = end + 10; list.step(now, null, slate); c.look();
  assert.equal(list.seq, seq + 1);
  assertContinuous(c.segs);
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

test('TARGETDURATION covers a long segment while it is listed, then falls back', () => {
  list.step(now, null, slate);
  A.push(1.7); second(A);
  assert.equal(parse().target, 2);
  for (let i = 0; i < LIST; i++) second(null);
  assert.equal(parse().target, 1);
});

test('a new slate after a resolution change is a source change', () => {
  list.step(now, null, slate);
  const dsn = list.dsn;
  second(null, { key: 'slate:480', list: slate.list });
  assert.equal(list.dsn, dsn + 1);
});

test('numbers keep rising across a restart', () => {
  const later = new LivePlaylist({ dir: list.dir, now: now + 5000 });
  for (let i = 0; i < 3; i++) second(null);
  assert.ok(later.seq > list.seq - LIST - 1);
  assert.ok(later.seq < 2 ** 31 && later.dsn < 2 ** 31, 'fits a player that keeps these in 32 bits');
  assert.ok(new LivePlaylist({ dir: list.dir, now: now + 3600e3 }).seq > list.seq + 3600);
});
