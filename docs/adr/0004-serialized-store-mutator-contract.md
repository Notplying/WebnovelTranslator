# One serialized store with a { changed, note } mutator contract

## Decision

`store.js` owns the read-modify-write primitive for `browser.storage.local`:

- `mutate(key, fn)` runs `fn(current)` under a per-key promise queue and writes the result only if the mutator signals a change.
- Mutator contract: return `{ changed: true, result }` to write, `{ changed: false, note }` to skip (a `note` like `'alreadyPresent'` can ride along), or `undefined` for a plain no-op. Errors inside the mutator reject the caller but never poison the queue.
- `clearLocal()` and `removeKeys(keys)` wait for every in-flight per-key chain before wiping, so a queued write from another context (options page vs chunks page) lands before the wipe rather than being silently lost.
- `setRaw(key, value)` is the unlocked whole-value write, reserved for single-key overwrites (settings, webPermissions, uiTheme) where last-writer-wins is the correct semantics.

## Context

Three modules hand-rolled promise-queue mutexes for the same race — two `get→mutate→set` sequences interleaving at an await and silently dropping a write: the worker's `collectionQueue`, its per-session `sessionStorageLocks`, and `fewshot.js`'s `_addExampleLock`. Separate from that, a raw `storage.local.clear()` in the options backup could wipe a concurrent write from the chunks view; a raw `storage.local.remove()` on clear-results had the same clobber class. All three are now one primitive with barriers.

## Consequences

- Three mutexes collapsed to one per-key queue; mutation sites across worker/options/chunks/fewshot route through it.
- `clearLocal` / `removeKeys` are the only sanctioned whole-storage operations; bare `clear()`/`remove()` in page code is a bug.
- Tests mock one store against a fake `browser.storage.local` with a microtask gap in `get()` so interleaving is real (`tests/store.test.js`).
- The `{ changed, note }` shape replaced an older truthy-overload ("return true = already present") that leaked through the message interface.
