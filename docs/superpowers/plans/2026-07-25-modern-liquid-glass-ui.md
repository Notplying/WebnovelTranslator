# Modern Liquid Glass UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a frosted-dark Liquid Glass UI for the Settings and Chunks pages, keeping the existing flat dark UI as an opt-in Classic theme selected from a new Appearance section. Modern is the default.

**Architecture:** A synchronous pre-paint boot in a shared `ui-theme.js` sets `data-ui="modern"` (or `"classic"`) on `<html>`. A single additive `ui-theme.css`, linked after each page's inline `<style>`, overrides tokens under `:root[data-ui="modern"]` and restyles every component under `[data-ui="modern"] …`. The existing inline CSS is untouched and remains the Classic theme. `options.js` gains an `uiTheme` setting + Appearance toggle wiring.

**Tech Stack:** Static HTML/CSS/JS browser extension (MV3). No build step, no test framework. Inter via Google Fonts (already linked). Verification is manual visual testing in a browser, plus `prefers-reduced-motion` and `@supports not (backdrop-filter)` checks via DevTools.

## Global Constraints

- **Old UI is sacred:** the existing inline `<style>` blocks in [options.html](options.html) and [chunks.html](chunks.html) are modified ONLY to add a `<link>`/`<script>` in `<head>`/`<body>` and the Appearance `<section>`/nav `<button>`. Do not edit any existing selector, rule, or property in the inline CSS.
- **Modern layer is additive:** every modern override in `ui-theme.css` MUST carry a `[data-ui="modern"]` ancestor prefix. No unprefixed rules in `ui-theme.css`.
- **Reading-first:** on the chunks page, `.chunk-content-area` stays near-opaque (alpha ≥ 0.92 over a solid base), no `backdrop-filter`, no animation. Text contrast is unchanged.
- **Reduced motion:** all ambient motion in the modern layer halts under `@media (prefers-reduced-motion: reduce)`.
- **Fallback:** `@supports not (backdrop-filter: blur(1px))` collapses glass surfaces to opaque base colors. No broken layouts.
- **Default:** `uiTheme` defaults to `'modern'`; an unset value is treated as `'modern'` by the boot snippet (this is the silent migration of existing users).
- **No behavior changes:** all existing IDs, classes, and rendering logic in [chunks.js](chunks.js) and [options.js](options.js) stay the same. `uiTheme` is a normal local setting, loaded/saved like the others.
- Commit after each task. Commit messages use `feat:` / `style:` / `chore:` prefix.

---

## File Structure

- **`ui-theme.css` (new)** — The entire modern visual layer. Token overrides (`:root[data-ui="modern]`) + all component restyles scoped by `[data-ui="modern"]`. One file shared by both pages so they stay in sync.
- **`ui-theme.js` (new)** — Pre-paint boot (set `data-ui` synchronously, correct from storage) + `applyUiTheme(value)` helper used by the Appearance toggle. Shared by both pages.
- **`options.html`** — Add `<link rel="stylesheet" href="ui-theme.css">` after the inline `</style>` (line ~849); add `<script src="ui-theme.js"></script>` in `<head>` after the fonts `<link>` (so it runs before body paint); add the Appearance `<section>` after the General section and a nav `<button>` under General. No other changes.
- **`chunks.html`** — Add the same `<link>` after `</style>` (line ~923) and `<script src="ui-theme.js"></script>` in `<head>` after the fonts `<link>`. No other changes.
- **`options.js`** — Add `uiTheme: 'modern'` to `DEFAULTS`; include `uiTheme` in `loadSettings`/`saveSettings` field lists; wire Appearance segmented control in the `DOMContentLoaded` init. No other logic changes.

---

### Task 1: Create `ui-theme.js` boot + apply helper

**Files:**
- Create: `ui-theme.js`

**Interfaces:**
- Produces: global `applyUiTheme(value)` — sets `document.documentElement.setAttribute('data-ui', value)`, persists `uiTheme` to `storage.local`, and updates the segmented control state if present. Side-effect-only, no return.
- Produces: pre-paint boot that sets `data-ui="modern"` synchronously, then reads `browser.storage.local.get('uiTheme')` and corrects to `"classic"` if stored.

