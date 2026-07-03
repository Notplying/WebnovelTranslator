const test = require('node:test');
const assert = require('node:assert');

// ─── In-memory browser.storage.local mock ───────────────────────────────────
const store = {};
global.browser = {
  storage: {
    local: {
      async get(keys) {
        if (keys === null || keys === undefined) return { ...store };
        const ks = typeof keys === 'string' ? [keys] : keys;
        const out = {};
        for (const k of ks) if (k in store) out[k] = store[k];
        return out;
      },
      async set(obj) { Object.assign(store, obj); },
    },
  },
};

// Set defaults the module expects to read
store.fewShotMaxExamples = 20;
store.fewShotCount = 3;

const FewShot = require('../fewshot.js');

test('addExample stores a pair newest-first', async () => {
  store.fewShotExamples = [];
  await FewShot.addExample({ raw: 'a', translation: 'A', timestamp: 1 });
  await FewShot.addExample({ raw: 'b', translation: 'B', timestamp: 2 });
  const got = await FewShot.getExamples();
  assert.equal(got.length, 2);
  assert.equal(got[0].raw, 'b');      // newest first
  assert.equal(got[1].raw, 'a');
});

test('addExample dedupes by raw text', async () => {
  store.fewShotExamples = [];
  await FewShot.addExample({ raw: 'dup', translation: 'first', timestamp: 1 });
  await FewShot.addExample({ raw: 'dup', translation: 'second', timestamp: 2 });
  const got = await FewShot.getExamples();
  assert.equal(got.length, 1);
  assert.equal(got[0].translation, 'second');  // re-added bumps to front with new translation
});

test('addExample caps to fewShotMaxExamples, dropping oldest', async () => {
  store.fewShotMaxExamples = 3;
  store.fewShotExamples = [];
  await FewShot.addExample({ raw: '1', translation: 't', timestamp: 1 });
  await FewShot.addExample({ raw: '2', translation: 't', timestamp: 2 });
  await FewShot.addExample({ raw: '3', translation: 't', timestamp: 3 });
  await FewShot.addExample({ raw: '4', translation: 't', timestamp: 4 });
  const got = await FewShot.getExamples();
  assert.equal(got.length, 3);
  assert.deepEqual(got.map(e => e.raw), ['4', '3', '2']);  // oldest ('1') dropped
});

test('clearExamples removes the auto pool only', async () => {
  store.fewShotExamples = [{ id: '1', raw: 'a', translation: 'A', timestamp: 1 }];
  store.fewShotCustomExamples = [{ id: 'c1', raw: 'c', translation: 'C', timestamp: 9 }];
  await FewShot.clearExamples();
  const got = await FewShot.getExamples();
  assert.equal(got.length, 0);
  const custom = await FewShot.getCustomExamples();
  assert.equal(custom.length, 1);  // custom untouched
});

test('custom examples: add in insertion order, remove by id, clear independently', async () => {
  store.fewShotCustomExamples = [];
  await FewShot.addCustomExample({ raw: 'r1', translation: 't1', timestamp: 1 });
  await FewShot.addCustomExample({ raw: 'r2', translation: 't2', timestamp: 2 });
  let custom = await FewShot.getCustomExamples();
  assert.deepEqual(custom.map(c => c.raw), ['r1', 'r2']);  // insertion order
  await FewShot.removeCustomExample(custom[0].id);
  custom = await FewShot.getCustomExamples();
  assert.deepEqual(custom.map(c => c.raw), ['r2']);
  await FewShot.clearCustomExamples();
  custom = await FewShot.getCustomExamples();
  assert.equal(custom.length, 0);
});

test('clearCustomExamples does not touch the auto pool', async () => {
  store.fewShotExamples = [{ id: 'x', raw: 'a', translation: 'A', timestamp: 1 }];
  store.fewShotCustomExamples = [{ id: 'c', raw: 'c', translation: 'C', timestamp: 9 }];
  await FewShot.clearCustomExamples();
  assert.equal((await FewShot.getCustomExamples()).length, 0);
  assert.equal((await FewShot.getExamples()).length, 1);
});

const { buildExampleMessages, buildExampleTextBlock, dedupeByRaw,
        fitExamplesToContext, selectForShot } = require('../fewshot.js');

const EX = [
  { id: '1', raw: 'raw-A', translation: 'trans-A', timestamp: 100 },
  { id: '2', raw: 'raw-B', translation: 'trans-B', timestamp: 200 },
  { id: '3', raw: 'raw-C', translation: 'trans-C', timestamp: 300 },
];

