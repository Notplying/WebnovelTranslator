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

// ─── splitParagraphText — 69shuba .txtnav site path ───────────────────────────
// 69shuba.com: chapter title in <h1>, body as bare text-node paragraphs
// separated by <br>, with meta (.txtinfo) and ad (#txtright, .contentadv,
// .bottom-ad) divs interleaved. See "example format.htm".

test('splitParagraphText: .txtnav — h1 title + paragraph grouping, ads/meta skipped', () => {
  const h1 = element('h1', { textContent: '第424章 改造神之橱窗' });
  const txtnav = {
    ...element('div', { childNodes: [
      textNode('\n            '),                                      // leading whitespace
      h1,
      textNode('\n            '),
      element('div', { innerHTML: '<span>2024-09-06</span> 作者' }),  // .txtinfo meta
      textNode('\n            '),
      element('div', { innerHTML: '<script>loadAdv(2, 0)</script>' }), // #txtright ad
      textNode('\n            '),
      textNode('\n            　　\t\t第424章 改造神之橱窗\n'),          // title repeat
      element('br'), element('br'),
      textNode('\n            　　白疫左右看了看。\n'),
      element('br'), element('br'),
      textNode('\n            　　这地方是'),                            // single-br join
      element('br'),
      textNode('\n            　　白疫记忆中有一个地方盛产时空石。\n'),
      element('br'), element('br'),
      textNode('\n            　　女子微微皱眉，似乎在思考着什么。\n'),
    ] }),
    querySelector(sel) { return sel === 'h1' ? h1 : null; },
  };
  installDocument({ '.txtnav': txtnav });
  const chunks = splitParagraphText(4000);
  assert.equal(chunks.length, 1);
  // Title emitted once from <h1>; the title text-node repeat is deduped;
  // meta + ad divs never appear; a single <br> joins one paragraph.
  assert.equal(chunks[0],
    '第424章 改造神之橱窗\n\n' +
    '白疫左右看了看。\n\n' +
    '这地方是 白疫记忆中有一个地方盛产时空石。\n\n' +
    '女子微微皱眉，似乎在思考着什么。\n\n');
});

test('splitParagraphText: .txtnav — mid-content ad divs and blanks add no paragraphs', () => {
  const h1 = element('h1', { textContent: '第五十一章 山雨欲来' });
  const txtnav = {
    ...element('div', { childNodes: [
      h1,
      textNode('\n            '),
      // single <br> joins line-continuations inside a paragraph
      textNode('\n            　　风声渐紧，'),
      element('br'),
      textNode('\n            　　山雨欲来。\n'),
      element('br'), element('br'),
      textNode(''),                                                   // blank text node
      element('div', { innerHTML: '<script>loadAdv(7, 3)</script>' }), // .contentadv ad
      element('br'), element('br'),
      textNode('\n            　　\t\t雨点砸在青石板上。\n'),
      element('br'), element('br'),
      element('div', { innerHTML: '<script>loadAdv(3, 0)</script>' }), // .bottom-ad
      textNode('\n'),
    ] }),
    querySelector(sel) { return sel === 'h1' ? h1 : null; },
  };
  installDocument({ '.txtnav': txtnav });
  const chunks = splitParagraphText(4000);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0],
    '第五十一章 山雨欲来\n\n' +
    '风声渐紧， 山雨欲来。\n\n' +
    '雨点砸在青石板上。\n\n');
});

test('splitParagraphText: .txtnav — first paragraph differing from h1 is kept', () => {
  const h1 = element('h1', { textContent: '第三章 初入江湖' });
  const txtnav = {
    ...element('div', { childNodes: [
      h1,
      textNode(''),                                                   // h1 has no text repeat
      textNode('\n            　　\t\t天色微明，城门缓缓打开。\n'),
    ] }),
    querySelector(sel) { return sel === 'h1' ? h1 : null; },
  };
  installDocument({ '.txtnav': txtnav });
  const chunks = splitParagraphText(4000);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], '第三章 初入江湖\n\n天色微明，城门缓缓打开。\n\n');
});

test('splitParagraphText: .txtnav — no h1 falls back to text node paragraphs only', () => {
  const txtnav = {
    ...element('div', { childNodes: [
      textNode('\n            　　\t\t没有标题，只有正文。\n'),
      element('br'), element('br'),
      textNode('\n            　　\t\t第二段。\n'),
    ] }),
    querySelector(sel) { return null; },
  };
  installDocument({ '.txtnav': txtnav });
  const chunks = splitParagraphText(4000);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], '没有标题，只有正文。\n\n第二段。\n\n');
});

test('splitParagraphText: .txtnav — chunks respect maxLength like other paths', () => {
  const h1 = element('h1', { textContent: '第一章' });
  const txtnav = {
    ...element('div', { childNodes: [
      h1,
      textNode('　　　　一二三四五六七八九十'),
    ] }),
    querySelector(sel) { return sel === 'h1' ? h1 : null; },
  };
  installDocument({ '.txtnav': txtnav });
  const chunks = splitParagraphText(8);
  // Combined = '第一章\n\n一二三四五六七八九十\n\n'. The window of 8 reaches
  // the second \n (index 4), which becomes the consumed boundary; the final
  // chunk keeps the extractor's trailing '\n\n'.
  assert.deepEqual(chunks, ['第一章\n', '一二三四五六七八', '九十\n\n']);
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
