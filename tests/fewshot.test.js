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
