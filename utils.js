// utils.js — tiny shared pure helpers for the options and chunks pages.
// Loaded as a classic script before the page scripts (see options.html /
// chunks.html). Top-level functions are browser globals; the module.exports
// block at the bottom enables Node testing (Node-only; inert in the browser).

// Single escaping convention for both pages. The options page used to escape
// only & < > while chunks.js also escaped " — and both render into attributes
// (data-id, aria-label), so the shorter variant could leak quotes out of an
// attribute value. This is the safe superset, wrapped in String() so callers
// can pass null/undefined freely.
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Reverse of escapeHtml, plus &#39;. Decode before re-escaping so we always
// work with literal chars, never double-encoded strings.
function decodeHtmlEntities(t) {
  return String(t ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// ─── Node test seam (fewshot.js/settings.js pattern; inert in the browser) ─────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { escapeHtml, decodeHtmlEntities };
}
