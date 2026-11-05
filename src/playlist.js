'use strict';
// One constant live HLS playlist, built from whatever source is current: a channel's ffmpeg output, or the slate.
// Segments get their own ever-increasing sequence numbers and are hard-linked out of ffmpeg's directory, so ffmpeg's
// delete_segments and clean() can't touch anything still listed here. This class owns their lifetime.
const fs = require('fs');
const path = require('path');
const { retime } = require('./slate-ts');

const LIST = 8;
const RETAIN = 35_000;   // milliseconds after leaving the playlist, independent of segment rate
const MAX_LAG_MS = 5000; // no new input for five seconds before falling back to slate
const EPOCH = Date.UTC(2026, 0, 1);

// Parses an ffmpeg media playlist into [{ num, uri, dur }].
function parseMedia(text) {
  const out = []; let dur = 0;
  for (const l of text.split(/\r?\n/)) {
    if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8));
    else if (l && !l.startsWith('#')) { const m = l.match(/(\d+)\.ts$/); if (m && dur > 0) out.push({ num: +m[1], uri: l, dur }); dur = 0; }
  }
  return out;
}

// Whole ms, also what EXTINF shows, so PDT + EXTINF in the playlist adds up exactly.
const ms = dur => Math.max(1, Math.round(dur * 1000));

function keep(from, to) {
  try { fs.linkSync(from, to); return true; } catch {}
  try { fs.copyFileSync(from, to); return true; } catch { return false; } // e.g. a filesystem without hard links
}

class LivePlaylist {
  constructor({ dir, now = Date.now(), list = LIST, retain = RETAIN, buffer = 2, onBoundary = () => {} }) {
    Object.assign(this, { dir, list, retain, buffer, onBoundary });
    // Seeded from the clock at twice real time, so numbers still move forward across a server restart with nothing persisted.
    this.seq = this.dsn = Math.floor((now - EPOCH) / 500);
    this.entries = [];
    this.end = null;   // ms: PDT of the next segment. Continuous within a source; re-anchored at source boundaries.
    this.from = null;  // source of the newest segment
    this.key = null;   // source wanted now
    this.last = null;  // newest ffmpeg segment number taken from the current source
    this.pos = 0;      // next slate segment
    this.trash = [];   // files Windows would not let go of yet
    this.lastInput = now;
    this.observed = null;
    this.target = 2;
    this.pending = [];
    this.pendingSeq = 0;
  }

  get onSlate() { return !this.from || this.from.startsWith('slate:'); }

  // One poll. src: { key, dir } or null, the running ffmpeg output; slate: { key, list: [{ file, dur }] } or null until it exists.
  step(now, src, slate) {
    const key = src ? src.key : null;
    if (key !== this.key) { this.key = key; this.last = null; }
    if (src) this.ingest(src, now);
    this.publish(now);
    if ((!this.pending.length && now - this.lastInput >= MAX_LAG_MS) || this.from === null || this.onSlate) this.fill(now, slate);
    this.trim(now);
  }

  ingest(src, now) {
    let text;
    try { text = fs.readFileSync(path.join(src.dir, 'index.m3u8'), 'utf8'); } catch { return false; } // not written yet
    const media = parseMedia(text);
    const newest = media.at(-1);
    const observed = newest && `${src.key}:${newest.num}`;
    if (observed && observed !== this.observed) { this.observed = observed; this.lastInput = now; }
    let got = false;
    // Copy completed input before a switch can delete the channel directory.
    for (const s of this.last === null ? media.slice(-(this.buffer + 1)) : media) {
      if (this.last !== null && s.num <= this.last) continue;
      const file = path.join(this.dir, 'pending_' + this.pendingSeq++ + '.ts');
      if (!keep(path.join(src.dir, s.uri), file)) break;
      this.last = s.num;
      this.pending.push({ file, dur: s.dur, from: src.key, owned: true });
      got = true;
    }
    return got;
  }

