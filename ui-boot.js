// Sets the Modern UI theme before first paint. Must stay synchronous and
// dependency-free (no browser.* API): it reads the localStorage mirror that
// options.js keeps in sync with storage.local. Missing key = Modern (default),
// so the boot snippet needs no async lookup and can never flash Classic.
try {
  if (localStorage.getItem('uiTheme') !== 'classic') {
    document.documentElement.setAttribute('data-ui', 'modern');
  }
} catch (e) {
  // Storage disabled — fall back to the default (modern) look.
}
