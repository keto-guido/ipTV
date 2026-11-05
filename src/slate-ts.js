'use strict';
// Repeat cached slate without resetting its MPEG-TS clock or continuity counters.
// HLS discontinuities belong to source transitions, not the cache's loop boundary.
const CLOCK = 2 ** 33;
function stamp(b, i, offset) {
  const value = ((b[i] >> 1 & 7) * 2 ** 30 + b[i + 1] * 2 ** 22 + (b[i + 2] >> 1) * 2 ** 15 + b[i + 3] * 128 + (b[i + 4] >> 1) + offset) % CLOCK;
  b[i] = (b[i] & 0xf0) | (Math.floor(value / 2 ** 30) << 1) | 1;
  b[i + 1] = Math.floor(value / 2 ** 22) & 255;
  b[i + 2] = (Math.floor(value / 2 ** 15) & 127) * 2 + 1;
  b[i + 3] = Math.floor(value / 128) & 255;
  b[i + 4] = (value & 127) * 2 + 1;
}
function retime(input, offset, counters) {
  const b = Buffer.from(input);
  for (let i = 0; i + 188 <= b.length; i += 188) {
    if (b[i] !== 0x47) throw new Error('invalid slate TS packet');
    const pid = (b[i + 1] & 31) * 256 + b[i + 2], afc = b[i + 3] >> 4 & 3;
    if (pid !== 8191) {
      const cc = counters.has(pid) ? (counters.get(pid) + (afc & 1)) & 15 : b[i + 3] & 15;
      b[i + 3] = (b[i + 3] & 240) | cc; counters.set(pid, cc);
    }
    let p = i + 4;
    if (afc & 2) {
      const length = b[p];
      if (length >= 7 && (b[p + 1] & 16)) {
        const j = p + 2;
        const base = (b[j] * 2 ** 25 + b[j + 1] * 2 ** 17 + b[j + 2] * 512 + b[j + 3] * 2 + (b[j + 4] >> 7) + offset) % CLOCK;
        b[j] = Math.floor(base / 2 ** 25); b[j + 1] = Math.floor(base / 2 ** 17) & 255;
        b[j + 2] = Math.floor(base / 512) & 255; b[j + 3] = Math.floor(base / 2) & 255;
        b[j + 4] = (b[j + 4] & 127) | (base % 2) * 128;
      }
      p += length + 1;
    }
    if ((afc & 1) && (b[i + 1] & 64) && p + 19 <= i + 188 && b[p] === 0 && b[p + 1] === 0 && b[p + 2] === 1 && b[p + 3] >= 0xc0 && b[p + 3] <= 0xef) {
      if (b[p + 7] & 128) stamp(b, p + 9, offset);
      if (b[p + 7] & 64) stamp(b, p + 14, offset);
    }
  }
  return b;
}
module.exports = { retime };
