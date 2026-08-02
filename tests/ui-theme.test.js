// Modern/Classic theme selection + pre-paint boot.
// Run: node --test tests/ui-theme.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const { normalizeTheme, applyUiTheme, UI_THEME } = require('../ui-theme.js');

// ─── normalizeTheme (pure) ─────────────────────────────────────────────────────

test('normalizeTheme: classic passes through', () => {
  assert.equal(normalizeTheme('classic'), 'classic');
});

test('normalizeTheme: anything else coerces to modern (the default)', () => {
  assert.equal(normalizeTheme('modern'), 'modern');
  assert.equal(normalizeTheme(undefined), 'modern');
  assert.equal(normalizeTheme(null), 'modern');
  assert.equal(normalizeTheme(''), 'modern');
  assert.equal(normalizeTheme('garbage'), 'modern');
});

test('UI_THEME constants: modern is the default value', () => {
  assert.equal(UI_THEME.MODERN, 'modern');
  assert.equal(UI_THEME.CLASSIC, 'classic');
});

// ─── applyUiTheme (document + localStorage mirror) ─────────────────────────────

function installDomFakes() {
  const calls = { setAttribute: [], removeAttribute: [], setItem: [], getItem: [] };
  let storageThrows = false;
  const documentElement = {
    setAttribute(name, value) { calls.setAttribute.push([name, value]); },
    removeAttribute(name) { calls.removeAttribute.push(name); },
  };
  // applyUiTheme reads the bare document / localStorage globals (page modules
  // are browser globals, not injected) — mirror that on globalThis for Node.
  globalThis.document = { documentElement };
  globalThis.localStorage = {
    setItem(k, v) { if (storageThrows) throw new Error('storage disabled'); calls.setItem.push([k, v]); },
    getItem(k) { calls.getItem.push(k); return null; },
  };
  return {
    calls,
    disableStorage() { storageThrows = true; },
  };
}

test('applyUiTheme: modern sets data-ui and mirrors to localStorage, returns modern', () => {
  const { calls } = installDomFakes();
  assert.equal(applyUiTheme('modern'), 'modern');
  assert.deepEqual(calls.setAttribute, [['data-ui', 'modern']]);
  assert.deepEqual(calls.setItem, [['uiTheme', 'modern']]);
});

test('applyUiTheme: classic removes data-ui and mirrors classic', () => {
  const { calls } = installDomFakes();
  globalThis.document.documentElement.setAttribute('data-ui', 'modern'); // pre-existing attribute
  assert.equal(applyUiTheme('classic'), 'classic');
  assert.deepEqual(calls.removeAttribute, ['data-ui']);
  assert.deepEqual(calls.setItem, [['uiTheme', 'classic']]);
});

test('applyUiTheme: unnormalized input is normalized first (garbage -> modern)', () => {
  const { calls } = installDomFakes();
  assert.equal(applyUiTheme('garbage'), 'modern');
  assert.deepEqual(calls.setAttribute, [['data-ui', 'modern']]);
  assert.deepEqual(calls.setItem, [['uiTheme', 'modern']]);
});

test('applyUiTheme: localStorage disabled still applies the attribute and returns theme', () => {
  const { calls, disableStorage } = installDomFakes();
  disableStorage();
  assert.equal(applyUiTheme('modern'), 'modern');
  assert.deepEqual(calls.setAttribute, [['data-ui', 'modern']]);
  assert.deepEqual(calls.setItem, []); // mirror lost, no throw
});

// ─── ui-boot.js (synchronous pre-paint snippet, vm-executed) ───────────────────

function boot(mirrorValue, getItemThrows = false) {
  const setAttr = [];
  const context = {
    localStorage: {
      getItem() { if (getItemThrows) throw new Error('storage disabled'); return mirrorValue; },
    },
    document: {
      documentElement: {
        setAttribute(name, value) { setAttr.push([name, value]); },
      },
    },
  };
  const code = fs.readFileSync(path.join(__dirname, '..', 'ui-boot.js'), 'utf8');
  vm.runInNewContext(code, context);
  return setAttr;
}

test('ui-boot: missing mirror applies modern (default) before first paint', () => {
  assert.deepEqual(boot(null), [['data-ui', 'modern']]);
});

test('ui-boot: modern mirror applies modern', () => {
  assert.deepEqual(boot('modern'), [['data-ui', 'modern']]);
});

test('ui-boot: classic mirror leaves the attribute untouched', () => {
  assert.deepEqual(boot('classic'), []);
});

test('ui-boot: storage disabled falls back to modern silently', () => {
  assert.deepEqual(boot(null, true), []);
});