- [ ] **Step 1: Write `ui-theme.js`**

Create `ui-theme.js` with exactly this content:

```javascript
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
```

- [ ] **Step 2: Verify the file parses**

Run: `node -c ui-theme.js`
Expected: no syntax errors (prints nothing). If `node` is unavailable, open the file in a JS-capable editor and confirm there are no obvious syntax errors.

- [ ] **Step 3: Commit**

```bash
git add ui-theme.js
git commit -m "feat: add ui-theme.js pre-paint boot and applyUiTheme helper"
```

---

### Task 2: Wire `ui-theme.js` + `ui-theme.css` links into both pages

**Files:**
- Create: `ui-theme.css` (empty placeholder for this task; populated in Tasks 4–7)
- Modify: `options.html` (add `<link>` + `<script>`)
- Modify: `chunks.html` (add `<link>` + `<script>`)

**Interfaces:**
- Consumes: `ui-theme.js` from Task 1.
- Produces: both pages load `ui-theme.css` and run the boot before paint.

- [ ] **Step 1: Create an empty `ui-theme.css` placeholder**

Create `ui-theme.css` containing only a header comment:

```css
/* ui-theme.css — Modern Liquid Glass layer.
   Every rule in this file MUST be scoped under [data-ui="modern"].
   The existing inline <style> in each page is the untouched Classic theme. */
```

- [ ] **Step 2: Add the `<link>` and `<script>` to `options.html`**

In [options.html](options.html):
- In `<head>`, after the Google Fonts `<link>` (line 9) and BEFORE the inline `<style>`, add:
  ```html
  <script src="ui-theme.js"></script>
  ```
  (Placing it before `<style>` is fine — the boot only touches `document.documentElement`, which exists at parse time, and the IIFE runs immediately. It does not use the DOM body.)
- After the inline `</style>` (line 849), add:
  ```html
  <link rel="stylesheet" href="ui-theme.css" />
  ```

- [ ] **Step 3: Add the `<link>` and `<script>` to `chunks.html`**

In [chunks.html](chunks.html):
- In `<head>`, after the Google Fonts `<link>` (line 9) and before the inline `<style>`, add:
  ```html
  <script src="ui-theme.js"></script>
  ```
- After the inline `</style>` (line 923), add:
  ```html
  <link rel="stylesheet" href="ui-theme.css" />
  ```

- [ ] **Step 4: Verify both pages still load with no errors**

Open `options.html` and `chunks.html` in the browser (load the extension and navigate to each). Open DevTools Console.
Expected: no 404s for `ui-theme.css` or `ui-theme.js`; `<html>` has `data-ui="modern"` in the Elements panel; the page looks identical to before (the CSS file is empty, so Classic rendering is unaffected because the inline styles still apply and `data-ui="modern"` has no rules yet).

- [ ] **Step 5: Commit**

```bash
git add ui-theme.css options.html chunks.html
git commit -m "chore: link ui-theme.css and ui-theme.js into both pages"
```

---

### Task 3: Add `uiTheme` to settings storage + Appearance section + nav item

**Files:**
- Modify: `options.js` — `DEFAULTS`, `loadSettings`, `saveSettings`
- Modify: `options.html` — add nav `<button>` + Appearance `<section>`

**Interfaces:**
- Consumes: `window.applyUiTheme` from Task 1.
- Produces: `uiTheme` persisted in `storage.local`; the Appearance section's segmented control calls `applyUiTheme` and reflects state.

- [ ] **Step 1: Add `uiTheme` to `DEFAULTS` in `options.js`**

In [options.js](options.js), in the `DEFAULTS` object (line 4), add as the first key (before `apiType`):

```javascript
  uiTheme: 'modern',
```

- [ ] **Step 2: Include `uiTheme` in `loadSettings`**

In `options.js` `loadSettings()` (around line 101), add `'uiTheme'` to the array of keys passed to `forEach`. Add it as the first item in the array literal:

