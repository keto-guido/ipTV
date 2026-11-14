'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('toast waits for played phone boundary, handles rapid switches and times out', () => {
  const element = () => ({ hidden: true, setAttribute() {}, appendChild() {}, replaceChildren() {}, remove() {} });
  let timeout;
  const context = vm.createContext({
    document: { createElement: element, createTextNode: s => s, body: { appendChild() {} } },
    B: '', main: {}, setTimeout: fn => { timeout = fn; }, clearTimeout() {},
  });
  const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('const switchToast'), source.indexOf('// ---------- player ----------')), context);
  const run = code => vm.runInContext(code, context);
  run("showSwitch({id:'1', switchedAt:Date.now(), switchSeq:1})");
  run('checkSwitch({sn:100})'); // TV sequence must not dismiss the phone toast.
  assert.equal(run('switchToast.hidden'), false);
  run("showSwitch({id:'1', switchedAt:pendingSwitch.switchedAt, phoneSwitch:{switchSeq:101}})");
  run('checkSwitch({sn:100})');
  assert.equal(run('switchToast.hidden'), false);
  run('checkSwitch({sn:101})');
  assert.equal(run('switchToast.hidden'), true);
  run("showSwitch({id:'2', switchedAt:Date.now(), phoneSwitch:{switchPdt:new Date(2000).toISOString()}})");
  run('checkSwitch({sn:0,programDateTime:1999})');
  assert.equal(run('switchToast.hidden'), false);
  run('checkSwitch({sn:0,programDateTime:2000})');
  assert.equal(run('switchToast.hidden'), true);
  run("showSwitch({id:'3', switchedAt:Date.now()})");
  timeout();
  assert.equal(run('switchToast.hidden'), true);
});

test('screen player tuning restores count-based provider settings and guards catch-up', () => {
  const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('const HLS_CONFIG'), source.indexOf('function attach(t)')), context);
  const run = code => vm.runInContext(code, context);
  run("var S = {live:{lowLatency:true}}, t = {live:true, loaded:true, hls:{config:{maxBufferLength:30,maxMaxBufferLength:600,backBufferLength:30},liveSyncPosition:19}, video:{currentTime:10,seekable:{length:1,start:()=>0,end:()=>20}}}; tuneLive(t); catchUpLive(t)");
  assert.equal(run('t.hls.config.liveSyncDuration'), 1);
  assert.equal(run('t.hls.config.liveMaxLatencyDuration'), 3);
  assert.equal(run('t.hls.config.maxLiveSyncPlaybackRate'), 1.15);
  assert.equal(run('t.video.currentTime'), 19);
  run('t.video.currentTime = 17; catchUpLive(t)');
  assert.equal(run('t.video.currentTime'), 17); // Periodic correction needs more than four seconds.
  run('t.video.currentTime = 14; catchUpLive(t)');
  assert.equal(run('t.video.currentTime'), 19);
  run('S.live = {}; tuneLive(t); t.video.currentTime = 0; catchUpLive(t)');
  assert.equal(run('t.video.currentTime'), 0);
  assert.equal(run('t.hls.config.liveSyncDuration'), undefined);
  assert.equal(run('t.hls.config.liveMaxLatencyDuration'), undefined);
  assert.equal(run('t.hls.config.liveSyncDurationCount'), 3);
  assert.equal(run('t.hls.config.maxLiveSyncPlaybackRate'), 1.05);
  assert.equal(run('t.hls.config.maxBufferLength'), 30);
  assert.equal(run('t.hls.config.maxMaxBufferLength'), 600);
  assert.equal(run('t.hls.config.backBufferLength'), 30);
  run('S.live.lowLatency = true; t.hls = null; tuneLive(t); catchUpLive(t)');
  assert.equal(run('t.video.currentTime'), 19); // Native Safari uses seekable.end.
  run('var provider = {live:false, hls:{config:{}},video:{}}; tuneLive(provider); catchUpLive(provider)');
  assert.equal(run('Object.keys(provider.hls.config).length'), 0);
});
