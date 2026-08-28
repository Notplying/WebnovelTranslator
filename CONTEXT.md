# Webnovel Translator

A Firefox extension that extracts text from webnovel pages and translates it via LLM APIs. Two surfaces: the Settings page (options.html) and the translation/chunks view (chunks.html). No popup, no injected host-page UI.

## Architecture

The shared modules below are classic scripts loaded before consumers. In the service worker there are two equivalent registration paths: `background.scripts` in manifest.json (Firefox) and `importScripts` in service_worker.js (Chrome, where MV3 `background.scripts` is unsupported) — a worker module must be registered in both to load everywhere. Worker modules: `browser-polyfill.min.js`, `shared_web_permissions.js`, `fewshot.js`, `settings.js`, `store.js`, `collections.js`, `llm.js`. Page-only modules (`utils.js`, `exporters.js`, `chunks_pipeline.js`) load via `<script>` tags in `options.html` / `chunks.html` and never touch the worker. Each module carries a `module.exports` guard at the bottom so Node can load it for tests; in the browser the top-level functions are globals. New modules may be registered through either worker path or the pages' script tags as needed — not necessarily both. See ADR-0002 for the load-order contract.

**Settings schema** (`settings.js`): the single source of truth for every setting — one flat table (key → default, type, clamp, storage area, element id). Every load, save, sanitize, import and fresh-install write derives from the table, so a fresh install is structurally identical to a Save All. The `NON_SETTING_STORAGE_KEYS` list excludes non-settings keys from import/export.

**Store** (`store.js`): the serialized read-modify-write primitive for `browser.storage.local`. `mutate(key, fn)` runs each mutator under a per-key promise queue with the `{ changed, note }` contract; `clearLocal` and `removeKeys` wait for every in-flight chain before wiping; `setRaw` is the unlocked whole-value write. `saveSession` upserts sessions newest-first with `maxSessions` eviction.

**LLM adapter** (`llm.js`): one `streamLLM` seam owning fetch, timeout, abort, SSE normalization and the LCS dedup of repeated deltas. Each provider is a descriptor row (gemini / openRouter / openai); the web-automation providers have no shared transport and stay in the worker. Errors are classed at the seam (`HttpError` / `TimeoutError` / `AbortError`) and mapped to user strings at the worker edge.

**Collections domain** (`collections.js`): one owner for the collection model — the `resolveDefaultCollection` rule (per-session override wins over global), the `defaultEntryTitle` convention, and the serialized CRUD/entry/defaults mutations over the store. The worker's message handlers are one-line delegations into it.

**Exporters** (`exporters.js`): pure file-format builders — the minimal STORE-compression ZIP (`buildStoreZip`) and the complete EPUB package (`buildEpub`), hoisted out of options.js so the bit-level logic is Node-testable. `utils.js` holds the single HTML-escaping convention (`escapeHtml`, the safe superset including `&quot;` for attribute contexts) plus `decodeHtmlEntities`.

**Chunks pipeline** (`chunks_pipeline.js`): the one retry/checkpoint/timeout loop for chunk translation (`runChunkAttempts`), with browser/DOM dependencies injected so the decision tree is testable in Node. Callers in chunks.js keep only UI ceremony.

## Language

**Modern UI**:
The default visual theme — crisp dark surfaces with a single cyan accent, no visible gradients or backdrop blur. Applied as CSS variable overrides under the `data-ui="modern"` attribute. (The `--accent-gradient*` variables are linear-gradient values but the two stops are the same color, so the rendered output is flat.)
_Avoid_: New UI, Liquid Glass (the rejected frosted-glass predecessor)

**Classic UI**:
The original flat dark theme. The `:root` CSS defaults, with one accessibility correction: `--text-muted` is bumped from `#64748b` (fails WCAG AA on Classic surfaces) to `#94a3b8` (passes AA with margin). All other values are unchanged from pre-theme versions. Selected by toggling Modern UI off.
_Avoid_: Old UI, Legacy theme

**UI theme toggle**:
The Settings control in the Appearance section that switches between Modern UI and Classic UI. Applies instantly, without the Save All Settings button, and syncs live to any open chunks.html tabs.
_Avoid_: Theme switch, Appearance setting

**`uiTheme`**:
The storage key holding the chosen theme. Values `"modern"` (default) or `"classic"`. Stored in `storage.local` and mirrored to `localStorage` for the synchronous pre-paint boot read.
_Avoid_: theme, uiStyle

**Theme mirror**:
The `localStorage` copy of `uiTheme`, written alongside the storage write. Read synchronously by `ui-boot.js` in each page's `<head>` so the theme is applied before first paint (no flash, no async race). The implementation comment in `ui-boot.js` calls it a "cache" — accurate in code (`storage.local` is the source of truth and the mirror is healed on every page load) but the canonical user-facing term is the one above.
_Avoid_: local copy

**Settings schema**:
The flat key→default table in `settings.js` that every load/save/sanitize/import/install loop derives from. Adding a setting = one row. See ADR-0003.
_Avoid_: DEFAULTS, the settings list

**Store**:
The serialized read-modify-write primitive in `store.js` — one per-key promise queue (plus `clearLocal`/`removeKeys` barriers) replacing the three hand-rolled mutexes. Mutators return `{ changed, note }`; `changed: false` skips the write and carries a note like `alreadyPresent`.
_Avoid_: collectionQueue, sessionStorageLocks, storage locks

**Stream wait**:
The promise-based wait in chunks.js (`waitForStreamComplete`) resolved by the worker's `isComplete` stream message — replaces the old 200 ms poll over `_streamCompleteFlags`.
_Avoid_: streaming flags, poll-over-push

**Chunk attempt loop**:
`runChunkAttempts` in chunks_pipeline.js — the single retry/checkpoint/timeout loop used by both process-all and reprocess-one, with dependencies injected.
_Avoid_: processAllChunks loop, reprocess loop

**Default collection**:
The resolved collection for a session: its per-session override if present, else the global default, else none. Owned by `resolveDefaultCollection` in collections.js.
_Avoid_: the default dropdown value

**Entry title**:
The display/export title of a collection entry: stored title, else first non-empty line of content, else of the raw source, else `Chunk N`. Owned by `defaultEntryTitle` in collections.js.
_Avoid_: entryTitle, the chunk title
