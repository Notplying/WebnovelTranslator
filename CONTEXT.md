# Webnovel Translator

A Firefox extension that extracts text from webnovel pages and translates it via LLM APIs. Two surfaces: the Settings page (options.html) and the translation/chunks view (chunks.html). No popup, no injected host-page UI.

## Language

**Modern UI**:
The default visual theme — crisp dark surfaces with a single cyan accent, no gradients or backdrop blur. Applied as CSS variable overrides under the `data-ui="modern"` attribute.
_Avoid_: New UI, Liquid Glass (the rejected frosted-glass predecessor)

**Classic UI**:
The original flat dark theme. The `:root` CSS defaults, pixel-identical to pre-theme versions. Selected by toggling Modern UI off.
_Avoid_: Old UI, Legacy theme

**UI theme toggle**:
The Settings control in the Appearance section that switches between Modern UI and Classic UI. Applies instantly, without the Save All Settings button, and syncs live to any open chunks.html tabs.
_Avoid_: Theme switch, Appearance setting

**`uiTheme`**:
The storage key holding the chosen theme. Values `"modern"` (default) or `"classic"`. Stored in `storage.local` and mirrored to `localStorage` for the synchronous pre-paint boot read.
_Avoid_: theme, uiStyle

**Theme mirror**:
The `localStorage` copy of `uiTheme`, written alongside the storage write. Read synchronously by `ui-boot.js` in each page's `<head>` so the theme is applied before first paint (no flash, no async race).
_Avoid_: cache, local copy
