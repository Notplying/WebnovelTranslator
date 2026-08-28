// Shared HTML escaping helpers.
// Run: node --test tests/utils.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { escapeHtml, decodeHtmlEntities } = require('../utils.js');

test('escapeHtml escapes & < > " — the safe superset both pages render with', () => {
  assert.equal(escapeHtml(`a&b<c>d"e`), 'a&amp;b&lt;c&gt;d&quot;e');
});

test('escapeHtml returns empty string for null/undefined instead of throwing', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
});

test('escapeHtml double-escapes already-escaped input — callers decode first', () => {
  // Not idempotent by design: renderMarkdown decodes entities before escaping,
  // so literal characters are always escaped once.
  assert.equal(escapeHtml(escapeHtml(`a<b`)), 'a&amp;lt;b');
});

test('decodeHtmlEntities reverses escapeHtml plus &#39;', () => {
  assert.equal(decodeHtmlEntities('&amp; &lt; &gt; &quot; &#39;'), `& < > " '`);
});

test('decode + escape round-trip restores the literal string', () => {
  const original = `line1 & <tag> "quoted" 'apos'\nline2`;
  assert.equal(decodeHtmlEntities(escapeHtml(original)), original);
});
