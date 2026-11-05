'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSwitchState } = require('../src/switch-state');

test('request publishes immediately, boundary completes fields once, stale sources are ignored', () => {
  const events = [], state = createSwitchState(s => events.push(s));
  const channel = { id: '1' };
  state.request(channel, 1000);
  assert.deepEqual(state.fields(channel), { switchedAt: 1000, switchSeq: null, switchPdt: null });
  assert.equal(events.length, 1);
  state.boundary('2', { seq: 5, pdt: 2000 });
  assert.equal(events.length, 1);
  state.boundary('1', { seq: 6, pdt: 3000 });
  assert.deepEqual(state.fields(channel), { switchedAt: 1000, switchSeq: 6, switchPdt: new Date(3000).toISOString() });
  assert.equal(events.length, 2);
  assert.equal(events[0].switchSeq, null);
  state.boundary('1', { seq: 7, pdt: 4000 });
  state.request(channel, 5000);
  assert.equal(events.length, 2);
  state.request({ id: '2' }, 6000);
  assert.deepEqual(state.fields({ id: '2' }), { switchedAt: 6000, switchSeq: null, switchPdt: null });
});

test('phone and TV boundaries remain independent', () => {
  const events = [], state = createSwitchState(s => events.push(s));
  state.request({ id: '1' }, 1000);
  state.boundary('1', { seq: 20, pdt: 2000 }, 'phone');
  assert.equal(state.fields({ id: '1' }).switchSeq, null);
  assert.equal(events.at(-1).phoneSwitch.switchSeq, 20);
  state.boundary('1', { seq: 30, pdt: 2500 }, 'tv');
  assert.equal(state.fields({ id: '1' }).switchSeq, 30);
  assert.equal(state.fields({ id: '1' }).phoneSwitch.switchSeq, 20);
});
