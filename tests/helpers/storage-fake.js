// Shared fake browser.storage.local for the store-backed tests (store.test.js,
// collections.test.js). An explicit microtask gap inside get() lets the tests
// genuinely interleave two get→mutate→set sequences the way the real API does
// across contexts. installStorageFake() returns { memory, reset } — call reset()
// between tests to clear both the backing store and the deferreds array.

function installStorageFake() {
  const memory = new Map();
  let deferreds = [];

  globalThis.browser = {
    storage: {
      local: {
        async get(keys) {
          await new Promise(r => setTimeout(r, 0));
          // Real API: get() with no keys (undefined) or null returns everything.
          if (keys == null) return Object.fromEntries(memory);
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

  return {
    memory,
    reset() {
      memory.clear();
      deferreds = [];
    },
  };
}

module.exports = { installStorageFake };
