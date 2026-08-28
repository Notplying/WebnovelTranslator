# Shared pure modules are classic scripts with a Node test seam

## Decision

Shared, dependency-free modules load as classic scripts everywhere they are needed. Worker modules (`settings.js`, `store.js`, `collections.js`, `llm.js`, plus `fewshot.js` and `shared_web_permissions.js`) have two equivalent registration paths:

- Firefox: listed in `manifest.json` `background.scripts`, in fixed order, before `service_worker.js`.
- Chrome: `service_worker.js` loads them via `importScripts` at startup (Chrome MV3 does not support `background.scripts`), guarded by `typeof` checks so the Firefox path does not double-load.

A worker module must be registered in both paths to load in every browser. Page-only modules (`utils.js`, `exporters.js`, `chunks_pipeline.js`) load via `<script>` tags in `options.html` / `chunks.html`, before the page script, and are never registered in the worker. A new module may be registered through either the worker paths or the page script tags depending on where it is needed — not necessarily both.

Each module ends with a `module.exports` guard:

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ... };
}
```

so Node can require it for tests while the guard is inert in the browser.

## Context

The worker needs a bundle of shared helpers (settings, store, few-shot, LLM seam); the pages need the same store and collections logic plus escaping. The codebase has no bundler — a plain MV3 extension — so modules must be plain scripts with no `import`/`require` at top level. The worker loads its scripts via `background.scripts` where supported and `importScripts` where not; the pages via `<script>` tags. Load order is the only dependency wiring available.

## Consequences

- Adding a worker module means editing three places: the module itself, `manifest.json` `background.scripts`, and the `importScripts` list in `service_worker.js` — in the right order relative to consumers. Adding a page-only module means editing the module and the `<script>` tags of the pages that need it. The two worker paths and the page tags are independent registries; a module only appears where it is used.
- Two modules must not export the same global name; e.g. `collections.js` took over `getCollections` from `store.js`, which dropped it.
- Tests for a module that depends on another (`collections.test.js` needs `store.mutate`) must mirror the load order by exposing the store exports as globals before requiring the module under test:

  ```js
  Object.assign(globalThis, require('../store.js'));
  ```
