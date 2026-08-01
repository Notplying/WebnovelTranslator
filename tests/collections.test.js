// Collections domain: model rules + serialized mutations.
// Run: node --test tests/collections.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Same fake browser.storage.local as store.test.js — microtask gap in get()
// so serialization through the store is exercised for real.
const memory = new Map();
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

// collections.js consumes store.js's mutate as a browser global (script load
// order in manifest/pages). Mirror that in Node: expose the store exports as
// globals before loading the module under test.
Object.assign(globalThis, require('../store.js'));

const {
  defaultEntryTitle,
  resolveDefaultCollection,
  createCollection,
  addEntryToCollection,
  removeEntryFromCollection,
  updateEntryTitle,
  updateEntryContent,
  clearCollectionEntries,
  reorderEntries,
  deleteCollection,
  getCollections,
  getCollectionDefaults,
  setCollectionGlobalDefault,
  setCollectionSessionDefault,
} = require('../collections.js');

function reset() { memory.clear(); }

// ─── resolveDefaultCollection (pure) ───────────────────────────────────────────

test('resolveDefaultCollection: global only', () => {
  assert.equal(resolveDefaultCollection({ global: 'a', perSession: {} }, 's1'), 'a');
  assert.equal(resolveDefaultCollection({ global: null, perSession: {} }, 's1'), null);
});

test('resolveDefaultCollection: per-session overrides global', () => {
  const d = { global: 'a', perSession: { s1: 'b' } };
  assert.equal(resolveDefaultCollection(d, 's1'), 'b');
  assert.equal(resolveDefaultCollection(d, 's2'), 'a'); // other sessions fall to global
});

test('resolveDefaultCollection: per-session null entry pins to null, not global', () => {
  // A saved `null` override means "this session has no default" — must not
  // fall through to the global.
  const d = { global: 'a', perSession: { s1: null } };
  assert.equal(resolveDefaultCollection(d, 's1'), null);
});

// ─── defaultEntryTitle (pure) ───────────────────────────────────────────────────

test('defaultEntryTitle: stored title wins', () => {
  assert.equal(defaultEntryTitle({ title: 'Kept', content: 'First line', rawContent: 'raw' }), 'Kept');
});

test('defaultEntryTitle: first non-empty line of content, falling back to raw source', () => {
  assert.equal(defaultEntryTitle({ content: '  \nTranslated line', rawContent: 'raw line' }), 'Translated line');
  assert.equal(defaultEntryTitle({ content: '', rawContent: 'raw line' }), 'raw line');
  assert.equal(defaultEntryTitle({ content: '  \n ', rawContent: '  raw  ' }), 'raw');
});

test('defaultEntryTitle: falls back to Chunk N when nothing usable', () => {
  assert.equal(defaultEntryTitle({ content: '', rawContent: '' }), 'Chunk 1');
  assert.equal(defaultEntryTitle({ content: '', rawContent: '', chunkIndex: 4 }), 'Chunk 5');
});

test('defaultEntryTitle: caps a single long line at 120 chars with ellipsis', () => {
  const long = 'x'.repeat(200);
  assert.equal(defaultEntryTitle({ content: long }), 'x'.repeat(120) + '…');
});

// ─── CRUD ───────────────────────────────────────────────────────────────────────

test('createCollection trims and persists', async () => {
  reset();
  const { collection } = await createCollection('  My Coll  ');
  assert.equal(collection.name, 'My Coll');
  assert.ok(collection.id);
  assert.deepEqual(collection.entries, []);
  const { collections } = await getCollections();
  assert.equal(collections[collection.id].name, 'My Coll');
});

test('createCollection rejects empty name', async () => {
  reset();
  await assert.rejects(createCollection('   '), /Collection name is required/);
});

test('addEntryToCollection dedupes same chunk', async () => {
  reset();
  const { collection } = await createCollection('C');
  const entry = { sessionId: 's1', chunkIndex: 0, title: 't', content: 'x' };
  const first = await addEntryToCollection(collection.id, entry);
  assert.equal(first.alreadyPresent, false);
  const dup = await addEntryToCollection(collection.id, entry);
  assert.equal(dup.alreadyPresent, true);
  const { collections } = await getCollections();
  assert.equal(collections[collection.id].entries.length, 1);
});

test('addEntryToCollection stamps id and addedAt', async () => {
  reset();
  const { collection } = await createCollection('C');
  await addEntryToCollection(collection.id, { sessionId: 's1', chunkIndex: 1, content: 'x' });
  const { collections } = await getCollections();
  const entry = collections[collection.id].entries[0];
  assert.ok(entry.id);
  assert.ok(entry.addedAt);
  assert.equal(entry.chunkIndex, 1);
});

