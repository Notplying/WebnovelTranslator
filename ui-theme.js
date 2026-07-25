// ui-theme.js — shared pre-paint theme boot + toggle helper.
// Loaded synchronously in <head> of options.html and chunks.html so the
// data-ui attribute is set before the body paints (no FOUC). Uses the
// `browser` global if available, else falls back to `chrome.storage`, so
// it works in Chrome (MV3) without the polyfill; stays on the modern
// default if neither API is present.

(function () {
  const ROOT = document.documentElement;

  // Safe default applied synchronously — the common path (modern) never
  // waits on storage. Existing installs (no stored uiTheme) get modern here.
  ROOT.setAttribute('data-ui', 'modern');

  async function readAndApply() {
    try {
      const store = (typeof browser !== 'undefined' && browser.storage && browser.storage.local)
        ? browser.storage.local
        : (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
          ? chrome.storage.local
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
      const store = (typeof browser !== 'undefined' && browser.storage && browser.storage.local)
        ? browser.storage.local
        : (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
          ? chrome.storage.local
          : null;
      if (store) await store.set({ uiTheme: value });
    } catch (_) {}
    // Reflect the choice in any segmented control on the page.
    document.querySelectorAll('[data-ui-choice]').forEach(el => {
      el.setAttribute('aria-pressed', String(el.dataset.uiChoice === value));
      el.classList.toggle('active', el.dataset.uiChoice === value);
    });
  };
})();
