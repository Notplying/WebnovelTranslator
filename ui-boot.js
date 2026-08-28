// Sets the Modern UI theme before first paint. Must stay synchronous and
// dependency-free (no browser.* API): it reads the localStorage mirror that
// options.js keeps in sync with storage.local. Missing key = Modern (default).
// The localStorage value is a cache, not a source of truth — storage.local
// owns `uiTheme`, and the mirror is healed on every page load by
// `applyUiTheme(settings.uiTheme)` (options.js, chunks.js). A stale or
// missing mirror (cleared storage, storage disabled) falls back to Modern
// for one paint, then the next page load is correct.
try {
  if (localStorage.getItem('uiTheme') !== 'classic') {
    document.documentElement.setAttribute('data-ui', 'modern');
  }
} catch (e) {
  // Storage disabled — fall back to the default (modern) look.
}
