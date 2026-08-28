// Web-automation injectors: paste-into-page logic (chatgpt_injector.js,
// gemini_injector.js).
// Run: node --test tests/injectors.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

// ─── Shared fakes (both injectors read bare browser/window/document globals) ──

const listeners = [];
globalThis.browser = { runtime: { onMessage: { addListener(fn) { listeners.push(fn); } } } };
globalThis.window = { addEventListener() {} };

class FakeElement {
  constructor() {
    this.value = '';
    this.textContent = '';
    this.style = {};
    this.scrollHeight = 100;
    this.disabled = false;
    this.readOnly = false;
    this.offsetParent = {}; // default: "visible" (non-null)
    this.focusCalls = 0;
    this.events = [];
  }
  focus() { this.focusCalls++; }
  dispatchEvent(ev) { this.events.push(ev.type); }
}
globalThis.HTMLTextAreaElement = class extends FakeElement {};
globalThis.HTMLInputElement = class extends FakeElement {};

// Per-test state swapped by installDomFakes().
let dom = {
  querySelector: () => null,
  execCommand: () => false,
  computedStyle: () => ({ visibility: 'visible', display: 'block', position: 'static' }),
  selection: null,
};
globalThis.document = {
  querySelector(sel) { return dom.querySelector(sel); },
  execCommand(cmd, _, text) { return dom.execCommand(cmd, text); },
  createRange() { return { selectNodeContents() {} }; },
};
globalThis.getComputedStyle = () => dom.computedStyle();
globalThis.window.getSelection = () => dom.selection ?? { rangeCount: 0, getRangeAt() {}, removeAllRanges() {}, addRange() {} };

function installDomFakes(overrides) {
  dom = {
    querySelector: () => null,
    execCommand: () => false,
    computedStyle: () => ({ visibility: 'visible', display: 'block', position: 'static' }),
    selection: null,
    ...overrides,
  };
}

// Route a message to the injector listener that handles its action.
// The action travels INSIDE the message (the listeners test message.action).
// Resolves with the sendResponse payload — the ChatGPT listener responds
// asynchronously (its paste is a promise), so this waits for it.
function dispatch(action, message) {
  return new Promise(resolve => {
    for (const l of listeners) {
      l({ ...message, action }, null, v => resolve(v));
    }
  });
}

const { pasteTextToChatGPT } = require('../chatgpt_injector.js');
const { pasteTextToGemini } = require('../gemini_injector.js');

// ─── ChatGPT injector — message listener ─────────────────────────────────────

test('chatgpt: non-string text is rejected with invalid text', async () => {
  const resp = await dispatch('paste_chunk_v2', { text: 42 });
  assert.deepEqual(resp, { success: false, error: 'invalid text' });
});

test('chatgpt: message with string text returns sendResponse from the paste', async () => {
  const textarea = new HTMLTextAreaElement();
  installDomFakes({
    querySelector: (sel) => sel === '#prompt-textarea' ? textarea : null,
    execCommand: () => true,
  });
  const resp = await dispatch('paste_chunk_v2', { text: 'hello' });
  assert.deepEqual(resp, { success: true });
  assert.equal(textarea.focusCalls, 1);
});

// ─── ChatGPT injector — pasteTextToChatGPT ───────────────────────────────────

test('chatgpt: no textarea found returns false', async () => {
  installDomFakes({ querySelector: () => null });
  assert.equal(await pasteTextToChatGPT('text'), false);
});

test('chatgpt: execCommand success returns true', async () => {
  const textarea = new HTMLTextAreaElement();
  installDomFakes({
    querySelector: () => textarea,
    execCommand: () => true,
  });
  assert.equal(await pasteTextToChatGPT('text'), true);
});

test('chatgpt: execCommand failure falls back to value + input/change events', async () => {
  const textarea = new HTMLTextAreaElement();
  installDomFakes({
    querySelector: () => textarea,
    execCommand: () => false,
  });
  assert.equal(await pasteTextToChatGPT('fallback text'), true);
  assert.equal(textarea.value, 'fallback text');
  assert.deepEqual(textarea.events, ['input', 'change']);
});

test('chatgpt: fallback fails when value does not stick', async () => {
  const textarea = new HTMLTextAreaElement();
  // value setter is a no-op — the paste cannot be confirmed.
  Object.defineProperty(textarea, 'value', { get: () => '', set: () => {} });
  installDomFakes({
    querySelector: () => textarea,
    execCommand: () => false,
  });
  assert.equal(await pasteTextToChatGPT('text'), false);
});

// ─── Gemini injector — message listener ──────────────────────────────────────

test('gemini: non-string text is rejected with invalid text', async () => {
  const resp = await dispatch('paste_chunk_gemini', { text: null });
  assert.deepEqual(resp, { success: false, error: 'invalid text' });
});

// ─── Gemini injector — pasteTextToGemini ─────────────────────────────────────

test('gemini: visible contenteditable pastes via execCommand', () => {
  const el = new FakeElement();
  installDomFakes({
    querySelector: () => el,
    execCommand: () => true,
  });
  assert.equal(pasteTextToGemini('text'), true);
  assert.equal(el.focusCalls, 1);
});

test('gemini: skips hidden elements, picks the first visible one', () => {
  const hidden = new FakeElement();
  hidden.offsetParent = null; // hidden (not fixed, no offsetParent)
  const visible = new FakeElement();
  installDomFakes({
    // First selector matches a hidden element; second matches a visible one.
    querySelector: (sel) => sel === 'div[contenteditable="true"]' ? hidden : (sel === 'div[role="textbox"]' ? visible : null),
    execCommand: () => true,
  });
  assert.equal(pasteTextToGemini('text'), true);
  assert.equal(visible.focusCalls, 1);
});

test('gemini: fixed-position element with null offsetParent is still visible', () => {
  const fixed = new FakeElement();
  fixed.offsetParent = null;
  installDomFakes({
    querySelector: () => fixed,
    computedStyle: () => ({ visibility: 'visible', display: 'block', position: 'fixed' }),
    execCommand: () => true,
  });
  assert.equal(pasteTextToGemini('text'), true);
});

test('gemini: no visible element returns false', () => {
  const hidden = new FakeElement();
  hidden.offsetParent = null;
  installDomFakes({
    querySelector: () => hidden,
    computedStyle: () => ({ visibility: 'hidden', display: 'none', position: 'static' }),
    execCommand: () => true,
  });
  assert.equal(pasteTextToGemini('text'), false);
});

test('gemini: textarea fallback sets value and fires input/change when execCommand fails', () => {
  const textarea = new HTMLTextAreaElement();
  installDomFakes({
    querySelector: () => textarea,
    execCommand: () => false,
  });
  assert.equal(pasteTextToGemini('fallback'), true);
  assert.equal(textarea.value, 'fallback');
  assert.deepEqual(textarea.events, ['input', 'change']);
});

test('gemini: contenteditable fallback sets textContent and fires input', () => {
  const el = new FakeElement();
  installDomFakes({
    querySelector: () => el,
    execCommand: () => false,
  });
  assert.equal(pasteTextToGemini('plain'), true);
  assert.equal(el.textContent, 'plain');
  assert.deepEqual(el.events, ['input']);
});

test('gemini: disabled/read-only element with failing execCommand returns false', () => {
  const textarea = new HTMLTextAreaElement();
  textarea.readOnly = true;
  installDomFakes({
    querySelector: () => textarea,
    execCommand: () => false,
  });
  assert.equal(pasteTextToGemini('text'), false);
});
