// store.js — serialized read-modify-write primitive for browser.storage.local.
// Shared by the service worker, options page and chunks page (loaded as a
// classic script in all three contexts, like settings.js).
//
// Why: three modules hand-rolled promise-queue mutexes for the same problem —
// the worker's collectionQueue, its per-session updateSessionStorage locks, and
// fewshot.js's _addExampleLock. All three guard the same class of race: two
// get→mutate→set sequences on one storage key interleaving at an await and
// silently dropping a write. This module owns that one primitive, per key.

// ─── Per-key serialized queue ──────────────────────────────────────────────────
const _chains = new Map();

function _chain(key) {
  if (!_chains.has(key)) _chains.set(key, Promise.resolve());
  return _chains.get(key);
}

function _setChain(key, promise) {
  _chains.set(key, promise);
}

// Runs `fn(currentValue)` under the per-key lock, then writes the result back
// if the mutator signalled a change. Mutator contract:
//   - return { changed: false, note?: string }  → no write; resolves { changed: false, note }
//   - return { changed: true, result?: any }    → write; resolves { changed: true, result }
//   - return undefined                          → treated as { changed: false } (no write)
// Errors thrown inside fn reject the caller's promise but never stall the queue.
// The queue itself is never allowed to reject — one failed mutation must not
// poison every later write to the same key.
//
// UNSUPPORTED: calling mutate() recursively for the same key inside fn
// deadlocks — the inner call queues behind the outer lock, which is awaiting
// the inner. Read other keys with a raw browser.storage.local.get() instead
// (it does not take a key lock); write other keys with setRaw()/their own
// mutate().
async function mutate(key, fn) {
  const prev = _chain(key);
  let settle;
  const run = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const chained = prev.then(() => run).catch(() => {});
  _setChain(key, chained);
  await prev;
  try {
    const { [key]: current } = await browser.storage.local.get(key);
    const outcome = await fn(current);
    if (outcome && outcome.changed === true) {
      await browser.storage.local.set({ [key]: outcome.result });
    }
    settle.resolve(outcome && outcome.changed === true
      ? { changed: true, result: outcome.result }
      : { changed: false, note: outcome && outcome.note !== undefined ? outcome.note : undefined });
  } catch (err) {
    settle.reject(err);
  }
  return run;
}

// The whole-key barrier clearLocal and removeKeys share: wait for every
// in-flight per-key chain, run the storage op, then release. Chains the
// barrier itself on '*' so a second barrier queues behind the first.
async function _barrier(fn) {
  const prevs = Promise.all([..._chains.values()]);
  let settle;
  const run = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  _setChain('*', prevs.then(() => run).catch(() => {}));
  await prevs;
  try {
    await fn();
    settle.resolve({ changed: true });
  } catch (err) {
    settle.reject(err);
  }
  return run;
}

// Serialized full-clear of browser.storage.local. Waits for every in-flight
// per-key chain before clearing, so a mutation already queued from another
// context (options page, chunks page) lands before the wipe rather than being
// silently lost between the clear and a later re-set. Writes that start after
// the clear are inherently racy — same semantics as storage.local.clear().
async function clearLocal() {
  return _barrier(() => browser.storage.local.clear());
}

// Unlocked single-key write. Safe because a plain set() cannot lose data to
// interleaving — the last writer wins, which is the correct semantics for
// whole-value overwrites (settings, webPermissions, uiTheme).
async function setRaw(key, value) {
  await browser.storage.local.set({ [key]: value });
}

// Whole-key delete behind the same barrier clearLocal uses: waits for every
// in-flight per-key chain, then removes. A bare storage.local.remove([...])
// can land between a get→mutate→set on the same key and erase the just-written
// value — that clobber class was live in the options-page clear-results button.
async function removeKeys(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  return _barrier(() => browser.storage.local.remove(list));
}

// Serialized reset: preserves keysToKeep through the clear, then writes
// replacements (settings DEFAULTS + preserved values) — all ordered through
// the same '*' barrier so an in-flight mutation from another context lands
// before the wipe instead of being lost. What remains afterwards is exactly
// replacements (plus whatever other contexts write after the clear).
async function resetLocal(keysToKeep, replacements) {
  return _barrier(async () => {
    const kept = await browser.storage.local.get(keysToKeep);
    await browser.storage.local.clear();
    await browser.storage.local.set({ ...replacements, ...kept });
  });
}

// ─── Named accessors for the hot shapes ────────────────────────────────────────
// These are thin conveniences over mutate(); the policy (caps, dedupe, eviction)
// lives in the callers.

// Upsert a session, newest-first, evicted to maxSessions — mirrors the worker's
// updateSessionStorage behavior exactly, serialized under the key lock.
async function saveSession(sessionId, sessionDataToStore) {
  return mutate('translationSessions', async (translationSessions = []) => {
    const filtered = translationSessions.filter(s => s.id !== sessionId);
    // Caller data spreads FIRST so the generated identity fields (id,
    // timestamp, firstChunk) always win — caller-provided values cannot
    // override the session key or eviction ordering.
    const sessionEntry = { ...sessionDataToStore, id: sessionId, timestamp: Date.now(), firstChunk: sessionDataToStore.chunks[0] || '' };
    const { maxSessions = 3 } = await browser.storage.local.get('maxSessions');
    const updated = [sessionEntry, ...filtered].sort((a, b) => b.timestamp - a.timestamp).slice(0, maxSessions);
    return { changed: true, result: updated };
  });
}

// ─── Node test seam (fewshot.js/settings.js pattern; inert in the browser) ─────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { mutate, clearLocal, removeKeys, setRaw, resetLocal, saveSession };
}