```javascript
  ['uiTheme', 'apiType', 'maxLength', ...]
```

Then, after that `forEach` block and before `updatePromptPreview();`, apply the theme to the segmented control. Add:

```javascript
  // Reflect the persisted theme in the Appearance segmented control.
  const theme = settings.uiTheme === 'classic' ? 'classic' : 'modern';
  document.querySelectorAll('[data-ui-choice]').forEach(el => {
    el.setAttribute('aria-pressed', String(el.dataset.uiChoice === theme));
    el.classList.toggle('active', el.dataset.uiChoice === theme);
  });
```

- [ ] **Step 3: Include `uiTheme` in `saveSettings`**

In `options.js` `saveSettings()` (around line 156), add `uiTheme` to the `raw` object as the first key. Note: `applyUiTheme` already persists `uiTheme` to `storage.local` when the toggle is used, so including it here is belt-and-suspenders — it ensures the Save button also captures the current segmented control state. Read it from the active segmented control:

```javascript
    uiTheme: (document.querySelector('[data-ui-choice].active')?.dataset.uiChoice) || 'modern',
```

- [ ] **Step 4: Add the Appearance nav `<button>` in `options.html`**

In [options.html](options.html), in the `<nav>` (line 858), after the General nav-label block and its first nav-item (`nav-general`, line 860), and BEFORE the Prompt nav-item (line 863), insert:

```html
      <button class="nav-item" data-section="appearance" id="nav-appearance">
        <span class="icon">🎨</span> Appearance
      </button>
```

Place it directly after the `nav-general` `</button>` so it reads General → Appearance → Prompt.

- [ ] **Step 5: Add the Appearance `<section>` in `options.html`**

In [options.html](options.html), immediately after the `section-general` `</section>` (line 988) and before `section-prompt`, insert:

```html
    <!-- ── Appearance ─────────────────────────────────────── -->
    <section class="section" id="section-appearance">
      <div class="page-header">
        <h1>Appearance</h1>
        <p>Choose how the extension looks. Modern uses frosted glass surfaces; Classic is the original flat dark theme.</p>
      </div>
      <div class="card">
        <div class="card-title">🪟 UI Theme</div>
        <div class="ui-segmented" role="group" aria-label="UI theme">
          <button type="button" class="ui-seg-btn active" data-ui-choice="modern" aria-pressed="true">Modern</button>
          <button type="button" class="ui-seg-btn" data-ui-choice="classic" aria-pressed="false">Classic</button>
        </div>
        <small style="color:var(--text-muted);font-size:0.78rem;display:block;margin-top:10px;line-height:1.6">
          Modern — frosted glass surfaces with refined depth, default for new installs. Classic — the original flat dark theme. The change applies instantly to this page; the Chunks page picks it up on next open.
        </small>
      </div>
    </section>
```

- [ ] **Step 6: Wire the segmented control in `options.js` `DOMContentLoaded`**

In [options.js](options.js) `DOMContentLoaded` handler (around line 1163), add inside the async callback, after `setupPasswordToggles();` and `await loadSettings();`:

```javascript
  // Appearance segmented control — apply live + persist.
  document.querySelectorAll('[data-ui-choice]').forEach(btn => {
    btn.addEventListener('click', () => {
      const value = btn.dataset.uiChoice;
      if (window.applyUiTheme) window.applyUiTheme(value);
    });
  });
```

- [ ] **Step 7: Verify the Appearance section works**

Load the extension, open Settings. Click 🎨 Appearance in the sidebar.
Expected: the Appearance section shows; the Modern button is `active`/`aria-pressed="true"`; `<html>` has `data-ui="modern"`. Click Classic → `<html>` becomes `data-ui="classic"`. Reload the page → it stays Classic (no FOUC). Click Modern → back to Modern. Open DevTools → Application → Local Storage → confirm `uiTheme` key tracks the choice. The page still looks like the Classic UI throughout because `ui-theme.css` has no rules yet.

- [ ] **Step 8: Commit**

