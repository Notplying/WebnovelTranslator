# Shared pure modules are classic scripts with a Node test seam

## Decision

Shared, dependency-free modules (`settings.js`, `store.js`, `collections.js`, `llm.js`, `utils.js`, `exporters.js`, `chunks_pipeline.js`) load as classic scripts everywhere they are needed:

- Service worker: listed in `manifest.json` `background.scripts`, in fixed order, before `service_worker.js`.
- Pages: `<script>` tags in `options.html` / `chunks.html`, before the page script.

Each module ends with a `module.exports` guard:

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ... };
}
```

so Node can require it for tests while the guard is inert in the browser.

## Context

The worker needs a bundle of shared helpers (settings, store, few-shot, LLM seam); the pages need the same store and collections logic plus escaping. The codebase has no bundler — a plain MV3 extension — so modules must be plain scripts with no `import`/`require` at top level. The worker loads its scripts via `background.scripts`; the pages via `<script>` tags. Load order is the only dependency wiring available.

## Consequences

- Adding a shared module means editing three files: the module itself, `manifest.json` `background.scripts`, and one or both page HTML files — in the right order relative to consumers.
- Two modules must not export the same global name; e.g. `collections.js` took over `getCollections` from `store.js`, which dropped it.
- Tests for a module that depends on another (`collections.test.js` needs `store.mutate`) must mirror the load order by exposing the store exports as globals before requiring the module under test:

  ```js
  Object.assign(globalThis, require('../store.js'));
  ```
