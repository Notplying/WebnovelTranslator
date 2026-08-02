// Few-shot pool + prompt formatting.
// Run: node --test tests/fewshot.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { installStorageFake } = require('./helpers/storage-fake.js');
const { memory, reset } = installStorageFake();

// fewshot.js consumes store.js's mutate as a browser global (script load
// order in manifest/pages). Mirror that in Node: expose the store exports as
// globals before loading the module under test.
Object.assign(globalThis, require('../store.js'));

const {
  addExample, getExamples, clearExamples,
  addCustomExample, getCustomExamples, removeCustomExample, clearCustomExamples,
  buildExampleMessages, buildExampleTextBlock, dedupeByRaw,
  fitExamplesToContext, selectForShot,
} = require('../fewshot.js');

test.beforeEach(() => reset());

// ─── buildExampleMessages (pure) ───────────────────────────────────────────────

test('buildExampleMessages: alternating user/assistant turns, input order kept', () => {
  const examples = [
    { raw: 'a', translation: 'A' },
    { raw: 'b', translation: 'B' },
  ];
  assert.deepEqual(buildExampleMessages(examples), [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'A' },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: 'B' },
  ]);
});

test('buildExampleMessages: empty input produces empty output', () => {
  assert.deepEqual(buildExampleMessages([]), []);
});

// ─── buildExampleTextBlock (pure) ──────────────────────────────────────────────

test('buildExampleTextBlock: empty input returns empty string', () => {
  assert.equal(buildExampleTextBlock([]), '');
  assert.equal(buildExampleTextBlock(null), '');
  assert.equal(buildExampleTextBlock(undefined), '');
});

test('buildExampleTextBlock: single example wraps in tag block', () => {
  const block = buildExampleTextBlock([{ raw: '你好', translation: 'Hello' }]);
  assert.equal(block, '<Examples>\n<Example>\n<Raw>你好</Raw>\n<Translation>Hello</Translation>\n</Example>\n</Examples>');
});

test('buildExampleTextBlock: multiple examples joined, order kept', () => {
  const block = buildExampleTextBlock([
    { raw: 'r1', translation: 't1' },
    { raw: 'r2', translation: 't2' },
  ]);
  assert.equal(block,
    '<Examples>\n' +
    '<Example>\n<Raw>r1</Raw>\n<Translation>t1</Translation>\n</Example>\n' +
    '<Example>\n<Raw>r2</Raw>\n<Translation>t2</Translation>\n</Example>\n' +
    '</Examples>');
});

// ─── dedupeByRaw (pure) ────────────────────────────────────────────────────────

test('dedupeByRaw: keeps first occurrence of each raw, order preserved', () => {
  const examples = [
    { raw: 'x', translation: '1' },
    { raw: 'y', translation: '2' },
    { raw: 'x', translation: '3' }, // dup — dropped
    { raw: 'z', translation: '4' },
  ];
  assert.deepEqual(dedupeByRaw(examples), [
    { raw: 'x', translation: '1' },
    { raw: 'y', translation: '2' },
    { raw: 'z', translation: '4' },
  ]);
});

test('dedupeByRaw: empty input produces empty output', () => {
  assert.deepEqual(dedupeByRaw([]), []);
});

// ─── fitExamplesToContext (pure) ───────────────────────────────────────────────

test('fitExamplesToContext: budget <= 0 bypasses fitting (returns all)', () => {
  const examples = [{ raw: 'a', translation: 'A' }];
  assert.deepEqual(fitExamplesToContext({ examples, chunkText: 'c', budgetChars: 0 }), examples);
  assert.deepEqual(fitExamplesToContext({ examples, chunkText: 'c', budgetChars: -5 }), examples);
});

test('fitExamplesToContext: chunk alone overflows budget -> empty', () => {
  const examples = [{ raw: 'a', translation: 'A' }];
  assert.deepEqual(fitExamplesToContext({ examples, chunkText: '12345', budgetChars: 5 }), []);
});

