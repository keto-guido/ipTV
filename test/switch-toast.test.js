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