test('buildExampleMessages alternates user/assistant, newest last', () => {
  const msgs = buildExampleMessages(EX);
  assert.equal(msgs.length, 6);
  assert.deepEqual(msgs.map(m => m.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  assert.equal(msgs[0].content, 'raw-A');
  assert.equal(msgs[1].content, 'trans-A');
  assert.equal(msgs[5].content, 'trans-C');  // newest pair, assistant turn last
});

test('buildExampleMessages empty input returns []', () => {
  assert.deepEqual(buildExampleMessages([]), []);
});

test('buildExampleTextBlock wraps pairs in <Examples> tags', () => {
  const block = buildExampleTextBlock([EX[0]]);
  assert.ok(block.startsWith('<Examples>'));
  assert.ok(block.endsWith('</Examples>'));
  assert.ok(block.includes('<Raw>raw-A</Raw>'));
  assert.ok(block.includes('<Translation>trans-A</Translation>'));
});

test('buildExampleTextBlock empty input returns empty string', () => {
  assert.equal(buildExampleTextBlock([]), '');
});

test('dedupeByRaw keeps first occurrence', () => {
  const dup = [{ raw: 'x', translation: '1', timestamp: 1 }, { raw: 'x', translation: '2', timestamp: 2 }];
  assert.deepEqual(dedupeByRaw(dup).map(e => e.translation), ['1']);
});

test('fitExamplesToContext bypass when budgetChars <= 0', () => {
  const out = fitExamplesToContext({ examples: EX, chunkText: 'bigchunk', budgetChars: 0 });
  assert.equal(out.length, 3);
});

test('fitExamplesToContext drops oldest to fit budget', () => {
  // Each EX pair is 12 chars (e.g. raw-A=5 + trans-A=7). budget 30, chunk 'thirteenchars'
  // (13 chars) → available = 17 → fits ONE pair (12), not two (24). Newest (raw-C) kept.
  const out = fitExamplesToContext({ examples: EX, chunkText: 'thirteenchars', budgetChars: 30 });
  assert.equal(out.length, 1);
  assert.equal(out[0].raw, 'raw-C');
});

test('fitExamplesToContext drops all when chunk alone overflows', () => {
  const out = fitExamplesToContext({ examples: EX, chunkText: 'x'.repeat(100), budgetChars: 30 });
  assert.equal(out.length, 0);
});

test('selectForShot merges custom-first + auto-newest, caps, orders newest last', async () => {
  store.fewShotCount = 3;
  store.fewShotMaxExamples = 20;
  store.fewShotCustomExamples = [
    { id: 'c1', raw: 'custom-1', translation: 'c1-t', timestamp: 50 },
    { id: 'c2', raw: 'custom-2', translation: 'c2-t', timestamp: 250 },
  ];
  store.fewShotExamples = [
    { id: 'a1', raw: 'auto-1', translation: 'a1-t', timestamp: 300 },  // newest
    { id: 'a2', raw: 'auto-2', translation: 'a2-t', timestamp: 100 },
  ];
  const out = await selectForShot({ maxBudgetChars: 0, chunkText: '' });  // bypass fit
  assert.equal(out.length, 3);  // 2 custom + 1 auto (count=3)
  // newest last: timestamps 50(c1), 100(a2), 250(c2), 300(a1) → but count cap=3 keeps custom-first
  // Keep set = [c1, c2, a1(newest auto)]; sorted by timestamp asc => [c1(50), a2?...]
  // Actually: remaining after custom = count-len(custom) = 1; auto taken = [newest auto = a1]
  // kept = [c1, c2, a1]; sorted asc => [c1(50), c2(250), a1(300)] → newest (a1) last
  assert.deepEqual(out.map(e => e.id), ['c1', 'c2', 'a1']);
});

test('selectForShot dedupes by raw across custom+auto (custom wins)', async () => {
  store.fewShotCount = 5;
  store.fewShotCustomExamples = [{ id: 'c1', raw: 'shared', translation: 'custom-ver', timestamp: 10 }];
  store.fewShotExamples = [{ id: 'a1', raw: 'shared', translation: 'auto-ver', timestamp: 999 }];
  const out = await selectForShot({ maxBudgetChars: 0, chunkText: '' });
  assert.equal(out.length, 1);
  assert.equal(out[0].translation, 'custom-ver');  // custom wins
});

test('selectForShot returns [] when fewShotCount is 0', async () => {
  store.fewShotCount = 0;
  store.fewShotCustomExamples = [{ id: 'c1', raw: 'x', translation: 'y', timestamp: 1 }];
  store.fewShotExamples = [];
  const out = await selectForShot({ maxBudgetChars: 0, chunkText: '' });
  assert.equal(out.length, 0);
});