```bash
git add options.js options.html
git commit -m "feat: add uiTheme setting and Appearance section with live toggle"
```

---

### Task 4: Modern tokens + background aurora (shared base)

**Files:**
- Modify: `ui-theme.css`

**Interfaces:**
- Produces: `:root[data-ui="modern"]` token block + `[data-ui="modern"] body` aurora background, consumed by Tasks 5–7.

- [ ] **Step 1: Append the token block + aurora to `ui-theme.css`**

Append to `ui-theme.css`:

```css
:root[data-ui="modern"] {
  --bg: #0a0c14;
  --surface: rgba(22, 26, 38, 0.72);
  --surface2: rgba(30, 35, 52, 0.60);
  --border: rgba(255, 255, 255, 0.08);
  --accent: #8b7dff;
  --accent2: #5eead4;
  --accent-glow: rgba(139, 125, 255, 0.28);
  --text: #e6e9f2;
  --text-muted: #8b93a7;
  --radius: 16px;

  /* Liquid-glass primitives (referenced by component rules below). */
  --g-glass: rgba(22, 26, 38, 0.72);
  --g-glass-2: rgba(30, 35, 52, 0.60);
  --g-border: rgba(255, 255, 255, 0.08);
  --g-specular: rgba(255, 255, 255, 0.14);
  --g-accent: #8b7dff;
  --g-shadow: 0 8px 32px rgba(0, 0, 0, 0.45), 0 1px 0 rgba(255, 255, 255, 0.06) inset;
  --g-blur: blur(24px) saturate(160%);
}

/* Aurora backdrop — two low-opacity cool orbs behind everything.
   Halts under reduced motion. */
[data-ui="modern"] body {
  position: relative;
  background:
    radial-gradient(60rem 40rem at 12% -10%, rgba(124, 106, 247, 0.18), transparent 60%),
    radial-gradient(50rem 38rem at 100% 8%, rgba(94, 234, 212, 0.10), transparent 55%),
    var(--bg);
  background-attachment: fixed;
}

/* Slow drift for the chunks reading page hero. The Settings page keeps the
   orbs static (calmer for a dense form UI). The .has-chunks-aurora class is
   added to <body> on the chunks page in Task 6. */
[data-ui="modern"] body.has-chunks-aurora::before {
  content: "";
  position: fixed;
  inset: -10%;
  background:
    radial-gradient(40rem 30rem at 20% 10%, rgba(124, 106, 247, 0.16), transparent 60%),
    radial-gradient(36rem 28rem at 85% 20%, rgba(94, 234, 212, 0.10), transparent 55%);
  z-index: -1;
  animation: g-aurora 24s ease-in-out infinite alternate;
  pointer-events: none;
}

@keyframes g-aurora {
  from { transform: translate3d(-2%, -1%, 0) scale(1); }
  to   { transform: translate3d(2%, 1%, 0) scale(1.05); }
}

@media (prefers-reduced-motion: reduce) {
  [data-ui="modern"] body.has-chunks-aurora::before { animation: none; }
}
```

Note: the `.has-chunks-aurora` class is added to `<body>` on the chunks page in Task 6 so the drift only runs there, not on Settings.

- [ ] **Step 2: Verify tokens apply on Settings**

Load Settings, confirm Appearance = Modern. Inspect `<body>` in DevTools.
Expected: computed `background` on `body` is the deep base with two radial gradients; `<html>` shows `data-ui="modern"`. Page still looks mostly like Classic for components (no component rules yet) but the body background is visibly deeper with faint color orbs.

- [ ] **Step 3: Commit**

```bash
git add ui-theme.css
git commit -m "style: modern token overrides and aurora backdrop"
```

---

### Task 5: Settings page modern component restyles

**Files:**
- Modify: `ui-theme.css`

- [ ] **Step 1: Append Settings component restyles to `ui-theme.css`**

Append:

