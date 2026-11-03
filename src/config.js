'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const env = process.env;

const cfg = {
  ROOT,
  HOST: env.HOST || '0.0.0.0',
  PORT: parseInt(env.PORT || '8090', 10),
  BASE: (env.BASE_PATH || '/tv').replace(/\/+$/, ''),
  LOGIN_PATH: env.LOGIN_PATH || '/login',
  COOKIE: env.COOKIE_NAME || 'msv_session',
  SECRETS_FILE: env.SECRETS_FILE || path.join(ROOT, 'config', 'secrets.env'),
  JWT_SECRET_FILE: env.JWT_SECRET_FILE || path.join(ROOT, 'config', 'jwt_secret'),
  DATA: path.join(ROOT, 'data'),
  HLS: path.join(ROOT, 'hls'),
  PUBLIC: path.join(ROOT, 'public'),
  FFMPEG: env.FFMPEG || 'ffmpeg',
  UA: env.PROVIDER_UA || 'VLC/3.0.20 LibVLC/3.0.20',
  LIST_TTL_MS: 12 * 3600e3,
  REFRESH_MIN_MS: 10 * 60e3,
};
// Local-dev auth bypass: only when explicitly enabled AND bound to loopback.
cfg.DEV_AUTH = env.DEV_AUTH === '1' && cfg.HOST === '127.0.0.1';

// Provider credentials are derived from the Xtream xmltv URL in secrets.env.
// Never log these values.
let provider = null;
function getProvider() {
  if (provider) return provider;
  let raw;
  try { raw = fs.readFileSync(cfg.SECRETS_FILE, 'utf8'); } catch { return null; }
  const m = raw.match(/^\s*IPTV_M3U_URL\s*=\s*"?([^"\r\n]+)"?/m);
  if (!m) return null;
  try {
    const u = new URL(m[1].trim());
    const username = u.searchParams.get('username');
    const password = u.searchParams.get('password');
    if (!username || !password) return null;
    provider = { origin: u.origin, host: u.host, username, password };
  } catch { return null; }
  return provider;
}

// Remove anything credential-ish from a string before logging/returning it.
function redact(s) {
  s = String(s);
  const p = getProvider();
  if (p) {
    for (const v of [p.password, p.username, p.host, p.origin]) {
      for (const f of new Set([v, encodeURIComponent(v)])) {
        if (f) s = s.split(f).join('***');
      }
    }
  }
  return s.replace(/https?:\/\/\S+/g, '[url]');
}

function log(...a) {
  console.log(new Date().toISOString(), redact(a.join(' ')));
}

module.exports = { cfg, getProvider, redact, log };
