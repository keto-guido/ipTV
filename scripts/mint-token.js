'use strict';
// Test helper: mint an HS256 msv_session JWT.
// Usage: node scripts/mint-token.js <secretFile> [roles=tv,tv-admin] [ttlSec=3600]
const fs = require('fs'), crypto = require('crypto');
const [file, roles = 'tv,tv-admin', ttl = '3600'] = process.argv.slice(2);
if (!file) { console.error('usage: mint-token.js <secretFile> [roles] [ttlSec]'); process.exit(1); }
const key = fs.readFileSync(file, 'utf8').trim();
const b = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const h = b({ alg: 'HS256', typ: 'JWT' }), p = b({ sub: 'test', name: 'test', roles: roles.split(',').filter(Boolean), iat: now, exp: now + +ttl, ...(process.env.TOKEN_EXTRA ? JSON.parse(process.env.TOKEN_EXTRA) : {}) });
process.stdout.write(`${h}.${p}.${crypto.createHmac('sha256', key).update(h + '.' + p).digest('base64url')}`);
