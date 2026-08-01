// ui-theme.js — shared Modern/Classic theme logic for the options and chunks pages.
// Loaded before options.js / chunks.js, which use UI_THEME and applyUiTheme.
// ui-boot.js stays separate on purpose: it runs synchronously in <head> with zero
// dependencies and cannot use this module.

const UI_THEME = {
  MODERN: 'modern',
  CLASSIC: 'classic',
};

// Any value other than 'classic' coerces to 'modern' — the default theme.
function normalizeTheme(value) {
  return value === UI_THEME.CLASSIC ? UI_THEME.CLASSIC : UI_THEME.MODERN;
}

// Applies the theme to the document and mirrors it to localStorage so the
// synchronous ui-boot.js snippet in <head> can restore it before first paint.
// Returns the normalized theme.
function applyUiTheme(value) {
  const theme = normalizeTheme(value);
  if (theme === UI_THEME.MODERN) {
    document.documentElement.setAttribute('data-ui', 'modern');
  } else {
    document.documentElement.removeAttribute('data-ui');
  }
  try {
    localStorage.setItem('uiTheme', theme);
  } catch (e) {
    // Storage may be disabled (private browsing / blocked) — the data-ui
    // attribute above is already applied, so the page is themed correctly;
    // only the pre-paint mirror is lost.
  }
  return theme;
}
