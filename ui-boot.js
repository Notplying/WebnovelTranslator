// Sets the Modern UI theme before first paint. Must stay synchronous and
// dependency-free (no browser.* API): it reads the localStorage mirror that
// options.js keeps in sync with storage.local. Missing key = Modern (default).
// The pre-paint guarantee holds only while the mirror survives — a stale or
// missing mirror (cleared storage, storage disabled) falls back to Modern and
// is healed by the pages' storage.local reconciliation at load.
try {
  if (localStorage.getItem('uiTheme') !== 'classic') {
    document.documentElement.setAttribute('data-ui', 'modern');
  }
} catch (e) {
  // Storage disabled — fall back to the default (modern) look.
}
