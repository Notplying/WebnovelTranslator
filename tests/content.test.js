// Content extraction + chunking (content.js).
// Run: node --test tests/content.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

// content.js reads bare browser.* globals at load time (auto-run extraction
// kickoff) and bare document globals inside splitParagraphText — mirror both
// on globalThis like the page does.
const sent = [];
globalThis.browser = {
  storage: { local: { async get() { return { maxLength: undefined, prefix: '', suffix: '', retryCount: 3 }; } } },
  runtime: { async sendMessage(msg) { sent.push(msg); } },
};

const Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
globalThis.Node = Node;

// A document fixture must exist before require: the module's load-time
// kickoff runs splitParagraphText immediately (missing DOM -> caught error).
installDocument({ '.text-left': element('div', { childNodes: [textNode('boot')] }) });

const { splitParagraphText, splitTextIntoChunks } = require('../content.js');

// ─── Fake DOM building blocks ─────────────────────────────────────────────────

function element(tag, { innerHTML = '', textContent = '', childNodes = [], outerHTML } = {}) {
  return {
    nodeType: Node.ELEMENT_NODE,
    tagName: tag.toUpperCase(),
    innerHTML,
    textContent: textContent !== '' ? textContent : innerHTML,
    childNodes,
    outerHTML: outerHTML ?? `<${tag}>${innerHTML}</${tag}>`,
    querySelectorAll() { return []; },
  };
}

function textNode(value) {
  return { nodeType: Node.TEXT_NODE, textContent: value };
}

// document stub routing querySelector / getElementById to prepared fixtures.
function installDocument(fixtures) {
  globalThis.document = {
    querySelector(sel) { return fixtures[sel] ?? null; },
    getElementById(id) { return fixtures.ids?.[id] ?? null; },
  };
}

// ─── splitTextIntoChunks (pure) ────────────────────────────────────────────────

test('splitTextIntoChunks: text shorter than maxLength -> single chunk', () => {
  assert.deepEqual(splitTextIntoChunks('short text', 4000), ['short text']);
});

test('splitTextIntoChunks: empty text -> no chunks', () => {
  assert.deepEqual(splitTextIntoChunks('', 4000), []);
});

test('splitTextIntoChunks: cuts at the last newline inside the window (paragraph-safe)', () => {
  const text = 'aaaa\nbbbb\ncccc\ndddd\neeee\nffff';
  const chunks = splitTextIntoChunks(text, 10);
  // The newline is the boundary — excluded from the chunk, skipped in the next.
  assert.deepEqual(chunks, ['aaaa\nbbbb', 'cccc\ndddd', 'eeee\nffff']);
});

test('splitTextIntoChunks: hard-cuts mid-paragraph when no newline fits, no text lost', () => {
  const chunks = splitTextIntoChunks('abcdefghij', 4);
  assert.deepEqual(chunks, ['abcd', 'efgh', 'ij']);
});

test('splitTextIntoChunks: boundary at exactly maxLength is a single clean chunk', () => {
  assert.deepEqual(splitTextIntoChunks('abcd\nefgh', 5), ['abcd', 'efgh']);
});

test('splitTextIntoChunks: newline before the window start is not a cut point (no empty chunk loop)', () => {
  // max 2: the \n at index 3 is a cut point, but index 7's window [4,6) has
  // no newline — lastIndexOf must not reach back before startIndex.
  assert.deepEqual(splitTextIntoChunks('aaa\nbbb\nccc', 2), ['aa', 'a', 'bb', 'b', 'cc', 'c']);
});

test('splitTextIntoChunks: chunk size never exceeds maxLength', () => {
  const chunks = splitTextIntoChunks('a'.repeat(30), 7);
  for (const c of chunks) assert.ok(c.length <= 7);
});

// ─── splitParagraphText — .text-left site path ────────────────────────────────

test('splitParagraphText: .text-left — paragraphs, text-node ]-split, and images', () => {
  const textLeft = element('div', { childNodes: [
    element('p', { innerHTML: 'para one' }),
    textNode('segA]segB]segC'),
    element('img', { outerHTML: '<img src="x.png">' }),
  ] });
  installDocument({ '.text-left': textLeft });
  const chunks = splitParagraphText(4000);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0],
    'para one\n\nsegA]\n\nsegB]\n\nsegC\n\n<img src="x.png">\n\n');
});

test('splitParagraphText: .text-left — skipped text node has no trailing ] suffix on final segment', () => {
  const textLeft = element('div', { childNodes: [textNode('one]two')] });
  installDocument({ '.text-left': textLeft });
  assert.equal(splitParagraphText(4000)[0], 'one]\n\ntwo\n\n');
});