test('addEntryToCollection rejects invalid entry', async () => {
  reset();
  const { collection } = await createCollection('C');
  await assert.rejects(addEntryToCollection(collection.id, { sessionId: 's1', chunkIndex: -1 }));
  await assert.rejects(addEntryToCollection(collection.id, { sessionId: 's1' }));
  await assert.rejects(addEntryToCollection(collection.id, null), /Invalid input/);
});

test('removeEntryFromCollection removes and stamps updatedAt', async () => {
  reset();
  const { collection } = await createCollection('C');
  await addEntryToCollection(collection.id, { sessionId: 's1', chunkIndex: 0 });
  const { collections } = await getCollections();
  const entryId = collections[collection.id].entries[0].id;
  await removeEntryFromCollection(collection.id, entryId);
  const after = (await getCollections()).collections[collection.id];
  assert.equal(after.entries.length, 0);
  assert.ok(after.updatedAt);
});

test('removeEntryFromCollection rejects unknown entry', async () => {
  reset();
  const { collection } = await createCollection('C');
  await assert.rejects(removeEntryFromCollection(collection.id, 'nope'), /Entry not found/);
});

test('updateEntryTitle / updateEntryContent mutate in place', async () => {
  reset();
  const { collection } = await createCollection('C');
  await addEntryToCollection(collection.id, { sessionId: 's1', chunkIndex: 0, title: 'old', content: 'oldc' });
  const { collections } = await getCollections();
  const entryId = collections[collection.id].entries[0].id;
  await updateEntryTitle(collection.id, entryId, 'new');
  await updateEntryContent(collection.id, entryId, 'newc');
  const entry = (await getCollections()).collections[collection.id].entries[0];
  assert.equal(entry.title, 'new');
  assert.equal(entry.content, 'newc');
});

test('reorderEntries moves and validates bounds', async () => {
  reset();
  const { collection } = await createCollection('C');
  await addEntryToCollection(collection.id, { sessionId: 's1', chunkIndex: 0 });
  await addEntryToCollection(collection.id, { sessionId: 's1', chunkIndex: 1 });
  await addEntryToCollection(collection.id, { sessionId: 's1', chunkIndex: 2 });
  await reorderEntries(collection.id, 2, 0);
  const entries = (await getCollections()).collections[collection.id].entries;
  assert.deepEqual(entries.map(e => e.chunkIndex), [2, 0, 1]);
  await assert.rejects(reorderEntries(collection.id, 0, 5), /Invalid fromIndex or toIndex/);
});

test('clearCollectionEntries empties the list', async () => {
  reset();
  const { collection } = await createCollection('C');
  await addEntryToCollection(collection.id, { sessionId: 's1', chunkIndex: 0 });
  await clearCollectionEntries(collection.id);
  assert.equal((await getCollections()).collections[collection.id].entries.length, 0);
});

// ─── Defaults + delete cleanup ──────────────────────────────────────────────────

test('setCollectionGlobalDefault validates the reference', async () => {
  reset();
  await assert.rejects(setCollectionGlobalDefault('ghost'), /Invalid collection reference/);
  const { collection } = await createCollection('C');
  await setCollectionGlobalDefault(collection.id);
  const { defaults } = await getCollectionDefaults();
  assert.equal(defaults.global, collection.id);
  await setCollectionGlobalDefault(null); // clears
  assert.equal((await getCollectionDefaults()).defaults.global, null);
});

test('setCollectionSessionDefault merges, null clears the entry', async () => {
  reset();
  const { collection } = await createCollection('C');
  await setCollectionSessionDefault('s1', collection.id);
  let { defaults } = await getCollectionDefaults();
  assert.equal(defaults.perSession.s1, collection.id);
  assert.equal(defaults.global, null); // other sessions unaffected
  await setCollectionSessionDefault('s1', null);
  defaults = (await getCollectionDefaults()).defaults;
  assert.equal(Object.prototype.hasOwnProperty.call(defaults.perSession, 's1'), false);
});

test('deleteCollection clears defaults referencing it', async () => {
  reset();
  const a = await createCollection('A');
  const b = await createCollection('B');
  await setCollectionGlobalDefault(a.collection.id);
  await setCollectionSessionDefault('s1', a.collection.id);
  await setCollectionSessionDefault('s2', b.collection.id);
  await deleteCollection(a.collection.id);
  const { collections } = await getCollections();
  assert.equal(collections[a.collection.id], undefined);
  assert.ok(collections[b.collection.id]);
  const { defaults } = await getCollectionDefaults();
  assert.equal(defaults.global, null);
  assert.equal(Object.prototype.hasOwnProperty.call(defaults.perSession, 's1'), false);
  assert.equal(defaults.perSession.s2, b.collection.id); // other session override kept
});

test('deleteCollection rejects missing id', async () => {
  reset();
  await assert.rejects(deleteCollection(undefined), /Invalid input/);
});