```css
/* ── Settings page: sidebar, cards, forms, buttons, toggles ─────────── */
[data-ui="modern"] .sidebar {
  background: var(--g-glass);
  backdrop-filter: var(--g-blur);
  -webkit-backdrop-filter: var(--g-blur);
  border-right: 1px solid var(--g-border);
  box-shadow: inset 1px 0 0 var(--g-specular);
}
[data-ui="modern"] .sidebar-logo { border-bottom: 1px solid var(--g-border); }

[data-ui="modern"] .nav-item {
  border-radius: 10px;
  transition: background 0.18s ease, color 0.18s ease, box-shadow 0.18s ease;
}
[data-ui="modern"] .nav-item:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text);
}
[data-ui="modern"] .nav-item.active {
  background: var(--accent-glow);
  color: var(--g-accent);
  box-shadow: inset 0 1px 0 var(--g-specular), 0 4px 14px rgba(139, 125, 255, 0.18);
}

[data-ui="modern"] .card {
  background: var(--g-glass);
  border: 1px solid var(--g-border);
  border-radius: var(--radius);
  box-shadow: var(--g-shadow);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  position: relative;
}
[data-ui="modern"] .card::before {
  content: "";
  position: absolute;
  inset: 0 0 auto 0;
  height: 1px;
  background: var(--g-specular);
  border-radius: var(--radius) var(--radius) 0 0;
  pointer-events: none;
}

[data-ui="modern"] input[type="text"],
[data-ui="modern"] input[type="password"],
[data-ui="modern"] input[type="number"],
[data-ui="modern"] select,
[data-ui="modern"] textarea {
  background: rgba(10, 12, 20, 0.55);
  border: 1px solid var(--g-border);
  border-radius: 10px;
  box-shadow: inset 0 1px 0 var(--g-specular);
  transition: border-color 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
}
[data-ui="modern"] input:focus,
[data-ui="modern"] select:focus,
[data-ui="modern"] textarea:focus {
  border-color: var(--g-accent);
  box-shadow: 0 0 0 3px var(--accent-glow), inset 0 1px 0 var(--g-specular);
}

/* Toggle switch — glass track. */
[data-ui="modern"] .slider {
  background: rgba(10, 12, 20, 0.6);
  border: 1px solid var(--g-border);
  box-shadow: inset 0 1px 0 var(--g-specular);
}
[data-ui="modern"] input:checked + .slider {
  background: var(--g-accent);
  border-color: var(--g-accent);
  box-shadow: 0 0 12px rgba(139, 125, 255, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.25);
}

/* Buttons — glass with specular edges. */
[data-ui="modern"] .btn { border-radius: 10px; transition: transform 0.18s ease, background 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease; }
[data-ui="modern"] .btn:hover { transform: translateY(-1px); }
[data-ui="modern"] .btn-primary {
  background: var(--g-accent);
  color: #fff;
  box-shadow: 0 4px 16px rgba(139, 125, 255, 0.30), inset 0 1px 0 rgba(255, 255, 255, 0.20);
}
[data-ui="modern"] .btn-primary:hover { background: #7a68f0; box-shadow: 0 6px 22px var(--accent-glow), inset 0 1px 0 rgba(255,255,255,0.25); }
[data-ui="modern"] .btn-secondary {
  background: var(--g-glass-2);
  color: var(--text);
  border: 1px solid var(--g-border);
  box-shadow: inset 0 1px 0 var(--g-specular);
}
[data-ui="modern"] .btn-secondary:hover { background: rgba(40, 46, 66, 0.65); border-color: rgba(255, 255, 255, 0.14); }
[data-ui="modern"] .btn-danger {
  background: rgba(248, 113, 113, 0.16);
  color: var(--danger);
  border: 1px solid rgba(248, 113, 113, 0.30);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.10);
}
[data-ui="modern"] .btn-danger:hover { background: rgba(248, 113, 113, 0.26); }

/* Dropdown menus + toast — elevated glass. */
[data-ui="modern"] .add-to-dropdown .dropdown-menu {
  background: var(--g-glass-2);
  backdrop-filter: var(--g-blur);
  -webkit-backdrop-filter: var(--g-blur);
  border: 1px solid var(--g-border);
  border-radius: 12px;
  box-shadow: 0 12px 36px rgba(0,0,0,0.5), inset 0 1px 0 var(--g-specular);
}
[data-ui="modern"] .dropdown-item { border-radius: 8px; }
[data-ui="modern"] .dropdown-item:hover { background: rgba(255, 255, 255, 0.06); }

[data-ui="modern"] #toast {
  background: var(--g-glass-2);
  backdrop-filter: var(--g-blur);
  -webkit-backdrop-filter: var(--g-blur);
  border: 1px solid var(--g-border);
  box-shadow: 0 8px 32px rgba(0,0,0,0.55), inset 0 1px 0 var(--g-specular);
}

/* Sticky save bar — frosted. */
[data-ui="modern"] .main > div[style*="sticky"] {
  background: linear-gradient(transparent, rgba(10,12,20,0.85) 60%);
}

/* Few-shot example rows + collections list — glass surfaces. */
[data-ui="modern"] .example-row,
[data-ui="modern"] .collection-list,
[data-ui="modern"] .collection-entry,
[data-ui="modern"] .collections-detail {
  background: var(--g-glass);
  border: 1px solid var(--g-border);
  box-shadow: inset 0 1px 0 var(--g-specular);
}
[data-ui="modern"] .collection-item.active {
  background: var(--accent-glow);
  color: var(--g-accent);
}

/* Appearance segmented control — glass pill. */
[data-ui="modern"] .ui-segmented {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  border-radius: 12px;
  background: rgba(10, 12, 20, 0.55);
  border: 1px solid var(--g-border);
  box-shadow: inset 0 1px 0 var(--g-specular);
}
[data-ui="modern"] .ui-seg-btn {
  padding: 7px 18px;
  border-radius: 9px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-family: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.18s ease, color 0.18s ease, box-shadow 0.18s ease;
}
[data-ui="modern"] .ui-seg-btn:hover { color: var(--text); }
[data-ui="modern"] .ui-seg-btn.active {
  background: var(--g-accent);
  color: #fff;
  box-shadow: 0 2px 10px rgba(139, 125, 255, 0.30), inset 0 1px 0 rgba(255, 255, 255, 0.25);
}
```

