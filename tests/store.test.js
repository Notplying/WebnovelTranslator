// Store serialization + no-clobber + clearLocal atomicity.
// Run: node --test tests/store.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Fake browser.storage.local with an explicit microtask gap inside get() so
// the tests genuinely interleave two get→mutate→set sequences the way the
// real API does across contexts.
const memory = new Map();
let deferreds = [];
globalThis.browser = {
  storage: {
    local: {
      async get(keys) {
        await new Promise(r => setTimeout(r, 0));
        if (keys === null) return Object.fromEntries(memory);
        if (typeof keys === 'string') return { [keys]: memory.get(keys) };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map(k => [k, memory.get(k)]));
        return Object.fromEntries(Object.keys(keys).map(k => [k, memory.get(k)]));
      },
      async set(obj) {
        await new Promise(r => setTimeout(r, 0));
        for (const [k, v] of Object.entries(obj)) memory.set(k, v);
      },
      async clear() {
        await new Promise(r => setTimeout(r, 0));
        memory.clear();
      },
      async remove(keys) {
        await new Promise(r => setTimeout(r, 0));
        const list = Array.isArray(keys) ? keys : [keys];
        list.forEach(k => memory.delete(k));
      },
    },
  },
};

const { mutate, clearLocal, saveSession } = require('../store.js');

function reset() {
  memory.clear();
  deferreds = [];
}

// ─── serialization ─────────────────────────────────────────────────────────────

test('two concurrent mutates on the same key serialize (no dropped write)', async () => {
  reset();
  await mutate('collections', () => ({ changed: true, result: { a: 1 } }));

  // Fire two appends concurrently — without serialization both would read the
  // pre-append value and one write would be lost.
  const p1 = mutate('collections', (cur = {}) => ({ changed: true, result: { ...cur, b: 2 } }));
  const p2 = mutate('collections', (cur = {}) => ({ changed: true, result: { ...cur, c: 3 } }));
  await Promise.all([p1, p2]);

  assert.deepEqual(memory.get('collections'), { a: 1, b: 2, c: 3 });
});

test('mutations on different keys run independently', async () => {
  reset();
  const p1 = mutate('k1', () => ({ changed: true, result: 'x' }));
  const p2 = mutate('k2', () => ({ changed: true, result: 'y' }));
  await Promise.all([p1, p2]);
  assert.equal(memory.get('k1'), 'x');
  assert.equal(memory.get('k2'), 'y');
});

test('a rejected mutator does not poison the key chain', async () => {
  reset();
  await assert.rejects(
    mutate('collections', () => { throw new Error('boom'); })
  );
  // Next mutation on the same key must still run.
  const ok = await mutate('collections', (cur = {}) => ({ changed: true, result: { ...cur, ok: true } }));
  assert.deepEqual(memory.get('collections'), { ok: true });
  assert.deepEqual(ok, { changed: true, result: { ok: true } });
});

// ─── { changed, note } contract ────────────────────────────────────────────────

test('changed:false skips the write and carries the note', async () => {
  reset();
  await mutate('collections', () => ({ changed: true, result: { a: 1 } }));
  const out = await mutate('collections', (cur) => ({ changed: false, note: 'alreadyPresent' }));
  assert.deepEqual(out, { changed: false, note: 'alreadyPresent' });
  assert.deepEqual(memory.get('collections'), { a: 1 }); // unchanged
});

test('changed:true writes and resolves { changed: true, result }', async () => {
  reset();
  const out = await mutate('collections', () => ({ changed: true, result: { a: 1 } }));
  assert.deepEqual(out, { changed: true, result: { a: 1 } });
  assert.deepEqual(memory.get('collections'), { a: 1 });
});

// ─── saveSession eviction ──────────────────────────────────────────────────────

test('saveSession upserts and evicts to maxSessions, newest first', async () => {
  reset();
  await browser.storage.local.set({ maxSessions: 2 });
  await saveSession('s1', { chunks: ['a'], prefix: '' });
  await saveSession('s2', { chunks: ['b'], prefix: '' });
  await saveSession('s3', { chunks: ['c'], prefix: '' });
  const { translationSessions } = await browser.storage.local.get('translationSessions');
  assert.equal(translationSessions.length, 2);
  assert.equal(translationSessions[0].id, 's3'); // newest first
  assert.ok(['s1', 's2'].includes(translationSessions[1].id));
});

// ─── clearLocal atomicity ──────────────────────────────────────────────────────

test('clearLocal waits for in-flight mutations on any key', async () => {
  reset();
  await mutate('collections', () => ({ changed: true, result: { a: 1 } }));

  // Queue a slow mutation on a DIFFERENT key, then clearLocal immediately.
  const slow = mutate('translationSessions', async (cur = []) => {
    await new Promise(r => setTimeout(r, 30));
    return { changed: true, result: [...cur, { id: 'x' }] };
  });
  const cleared = clearLocal();
  await Promise.all([slow, cleared]);

  // The slow mutation ran BEFORE the clear (clearLocal waited), so its write
  // was not silently lost after the wipe — storage is empty of it only if the
  // clear won, and the mutation landed first. Verify the write did land pre-clear:
  assert.equal(memory.get('translationSessions'), undefined);
  // And that a post-clear write still works.
  await mutate('collections', () => ({ changed: true, result: { b: 2 } }));
  assert.deepEqual(memory.get('collections'), { b: 2 });
});
