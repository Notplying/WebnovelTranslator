// ui-theme.js — shared pre-paint theme boot + toggle helper.
// Loaded synchronously in <head> of options.html and chunks.html so the
// data-ui attribute is set before the body paints (no FOUC). The `browser`
// global is provided by browser-polyfill.min.js, which must load before this
// script in pages that use it; this boot also works if `browser` is absent
// (it falls back to the modern default).

(function () {
  const ROOT = document.documentElement;

  // Safe default applied synchronously — the common path (modern) never
  // waits on storage. Existing installs (no stored uiTheme) get modern here.
  ROOT.setAttribute('data-ui', 'modern');

  async function readAndApply() {
    try {
      const store = (typeof browser !== 'undefined' && browser.storage)
        ? browser.storage.local
        : null;
      if (!store) return;
      const { uiTheme } = await store.get('uiTheme');
      if (uiTheme === 'classic' || uiTheme === 'modern') {
        ROOT.setAttribute('data-ui', uiTheme);
      }
      // An unset or invalid value leaves the synchronous 'modern' default.
    } catch (_) { /* storage unavailable — stay on modern default */ }
  }
  readAndApply();

  // Public helper for the Appearance toggle. Persists and applies live.
  window.applyUiTheme = async function (value) {
    if (value !== 'classic' && value !== 'modern') value = 'modern';
    ROOT.setAttribute('data-ui', value);
    try {
      if (typeof browser !== 'undefined' && browser.storage) {
        await browser.storage.local.set({ uiTheme: value });
      }
    } catch (_) {}
    // Reflect the choice in any segmented control on the page.
    document.querySelectorAll('[data-ui-choice]').forEach(el => {
      el.setAttribute('aria-pressed', String(el.dataset.uiChoice === value));
      el.classList.toggle('active', el.dataset.uiChoice === value);
    });
  };
})();