- [ ] **Step 2: Verify Settings in Modern**

Load Settings, confirm Modern. Walk every section: General, Appearance, Prompt, Few-Shot, Collections, each provider, Data.
Expected: sidebar frosted, cards glass with a 1px brighter top edge, inputs/textarea/select glass with specular top, toggles glass with accent glow when on, buttons lift 1px on hover, toast glassy (trigger a save to see it). Toggle to Classic — everything snaps back to the original flat UI. Toggle to Modern — glass returns.

- [ ] **Step 3: Verify Classic is untouched**

With Appearance = Classic, visually compare each Settings section against the production UI. Expected: visually identical to today. Inspect `<html>` → `data-ui="classic"`; no modern rules apply.

- [ ] **Step 4: Commit**

```bash
git add ui-theme.css
git commit -m "style: modern glass restyle for Settings page components"
```

---

### Task 6: Chunks page modern component restyles + aurora drift

**Files:**
- Modify: `ui-theme.css`
- Modify: `chunks.html` — add `has-chunks-aurora` class to `<body>`

- [ ] **Step 1: Add the `has-chunks-aurora` class to the chunks `<body>`**

In [chunks.html](chunks.html), change line 926 from `<body>` to:

```html
<body class="has-chunks-aurora">
```

(This is a new class on an existing element — it does not alter existing styling; `body` had no class before. It only enables the drifting aurora `::before` defined in Task 4.)

- [ ] **Step 2: Append chunks component restyles to `ui-theme.css`**

Append:

