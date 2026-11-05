'use strict';
// The SSE hub on its own HTTP server. Auth and the real route are covered in routes.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createHub } = require('../src/events');

async function serve(hub, user = () => ({ sub: 'u' })) {
  const server = http.createServer((req, res) => { if (!hub.add(req, res, user(req))) { res.writeHead(429); res.end(); } });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}/`;
  return { url, close: () => { server.closeAllConnections(); server.close(); } };
}
// Reads a stream, handing out each complete block.
async function open(url) {
  const ctl = new AbortController(), r = await fetch(url, { signal: ctl.signal });
  const blocks = [], waiters = [];
  let buf = '', ended = false;
  const pump = (async () => {
    const dec = new TextDecoder();
    try {
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) { blocks.push(buf.slice(0, i)); buf = buf.slice(i + 2); waiters.splice(0).forEach(w => w()); }
      }
    } catch {}
    ended = true; waiters.splice(0).forEach(w => w());
  })();
  return {
    r, abort: () => ctl.abort(), get ended() { return ended; }, closed: () => pump,
    async next() {
      while (!blocks.length) { if (ended) return null; await new Promise(ok => waiters.push(ok)); }
      return blocks.shift();
    },
    async state() { for (;;) { const b = await this.next(); if (b === null) return null; if (b.startsWith('event: state')) return JSON.parse(b.split('\n')[1].slice(6)); } },
  };
}
const until = async f => { for (let i = 0; i < 200 && !f(); i++) await new Promise(ok => setTimeout(ok, 10)); assert.ok(f()); };

test('sends the current state on connect, then only actual changes', async t => {
  const hub = createHub(), s = await serve(hub);
  t.after(s.close);
  assert.equal(hub.publish({ live: 'a' }), true);
  const c = await open(s.url);
  t.after(c.abort);
  assert.equal(c.r.headers.get('content-type'), 'text/event-stream');
  assert.match(c.r.headers.get('cache-control'), /no-store/);
  assert.equal(c.r.headers.get('x-accel-buffering'), 'no');
  assert.equal(await c.next(), 'retry: 3000');
  assert.deepEqual(await c.state(), { live: 'a' });
  assert.equal(hub.publish({ live: 'a' }), false);
  assert.equal(hub.publish({ live: 'b' }), true);
  assert.deepEqual(await c.state(), { live: 'b' }); // not a repeat of 'a'
});

test('every client gets each change', async t => {
  const hub = createHub(), s = await serve(hub);
  t.after(s.close);
  hub.publish({ n: 0 });
  const a = await open(s.url), b = await open(s.url);
  t.after(a.abort); t.after(b.abort);
  await a.state(); await b.state();
  hub.publish({ n: 1 });
  assert.deepEqual([await a.state(), await b.state()], [{ n: 1 }, { n: 1 }]);
});

test('switching broadcasts request and boundary updates to every connected client', async t => {
  const hub = createHub(), s = await serve(hub);
  t.after(s.close);
  const a = await open(s.url), b = await open(s.url);
  t.after(a.abort); t.after(b.abort);
  await a.next(); await b.next();
  for (const switchSeq of [null, 42]) {
    const data = { id: '1', switchedAt: 1000, switchSeq, switchPdt: switchSeq === null ? null : new Date(2000).toISOString() };
    hub.switching(data);
    const expected = `event: switching\ndata: ${JSON.stringify(data)}`;
    assert.equal(await a.next(), expected);
    assert.equal(await b.next(), expected);
  }
});

test('sends pings so idle streams stay open through proxies', async t => {
  const hub = createHub({ pingMs: 20 }), s = await serve(hub);
  t.after(s.close);
  const c = await open(s.url);
  t.after(c.abort);
  await c.next(); // retry
  assert.equal(await c.next(), ': ping');
});

test('a disconnected client is forgotten', async t => {
  const hub = createHub(), s = await serve(hub);
  t.after(s.close);
  const c = await open(s.url);
  await until(() => hub.size === 1);
  c.abort();
  await until(() => hub.size === 0);
});

test('the stream ends when the token expires', async t => {
  const hub = createHub(), s = await serve(hub, () => ({ sub: 'u', exp: Date.now() / 1000 + 0.1 }));
  t.after(s.close);
  const c = await open(s.url);
  await c.closed();
  assert.equal(c.ended, true);
  await until(() => hub.size === 0);
});

test('caps streams per user and in total', async t => {
  const users = ['a', 'a', 'a', 'b', 'c', 'd'];
  const hub = createHub({ maxPerUser: 2, maxClients: 3 }), s = await serve(hub, () => ({ sub: users.shift() }));
  t.after(s.close);
  const statuses = [];
  for (let i = 0; i < 5; i++) { const c = await open(s.url); t.after(c.abort); statuses.push(c.r.status); }
  assert.deepEqual(statuses, [200, 200, 429, 200, 429]);
});