test('fitExamplesToContext: drops oldest until the rest fit — keeps newest contiguous block', () => {
  const examples = [
    { raw: 'oldest', translation: 'A' },     // 6 chars
    { raw: 'mid', translation: 'B' },        // 3 chars
    { raw: 'newest', translation: 'C' },     // 7 chars
  ];
  // Budget 12: newest (7) fits, +mid (3) fits, +oldest (6) would overflow -> drop oldest.
  assert.deepEqual(fitExamplesToContext({ examples, chunkText: '', budgetChars: 12 }), [
    { raw: 'mid', translation: 'B' },
    { raw: 'newest', translation: 'C' },
  ]);
});

test('fitExamplesToContext: newest single example alone overflows -> empty', () => {
  const examples = [
    { raw: 'oldest', translation: 'A' },
    { raw: 'huge', translation: 'x'.repeat(100) },
  ];
  assert.deepEqual(fitExamplesToContext({ examples, chunkText: '', budgetChars: 50 }), []);
});

// ─── addExample / getExamples (storage) ────────────────────────────────────────

test('addExample: missing raw or translation is a no-op', async () => {
  await addExample({ raw: '', translation: 't', timestamp: 1 });
  await addExample({ raw: 'r', translation: '', timestamp: 1 });
  assert.equal(memory.get('fewShotExamples'), undefined);
  assert.deepEqual(await getExamples(), []);
});

test('addExample: prepends newest-first and dedupes by raw', async () => {
  await addExample({ raw: 'first', translation: 'T1', timestamp: 100 });
  await addExample({ raw: 'second', translation: 'T2', timestamp: 200 });
  await addExample({ raw: 'first', translation: 'T1-again', timestamp: 300 }); // dup raw
  const examples = await getExamples();
  assert.equal(examples.length, 2);
  assert.equal(examples[0].raw, 'first');   // re-added entry is the newest
  assert.equal(examples[0].timestamp, 300);
  assert.equal(examples[1].raw, 'second');
});

test('addExample: caps to fewShotMaxExamples default of 20', async () => {
  for (let i = 0; i < 25; i++) {
    await addExample({ raw: `r${i}`, translation: `t${i}`, timestamp: i });
  }
  const examples = await getExamples();
  assert.equal(examples.length, 20);
  assert.equal(examples[0].raw, 'r24'); // newest kept
  assert.equal(examples[19].raw, 'r5'); // oldest kept boundary
});

test('addExample: honors stored fewShotMaxExamples (2)', async () => {
  memory.set('fewShotMaxExamples', 2);
  for (let i = 0; i < 5; i++) {
    await addExample({ raw: `r${i}`, translation: `t${i}`, timestamp: i });
  }
  assert.deepEqual((await getExamples()).map(e => e.raw), ['r4', 'r3']);
});

test('addExample: fewShotMaxExamples of 0 clamps to 1 (pool never empties)', async () => {
  memory.set('fewShotMaxExamples', 0);
  for (let i = 0; i < 3; i++) {
    await addExample({ raw: `r${i}`, translation: `t${i}`, timestamp: i });
  }
  const examples = await getExamples();
  assert.equal(examples.length, 1);
  assert.equal(examples[0].raw, 'r2');
});

test('getExamples: non-array stored value coerces to empty array', async () => {
  memory.set('fewShotExamples', 'garbage');
  assert.deepEqual(await getExamples(), []);
});

test('clearExamples: empties the auto pool', async () => {
  await addExample({ raw: 'r', translation: 't', timestamp: 1 });
  await clearExamples();
  assert.deepEqual(await getExamples(), []);
});

// ─── addCustomExample / getCustomExamples (storage) ────────────────────────────

test('addCustomExample: appends in insertion order and returns entry id', async () => {
  const id1 = await addCustomExample({ raw: 'a', translation: 'A', timestamp: 10 });
  const id2 = await addCustomExample({ raw: 'b', translation: 'B', timestamp: 20 });
  const examples = await getCustomExamples();
  assert.equal(examples.length, 2);
  assert.equal(examples[0].raw, 'a');
  assert.equal(examples[1].raw, 'b');
  assert.equal(examples[0].id, id1);
  assert.equal(examples[1].id, id2);
});