```css
/* ── Chunks page: header, progress, chunk-cards, content, action bars ─ */
[data-ui="modern"] .header {
  background: var(--g-glass-2);
  backdrop-filter: var(--g-blur);
  -webkit-backdrop-filter: var(--g-blur);
  border-bottom: 1px solid var(--g-border);
  box-shadow: inset 0 1px 0 var(--g-specular);
}

[data-ui="modern"] #progressSection {
  background: var(--g-glass);
  border-bottom: 1px solid var(--g-border);
  box-shadow: inset 0 1px 0 var(--g-specular);
}
[data-ui="modern"] .progress-bar-track {
  background: rgba(10, 12, 20, 0.55);
  box-shadow: inset 0 1px 0 var(--g-specular);
}

/* Chunk cards — near-opaque glass. The .chunk-content-area inside stays
   fully opaque (Reading-first constraint). */
[data-ui="modern"] .chunk-card {
  background: var(--g-glass);
  border: 1px solid var(--g-border);
  border-radius: var(--radius);
  box-shadow: var(--g-shadow);
  position: relative;
}
[data-ui="modern"] .chunk-card::before {
  content: "";
  position: absolute;
  inset: 0 0 auto 0;
  height: 1px;
  background: var(--g-specular);
  border-radius: var(--radius) var(--radius) 0 0;
  pointer-events: none;
}
[data-ui="modern"] .chunk-card.done { border-color: rgba(94, 234, 212, 0.20); }
[data-ui="modern"] .chunk-card.error { border-color: rgba(248, 113, 113, 0.25); }
[data-ui="modern"] .chunk-card.processing {
  border-color: rgba(139, 125, 255, 0.35);
  box-shadow: 0 0 24px rgba(139, 125, 255, 0.15), var(--g-shadow);
}
[data-ui="modern"] .chunk-header:hover { background: rgba(255, 255, 255, 0.04); }

/* READING SURFACE — opaque, no blur, no animation. High contrast preserved. */
[data-ui="modern"] .chunk-content-area {
  background: #0a0c14;
  border: 1px solid var(--g-border);
  border-radius: 10px;
  color: var(--text);
}

/* Part tabs + micro bar — glass. Gradient fills unchanged. */
[data-ui="modern"] .part-tab {
  background: rgba(10, 12, 20, 0.55);
  border: 1px solid var(--g-border);
  box-shadow: inset 0 1px 0 var(--g-specular);
}
[data-ui="modern"] .part-tab.active {
  background: var(--accent-glow);
  color: var(--g-accent);
  border-color: var(--g-accent);
}

/* Sticky chunk action bar — frosted glass. */
[data-ui="modern"] .chunk-actions {
  background: var(--g-glass-2);
  backdrop-filter: var(--g-blur);
  -webkit-backdrop-filter: var(--g-blur);
  border-top: 1px solid var(--g-border);
  box-shadow: 0 -6px 18px rgba(0,0,0,0.30), inset 0 1px 0 var(--g-specular);
}

/* Toast + dropdowns on chunks page. */
[data-ui="modern"] #toast {
  background: var(--g-glass-2);
  backdrop-filter: var(--g-blur);
  -webkit-backdrop-filter: var(--g-blur);
  border: 1px solid var(--g-border);
  box-shadow: 0 8px 32px rgba(0,0,0,0.55), inset 0 1px 0 var(--g-specular);
}
[data-ui="modern"] .add-to-dropdown .dropdown-menu {
  background: var(--g-glass-2);
  backdrop-filter: var(--g-blur);
  -webkit-backdrop-filter: var(--g-blur);
  border: 1px solid var(--g-border);
  border-radius: 12px;
  box-shadow: 0 12px 36px rgba(0,0,0,0.5), inset 0 1px 0 var(--g-specular);
}
[data-ui="modern"] .collection-selector select {
  background: rgba(10, 12, 20, 0.55);
  border: 1px solid var(--g-border);
  border-radius: 8px;
  box-shadow: inset 0 1px 0 var(--g-specular);
}
```

- [ ] **Step 3: Verify the chunks page in Modern**

Open a translated session (chunks page). Confirm Appearance is Modern.
Expected: header frosted and sticky; progress section glass; chunk-cards are glass with a brighter 1px top edge and float over a slowly drifting cool aurora; `.chunk-content-area` is opaque (`#0a0c14`) with crisp, high-contrast text; action bar is frosted glass; toggling hide-on-scroll still works (existing `body.hide-header-scroll .header { transform: translateY(-100%) }` still applies — verify by scrolling). Toggle to Classic → original flat chunks UI. Toggle to Modern → glass returns.

