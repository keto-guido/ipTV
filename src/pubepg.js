'use strict';
// Public XMLTV fallback (epgshare01.online, free, no login). Fills guide gaps for AM | USA / AM | CA channels
// that have no provider EPG. Never contacts the IPTV provider. Fetched at most every 12h (+jitter), cached on disk.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');

const SOURCES = ['epg_ripper_US2', 'epg_ripper_CA2', 'epg_ripper_US_LOCALS1', 'epg_ripper_US_SPORTS1']
  .map(n => ({ n, url: `https://epgshare01.online/epgshare01/${n}.xml.gz` }));
const BEFORE = 2 * 3600, AFTER = 48 * 3600, DESC = 140;

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n ? String.fromCodePoint(n) : ''; }
  return ENT[e] ?? m;
}).replace(/\s+/g, ' ').trim();
const attr = (s, n) => { const m = new RegExp(`\\b${n}="([^"]*)"`).exec(s); return m ? m[1] : ''; };
const inner = (s, n) => { const m = new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)</${n}>`).exec(s); return m ? decode(m[1]) : ''; };
function time(s) {
  const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?\s*([+-])?(\d\d)?(\d\d)?/.exec(s || '');
  if (!m) return 0;
  let t = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000;
  if (m[7]) t -= (m[7] === '-' ? -1 : 1) * ((+m[8]) * 3600 + (+m[9] || 0) * 60);
  return t;
}

// ---- matching ----
const TAGS = /\b(?:UHD|FHD|HD|SD|[48]K|HEVC|H\.?26[45]|[256]0 ?FPS|BACKUP ?\d?|BK|RAW|FEED|CHANNEL|NETWORK|TV)\b/g;
const norm = s => String(s).toUpperCase().replace(/^\s*(?:US|USA|CA|CAFR|CAEN|LAT)\s*[-|:]\s*/, '')
  .replace(/[\u00b2\u00b3\u00b9\u25c9\u25cf]/g, '').replace(/&/g, ' AND ').replace(/\+/g, ' PLUS ')
  .replace(TAGS, ' ').replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const CALL = /\(([KWC][A-Z]{2,3})(?:[- ]?(?:DT|TV|HD|LD|CD))?\)/;          // "(KXLY)" in our names
const PUBCALL = /^([KWC][A-Z]{2,3})(?:-(?:DT|TV|HD|LD|CD))?$/;            // main feed only, not -DT2 subchannels
const LOCALISH = /^(?:ABC|CBS|NBC|FOX|PBS|CW|MY|MYTV|TELEMUNDO|UNIVISION|UNIMAS|IND|INDEPENDENT|THE SPOT|CTV|CBC|GLOBAL|CITY|ION)\b.*\b\d{1,2}\b/;
const SKIP = /#{3,}| : |24\/7|\bPPV\b|\bEVENT\b|\bGAME \d|\bREPLAY\b|\bESPN PLUS \d|\bFLO \d/i;

// pub: [{id, src, names:[...]}]; ours: [{id, name, us:bool}] -> Map(ourId -> pubId)
function match(ours, pub, overrides = {}) {
  const byName = new Map(), byCall = new Map(), ids = new Set(pub.map(p => p.id));
  for (const p of pub) {
    const base = p.id.replace(/\.[a-z0-9_]+$/i, '');
    for (const n of [...p.names, base.replace(/\./g, ' ')]) {
      const c = PUBCALL.exec(n.trim().toUpperCase()); if (c) (byCall.get(c[1]) || byCall.set(c[1], []).get(c[1])).push(p);
      const k = norm(n); if (k) { const a = byName.get(k) || byName.set(k, []).get(k); if (!a.includes(p)) a.push(p); }
    }
  }
  const subs = new Set(); for (const p of pub) { const m = /^([KWC][A-Z]{2,3})-DT\d/i.exec(p.id); if (m) subs.add(m[1].toUpperCase()); }
  const SUBNET = /^(?:CW|MY|MYTV|IND|INDEPENDENT|THE SPOT|METV|ME TV|ION|COZI|GRIT|ANTENNA|BOUNCE|COMET|CHARGE|LAFF|TBD)\b/;
  const out = new Map(), how = {};
  for (const o of ours) {
    const ov = overrides[o.id] || overrides[o.name];
    if (ov && ids.has(ov)) { out.set(o.id, ov); how[o.id] = 'override'; continue; }
    if (SKIP.test(o.name)) continue;
    const up = o.name.toUpperCase(), cm = CALL.exec(up);
    if (cm) { // local affiliate: callsign must agree
      if (SUBNET.test(norm(o.name)) && subs.has(cm[1])) continue; // likely a subchannel of that station: ambiguous
      const c = [...new Set(byCall.get(cm[1]) || [])];
      const pick = c.find(p => /-DT$/i.test(p.id.replace(/\.[a-z0-9_]+$/i, ''))) || (c.length === 1 ? c[0] : null);
      if (pick) { out.set(o.id, pick.id); how[o.id] = 'callsign'; }
      continue;
    }
    const k = norm(o.name);
    if (!k || LOCALISH.test(k)) continue; // network + number + city without callsign: too risky
    let c = byName.get(k) || [];
    if (c.length > 1) { const pref = c.filter(p => (o.us ? /\.us/i : /\.ca/i).test(p.id)); if (pref.length) c = pref; }
    if (c.length >= 1) { out.set(o.id, c[0].id); how[o.id] = c.length === 1 ? 'name' : 'name~'; }
  }
  return { map: out, how };
}

// Stream one source: collect <channel>s, then (once channels end) keep programmes for wanted ids.
async function parse(stream, onChannels, lo, hi) {
  stream.setEncoding('utf8');
  const chans = [], ch = Object.create(null);
  let buf = '', phase = 0, want = null, kept = 0;
  for await (const chunk of stream) {
    buf += chunk; let i = 0;
    for (;;) {
      if (!phase) {
        const s = buf.indexOf('<channel', i), q = buf.indexOf('<programme', i);
        if (q >= 0 && (s < 0 || q < s)) { phase = 1; want = onChannels(chans); continue; }
        if (s < 0) { i = Math.max(i, buf.length - 16); break; }
        const e = buf.indexOf('</channel>', s); if (e < 0) { i = s; break; }
        const b = buf.slice(s, e); i = e + 10;
        const id = decode(attr(b.slice(0, b.indexOf('>') + 1), 'id'));
        if (id) chans.push({ id, names: [...b.matchAll(/<display-name[^>]*>([\s\S]*?)<\/display-name>/g)].map(m => decode(m[1])) });
        continue;
      }
      const s = buf.indexOf('<programme', i); if (s < 0) { i = Math.max(i, buf.length - 16); break; }
      const e = buf.indexOf('</programme>', s); if (e < 0) { i = s; break; }
      const b = buf.slice(s, e); i = e + 12;
      const head = b.slice(0, b.indexOf('>') + 1), id = decode(attr(head, 'channel'));
      if (!want.has(id)) continue;
      const a = time(attr(head, 'start')), z = time(attr(head, 'stop'));
      if (!a || z <= lo || a >= hi) continue;
      let d = inner(b, 'desc'); if (d.length > DESC) d = d.slice(0, DESC - 1) + '\u2026';
      (ch[id] || (ch[id] = [])).push([a, z || a + 1800, inner(b, 'title'), d]); kept++;
    }
    buf = buf.slice(i); if (buf.length > 4e6) buf = buf.slice(-1e6);
  }
  if (!phase) want = onChannels(chans);
  return { ch, kept, chans: chans.length };
}

module.exports = { SOURCES, match, parse, norm, BEFORE, AFTER };