  publish(now) {
    while (this.pending.length) {
      const s = this.pending[0];
      const queued = this.pending.filter(e => e.from === s.from).length;
      if (s.from === this.key && queued <= this.buffer && now - this.lastInput < MAX_LAG_MS) break;
      const changed = this.from !== s.from;
      if (this.end === null || changed) this.end = now - ms(s.dur);
      // Pace startup bursts; keep PDT continuous inside each source.
      if (!changed && this.end + ms(s.dur) > now + 250) break;
      const file = path.join(this.dir, 'seg_' + this.seq + '.ts');
      fs.renameSync(s.file, file);
      this.pending.shift();
      this.append({ ...s, file });
    }
  }

  fill(now, slate) {
    if (!slate || !slate.list.length) return;
    if (this.end !== null && this.end > now) return;
    const { list } = slate;
    if (this.from !== slate.key) { this.pos = 0; this.slateOffset = 0; this.slateCounters = new Map(); }
    // The first playlist of a process is already full: Safari wants several segments before it will start a live stream.
    if (this.end === null) {
      this.end = now;
      for (let i = 0; i < this.list; i++) this.end -= ms(list[i % list.length].dur);
    }
    if (this.from !== null && this.from !== slate.key) this.end = now - ms(list[this.pos].dur);
    do {
      const s = list[this.pos];
      let file = s.file;
      if (slate.retime) {
        file = path.join(this.dir, `seg_${this.seq}.ts`);
        fs.writeFileSync(file, retime(fs.readFileSync(s.file), this.slateOffset, this.slateCounters));
      }
      this.append({ file, dur: s.dur, from: slate.key, owned: !!slate.retime });
      this.pos = (this.pos + 1) % list.length;
      if (this.pos === 0) this.slateOffset += list.reduce((n, s) => n + ms(s.dur) * 90, 0);
    } while (this.end < now);
  }

  // Advance by media duration; only publish()/fill() re-anchor at an actual source boundary.
  append({ file, dur, from, owned }) {
    const boundary = from !== this.from;
    const changed = this.from !== null && boundary;
    if (changed) this.dsn++;
    this.target = Math.max(this.target, Math.round(dur));
    this.entries.push({ seq: this.seq++, dsn: this.dsn, disc: changed, dur: ms(dur) / 1000, pdt: this.end, file, owned });
    if (boundary) this.onBoundary(from, this.entries.at(-1));
    this.end += ms(dur);
    this.from = from;
  }

  trim(now) {
    for (const e of this.entries.slice(0, -this.list)) e.leftAt ??= now;
    while (this.entries.length > this.list && now - this.entries[0].leftAt > this.retain) {
      const e = this.entries.shift();
      if (e.owned) this.trash.push(e.file);
    }
    this.trash = this.trash.filter(f => { try { fs.rmSync(f, { force: true }); return false; } catch { return true; } });
  }

  render() {
    const w = this.entries.slice(-this.list);
    if (!w.length) return null;
    const out = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${this.target}`,
      '#EXT-X-INDEPENDENT-SEGMENTS', `#EXT-X-MEDIA-SEQUENCE:${w[0].seq}`,
      // Counts the discontinuities before the first listed segment; a tag still on that segment is listed below.
      `#EXT-X-DISCONTINUITY-SEQUENCE:${w[0].dsn - (w[0].disc ? 1 : 0)}`];
    for (const e of w) {
      if (e.disc) out.push('#EXT-X-DISCONTINUITY');
      out.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(e.pdt).toISOString()}`, `#EXTINF:${e.dur.toFixed(3)},`, `seg_${e.seq}.ts`);
    }
    return out.join('\n') + '\n';
  }

  file(seq) { const e = this.entries.find(x => x.seq === seq); return e ? e.file : null; }
}

module.exports = { LivePlaylist, parseMedia, LIST, RETAIN, MAX_LAG_MS };