- [ ] **Step 4: Verify reading-first**

On the chunks page in Modern, inspect `.chunk-content-area` in DevTools.
Expected: computed `background` is `#0a0c14` (opaque, no alpha), no `backdrop-filter`, no `animation`. Read a long translated chunk — text is crisp, line-height 1.8, max-width unchanged. Confirm the aurora is visible only behind the cards, never inside the content area.

- [ ] **Step 5: Verify reduced-motion**

In DevTools, toggle `prefers-reduced-motion: reduce` (Rendering tab). Expected: the aurora drift halts (no `animation` on `body.has-chunks-aurora::before`). All glass surfaces remain. Re-toggle reduced motion off → drift resumes.

- [ ] **Step 6: Commit**

```bash
git add ui-theme.css chunks.html
git commit -m "style: modern glass restyle for Chunks page with reading-first content surface"
```

---

### Task 7: `@supports` fallback + final verification

**Files:**
- Modify: `ui-theme.css`

- [ ] **Step 1: Append the `@supports not (backdrop-filter)` fallback to `ui-theme.css`**

Append:

```css
/* ── Fallback: where backdrop-filter is unsupported, glass surfaces
   collapse to opaque base colors. No broken layouts, text stays legible. */
@supports not (backdrop-filter: blur(1px)) {
  [data-ui="modern"] .sidebar,
  [data-ui="modern"] .card,
  [data-ui="modern"] .header,
  [data-ui="modern"] #progressSection,
  [data-ui="modern"] .chunk-card,
  [data-ui="modern"] .chunk-actions,
  [data-ui="modern"] #toast,
  [data-ui="modern"] .add-to-dropdown .dropdown-menu {
    background: #13161f;
  }
  [data-ui="modern"] #chunksContainer,
  [data-ui="modern"] body { background: var(--bg); }
}
```

- [ ] **Step 2: Verify the fallback path**

In DevTools on the chunks page, toggle `backdrop-filter` support off (or use the Rendering → "Emulate CSS media feature" if available; otherwise temporarily add a `backdrop-filter: none !important` override in the inspector to simulate).
Expected: glass surfaces render with opaque `#13161f` backgrounds; all text remains legible; no layout breakage; the aurora orbs (radial gradients on `body`) still show because they don't depend on `backdrop-filter`.

- [ ] **Step 3: Full regression — both themes, both pages**

Walk this matrix:
- Settings, Modern → all sections render with glass; Save button works; toast shows.
- Settings, Classic → visually identical to production; all existing behavior intact.
- Chunks, Modern → reading surface opaque + crisp; aurora drifts behind cards; reduced-motion halts it; hide-on-scroll works.
- Chunks, Classic → visually identical to production; hide-on-scroll works.
Reload each page in each theme → no FOUC, correct theme persists from `storage.local`.

- [ ] **Step 4: Verify `uiTheme` round-trips via export/import**

In Settings → Import/Export, export settings. Inspect the JSON → confirm `uiTheme` is present. Import into a fresh profile (or after resetting) → confirm the theme is restored. (It's a normal local setting, included via `DEFAULTS`.)

- [ ] **Step 5: Commit**

```bash
git add ui-theme.css
git commit -m "style: backdrop-filter fallback and final verification pass"
```

---

## Self-Review notes

- **Spec coverage:** Theme switch mechanism (Task 1), links (Task 2), Appearance section + storage (Task 3), tokens + aurora (Task 4), Settings restyle (Task 5), Chunks restyle + reading-first + signature (Task 6), accessibility/fallback (Task 7). All spec sections have a task.
- **Placeholders:** none — every step has concrete code or a concrete verification action.
- **Type/name consistency:** `applyUiTheme(value)`, `data-ui` attribute, `data-ui-choice`/`ui-seg-btn`/`ui-segmented` class names, `has-chunks-aurora` body class, `uiTheme` setting key — used consistently across tasks.
