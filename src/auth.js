'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { cfg } = require('./config');

let secret = null, secretCheckedAt = 0;
function getSecret() {
  const now = Date.now();
  // Re-read when missing (every request) or every 60s to pick up rotation.
  if (secret && now - secretCheckedAt < 60e3) return secret;
  secretCheckedAt = now;
  try {
    const s = fs.readFileSync(cfg.JWT_SECRET_FILE, 'utf8').trim();
    secret = s.length >= 32 ? Buffer.from(s, 'utf8') : null;
  } catch { secret = null; }
  return secret;
}

function b64urlDecode(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function verify(token, opt = {}) {
  const key = getSecret();
  if (!key || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
    payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  } catch { return null; }
  if (!header || header.alg !== 'HS256') return null;
  const expected = crypto.createHmac('sha256', key).update(parts[0] + '.' + parts[1]).digest();
  const given = b64urlDecode(parts[2]);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
  if (typeof payload.sub !== 'string' && typeof payload.sub !== 'number') return null;
  if (opt.iss && payload.iss !== opt.iss) return null;
  if (opt.aud && !(payload.aud === opt.aud || (Array.isArray(payload.aud) && payload.aud.includes(opt.aud)))) return null;
  const roles = Array.isArray(payload.roles) ? payload.roles : [];
  const admin = roles.includes('tv-admin');
  const watch = admin || roles.includes('tv');
  return { sub: String(payload.sub), name: payload.name || String(payload.sub), watch, admin, exp: payload.exp };
}

function parseCookies(h) {
  const out = {};
  (h || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function userFor(req) {
  if (cfg.DEV_AUTH) return { sub: 'dev', name: 'dev', watch: true, admin: true };
  const c = parseCookies(req.headers.cookie)[cfg.COOKIE];
  if (c) return verify(c);
  // Fallback: NAS proxy's short-lived X-Apphub-Token (same key, iss=apphub, aud=tv).
  const h = req.headers['x-apphub-token'];
  return h ? verify(String(h), { iss: 'apphub', aud: 'tv' }) : null;
}

module.exports = { userFor, verify };
