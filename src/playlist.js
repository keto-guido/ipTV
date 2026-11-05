'use strict';
// One constant live HLS playlist, built from whatever source is current: a channel's ffmpeg output, or the slate.
// Segments get their own ever-increasing sequence numbers and are hard-linked out of ffmpeg's directory, so ffmpeg's
// delete_segments and clean() can't touch anything still listed here. This class owns their lifetime.
const fs = require('fs');
const path = require('path');

const LIST = 6;          // segments in the playlist
const RETAIN = 14;       // ...plus these stay fetchable after leaving it, for players still working through an older copy
const MAX_LAG_MS = 1500; // a running source may leave the timeline this far behind the clock before slate fills in
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
  constructor({ dir, now = Date.now(), list = LIST, retain = RETAIN }) {
    Object.assign(this, { dir, list, retain });
    // Seeded from the clock at twice real time, so numbers still move forward across a server restart with nothing persisted.
    this.seq = this.dsn = Math.floor((now - EPOCH) / 500);
    this.entries = [];
    this.end = null;   // ms: PDT of the next segment. Only ever moves by the duration of a segment.
    this.from = null;  // source of the newest segment
    this.key = null;   // source wanted now
    this.last = null;  // newest ffmpeg segment number taken from the current source
    this.gap = false;  // a segment of the current source could not be taken
    this.pos = 0;      // next slate segment
    this.trash = [];   // files Windows would not let go of yet
  }

  get onSlate() { return !this.from || this.from.startsWith('slate:'); }

  // One poll. src: { key, dir } or null, the running ffmpeg output; slate: { key, list: [{ file, dur }] } or null until it exists.
  step(now, src, slate) {
    const key = src ? src.key : null;
    if (key !== this.key) { this.key = key; this.last = null; this.gap = false; }
    // Catch up before taking fresh media, including a late first segment. Moving
    // PDT directly would leave a hole; slate supplies the missing duration.
    const before = this.seq;
    if (src && this.end !== null && now - this.end >= MAX_LAG_MS) this.fill(now, slate);
    if (!(src && this.ingest(src, now)) && this.seq === before) this.fill(now, slate);
    this.trim();
  }

  ingest(src, now) {
    let text;
    try { text = fs.readFileSync(path.join(src.dir, 'index.m3u8'), 'utf8'); } catch { return false; } // not written yet
    const media = parseMedia(text);
    let got = false;
    // Joining a source that already has a list starts at its newest segment: older ones would put the timeline ahead of the clock.
    for (const s of this.last === null ? media.slice(-1) : media) {
      if (this.last !== null && s.num <= this.last) continue;
      const gap = this.gap || (this.last !== null && s.num !== this.last + 1);
      this.last = s.num;
      const file = path.join(this.dir, `seg_${this.seq}.ts`);
      if (!keep(path.join(src.dir, s.uri), file)) { this.gap = true; continue; }
      this.gap = false;
      this.end ??= now - ms(s.dur);
      this.append({ file, dur: s.dur, from: src.key, owned: true, disc: gap });
      got = true;
    }
    return got;
  }

  fill(now, slate) {
    if (!slate || !slate.list.length) return;
    // The source on air gets some slack between its segments. With anything else due, slate holds the timeline at the
    // clock, so the next source starts ahead of it and has that slack from its first segment.
    const slack = this.key && this.from === this.key ? MAX_LAG_MS : 0;
    if (this.end !== null && now - this.end < slack) return;
    const { list } = slate;
    if (this.from !== slate.key) this.pos = 0;
    // The first playlist of a process is already full: Safari wants several segments before it will start a live stream.
    if (this.end === null) {
      this.end = now;
      for (let i = 0; i < this.list; i++) this.end -= ms(list[i % list.length].dur);
    }
    do {
      // Slate timestamps run continuously until the loop wraps back to its start.
      const wrap = this.from === slate.key && this.pos === 0, s = list[this.pos];
      this.append({ file: s.file, dur: s.dur, from: slate.key, owned: false, disc: wrap });
      this.pos = (this.pos + 1) % list.length;
    } while (this.end < now);
  }

  // The one place the timeline moves: each segment starts where the last one ended, whatever the source.
  append({ file, dur, from, owned, disc }) {
    const changed = this.from !== null && (disc || from !== this.from);
    if (changed) this.dsn++;
    this.entries.push({ seq: this.seq++, dsn: this.dsn, disc: changed, dur: ms(dur) / 1000, pdt: this.end, file, owned });
    this.end += ms(dur);
    this.from = from;
  }

  trim() {
    while (this.entries.length > this.list + this.retain) {
      const e = this.entries.shift();
      if (e.owned) this.trash.push(e.file);
    }
    this.trash = this.trash.filter(f => { try { fs.rmSync(f, { force: true }); return false; } catch { return true; } });
  }

  render() {
    const w = this.entries.slice(-this.list);
    if (!w.length) return null;
    const out = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${Math.max(1, ...w.map(e => Math.round(e.dur)))}`,
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