test('splitParagraphText: .text-left — blank text nodes skipped, chunks respect maxLength', () => {
  const textLeft = element('div', { childNodes: [textNode('  '), element('p', { innerHTML: 'line one\n\nline two' })] });
  installDocument({ '.text-left': textLeft });
  const chunks = splitParagraphText(10);
  assert.equal(chunks[0], 'line one\n');
  assert.equal(chunks[1], 'line two\n\n');
});

// ─── splitParagraphText — #novel_content site path ────────────────────────────

test('splitParagraphText: #novel_content — nested divs recurse p/img/text', () => {
  const innerP = element('p', { innerHTML: 'deep text' });
  const innerDiv = element('div', { childNodes: [innerP, textNode('loose text')] });
  const wrapper = element('div', { childNodes: [innerDiv, element('img', { outerHTML: '<img src="y.png">' })] });
  const container = {
    ...element('div'),
    querySelectorAll(sel) { return sel === 'div' ? [wrapper] : []; },
  };
  installDocument({ '#novel_content': container });
  const chunks = splitParagraphText(4000);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], 'deep text\n\nloose text\n\n<img src="y.png">\n\n');
});

// ─── splitParagraphText — novel543 .content.py-5 site path ────────────────────

test('splitParagraphText: .content.py-5 — h1 plus direct <p> children only', () => {
  const h1 = element('h1', { textContent: 'Chapter Title' });
  const directPs = [
    element('p', { textContent: 'first paragraph' }),
    element('p', { textContent: 'second paragraph' }),
  ];
  const contentEl = {
    ...element('div'),
    querySelectorAll(sel) { return sel === ':scope > p' ? directPs : []; },
  };
  installDocument({ 'h1': h1, '.content.py-5': contentEl });
  const chunks = splitParagraphText(4000);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], 'Chapter Title\n\nfirst paragraph\n\nsecond paragraph\n\n');
});

test('splitParagraphText: .content.py-5 — missing h1 does not break extraction', () => {
  const directPs = [element('p', { textContent: 'only paragraph' })];
  const contentEl = {
    ...element('div'),
    querySelectorAll(sel) { return sel === ':scope > p' ? directPs : []; },
  };
  installDocument({ 'h1': null, '.content.py-5': contentEl });
  assert.equal(splitParagraphText(4000)[0], 'only paragraph\n\n');
});

// ─── splitParagraphText — fallback pN/LN id path ──────────────────────────────

test('splitParagraphText: fallback — p1..pN ids until one is missing', () => {
  installDocument({ ids: { p1: element('p', { innerHTML: 'first' }), p2: element('p', { innerHTML: 'second' }) } });
  const chunks = splitParagraphText(4000);
  assert.equal(chunks[0], 'first\n\nsecond\n\n');
});

test('splitParagraphText: fallback — L1..LN ids used when pN missing', () => {
  installDocument({ ids: { L1: element('p', { innerHTML: 'legacy one' }) } });
  assert.equal(splitParagraphText(4000)[0], 'legacy one\n\n');
});

test('splitParagraphText: no known container -> empty chunks, no crash', () => {
  installDocument({});
  assert.deepEqual(splitParagraphText(4000), []);
});

// ─── splitParagraphText — maxLength handling ──────────────────────────────────

test('splitParagraphText: maxLength 0 falls back to 4000 default', () => {
  installDocument({ '.text-left': element('div', { childNodes: [element('p', { innerHTML: 'x'.repeat(5000) })] }) });
  const chunks = splitParagraphText(0);
  assert.equal(chunks[0].length, 4000);
});

test('splitParagraphText: negative maxLength clamps to 1 — no text lost', () => {
  installDocument({ '.text-left': element('div', { childNodes: [element('p', { innerHTML: 'abc' })] }) });
  const chunks = splitParagraphText(-5);
  // Boundary newlines are consumed as separators; all other chars preserved.
  assert.equal(chunks.join(''), 'abc\n');
  assert.ok(chunks.every(c => c.length <= 1));
});

test('splitParagraphText: non-numeric maxLength falls back to 4000', () => {
  installDocument({ '.text-left': element('div', { childNodes: [element('p', { innerHTML: 'x'.repeat(5000) })] }) });
  assert.equal(splitParagraphText('abc')[0].length, 4000);
});

// ─── load-time kickoff ────────────────────────────────────────────────────────

test('module load: auto-kickoff sends openChunksPage with extracted chunks', async () => {
  // The auto-run block executes on require; wait for its async chain.
  await new Promise(r => setTimeout(r, 20));
  assert.ok(sent.some(m => m.action === 'openChunksPage' && Array.isArray(m.chunks)));
});
