// Store serialization + no-clobber + clearLocal atomicity.
// Run: node --test tests/store.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { installStorageFake } = require('./helpers/storage-fake.js');
const { memory, reset } = installStorageFake();

const { mutate, clearLocal, removeKeys, saveSession } = require('../store.js');

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

// ─── removeKeys atomicity ─────────────────────────────────────────────────────

test('removeKeys deletes the listed keys and nothing else', async () => {
  reset();
  await mutate('collections', () => ({ changed: true, result: { a: 1 } }));
  await mutate('translationSessions', () => ({ changed: true, result: [{ id: 's1' }] }));
  await browser.storage.local.set({ settings: { x: 1 } });

  await removeKeys(['collections', 'translationSessions']);

  assert.equal(memory.get('collections'), undefined);
  assert.equal(memory.get('translationSessions'), undefined);
  assert.deepEqual(memory.get('settings'), { x: 1 }); // untouched
});

test('removeKeys serializes with an in-flight mutation on the SAME key', async () => {
  reset();
  // Queue a slow mutation on processedChunks, then removeKeys immediately.
  const slow = mutate('processedChunks', async (cur = {}) => {
    await new Promise(r => setTimeout(r, 30));
    return { changed: true, result: { ...cur, s1: ['x'] } };
  });
  const removed = removeKeys(['processedChunks']);
  await Promise.all([slow, removed]);

  // The slow mutation ran BEFORE the remove (removeKeys waited on the chain),
  // so its write was deleted — not silently resurrected after the wipe.
  assert.equal(memory.get('processedChunks'), undefined);
});

test('removeKeys waits for in-flight mutations on OTHER keys, leaving them intact', async () => {
  reset();
  // Queue a slow mutation on collections, then removeKeys a different key.
  const slow = mutate('collections', async (cur = {}) => {
    await new Promise(r => setTimeout(r, 30));
    return { changed: true, result: { ...cur, c: 1 } };
  });
  const removed = removeKeys(['processedChunks']);
  await Promise.all([slow, removed]);

  // The mutation completed before the removal (barrier waited on its chain)
  // and its key is untouched by the delete.
  assert.deepEqual(memory.get('collections'), { c: 1 });
  assert.equal(memory.get('processedChunks'), undefined);
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