test('addCustomExample: missing raw or translation returns null, stores nothing', async () => {
  assert.equal(await addCustomExample({ raw: '', translation: 't', timestamp: 1 }), null);
  assert.equal(await addCustomExample({ raw: 'r', translation: '', timestamp: 1 }), null);
  assert.deepEqual(await getCustomExamples(), []);
});

test('removeCustomExample: removes by id, keeps the rest in order', async () => {
  await addCustomExample({ raw: 'a', translation: 'A', timestamp: 1 });
  const id2 = await addCustomExample({ raw: 'b', translation: 'B', timestamp: 2 });
  await addCustomExample({ raw: 'c', translation: 'C', timestamp: 3 });
  await removeCustomExample(id2);
  assert.deepEqual((await getCustomExamples()).map(e => e.raw), ['a', 'c']);
});

test('clearCustomExamples: empties the custom pool', async () => {
  await addCustomExample({ raw: 'a', translation: 'A', timestamp: 1 });
  await clearCustomExamples();
  assert.deepEqual(await getCustomExamples(), []);
});

// ─── selectForShot (selection rules) ───────────────────────────────────────────

test('selectForShot: custom fills a slot, rest from auto newest; output chronological', async () => {
  memory.set('fewShotCount', 3);
  await addCustomExample({ raw: 'c1', translation: 'C1', timestamp: 50 });
  await addExample({ raw: 'a1', translation: 'A1', timestamp: 10 });
  await addExample({ raw: 'a2', translation: 'A2', timestamp: 20 });
  await addExample({ raw: 'a3', translation: 'A3', timestamp: 30 });
  // Chosen set: custom c1 + the 2 newest auto (a3, a2) — a1 starved. Then sorted oldest->newest.
  const selected = await selectForShot({ maxBudgetChars: 0 });
  assert.deepEqual(selected.map(e => e.raw), ['a2', 'a3', 'c1']);
});

test('selectForShot: custom pool exceeding fewShotCount keeps newest customs', async () => {
  memory.set('fewShotCount', 2);
  await addCustomExample({ raw: 'old', translation: 'O', timestamp: 10 });
  await addCustomExample({ raw: 'mid', translation: 'M', timestamp: 20 });
  await addCustomExample({ raw: 'new', translation: 'N', timestamp: 30 });
  const selected = await selectForShot({ maxBudgetChars: 0 });
  assert.deepEqual(selected.map(e => e.raw), ['mid', 'new']);
});

test('selectForShot: custom wins over auto on duplicate raw', async () => {
  memory.set('fewShotCount', 3);
  await addCustomExample({ raw: 'same', translation: 'CUSTOM', timestamp: 10 });
  await addExample({ raw: 'same', translation: 'AUTO', timestamp: 20 });
  const selected = await selectForShot({ maxBudgetChars: 0 });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].translation, 'CUSTOM');
});

test('selectForShot: orders selected examples oldest -> newest', async () => {
  memory.set('fewShotCount', 3);
  await addExample({ raw: 'a-new', translation: 'A', timestamp: 300 });
  await addExample({ raw: 'b-old', translation: 'B', timestamp: 100 });
  await addCustomExample({ raw: 'c-mid', translation: 'C', timestamp: 200 });
  const selected = await selectForShot({ maxBudgetChars: 0 });
  assert.deepEqual(selected.map(e => e.raw), ['b-old', 'c-mid', 'a-new']);
});

test('selectForShot: applies context fitting when budget set', async () => {
  memory.set('fewShotCount', 5);
  await addExample({ raw: 'zzzzzzzzzz', translation: 'zzzzzzzzzz', timestamp: 100 }); // 20 chars, oldest
  await addCustomExample({ raw: 'x', translation: 'Y', timestamp: 200 });            // 2 chars, newest
  // Budget 15: newest 2-char custom fits; the older 20-char auto example does not.
  const selected = await selectForShot({ maxBudgetChars: 15, chunkText: '' });
  assert.deepEqual(selected.map(e => e.raw), ['x']);
});

test('selectForShot: no examples anywhere -> empty selection', async () => {
  memory.set('fewShotCount', 3);
  assert.deepEqual(await selectForShot({ maxBudgetChars: 0 }), []);
});
