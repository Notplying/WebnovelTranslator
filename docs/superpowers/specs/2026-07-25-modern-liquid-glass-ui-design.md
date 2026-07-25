# Modern Liquid Glass UI — Design Spec

**Date:** 2026-07-25
**Status:** Draft, pending user review
**Scope:** Settings page ([options.html](../../../options.html)) and translation/chunks page ([chunks.html](../../../chunks.html)). No popup, no injected UI (see Context).

## Context

The extension currently ships a single flat dark UI shared by both pages — `--bg #0d0f17`, `--surface #13161f`, accent `#7c6af7`, teal `--accent2 #5eead4`, Inter. The chunks page already uses `backdrop-filter: blur(14px)` on its sticky header, so the glass concept is not foreign to the codebase. There is **no toolbar popup** (manifest has no `default_popup`) and **no injected floating UI** ([content.js](content.js) only extracts text from host pages). "Everything" therefore means the two HTML pages only — nothing else exists to restyle.

## Goals

1. Ship a modern UI following Apple's **Liquid Glass** aesthetic on a dark palette, at **frosted-dark** intensity: real `backdrop-filter` blur on floating chrome surfaces; near-opaque, crisp-edge glass on content surfaces.
2. **Preserve the existing flat UI unchanged** as an opt-in **Classic** theme, selectable from a new Appearance section.
3. **Modern is the default**; existing users are migrated to Modern silently (one-time — the boot snippet treats an *unset* `uiTheme` as `modern`, so any install predating this feature gets Modern on first load without a migration step; once a user picks Classic, that choice is persisted and respected). Classic is one toggle away.
4. The chunks page must remain an excellent long-form reading surface — the glass is decoration on the chrome, never on the reading surface itself (see Reading-First Constraint).

## Non-goals

- Refactoring the existing inline CSS out of the HTML files (risk to the Classic UI we must preserve).
- Touching any JS rendering logic, DOM IDs/classes, or extension behavior — this is a CSS-skin + theme-toggle change only.
- Any popup or injected-UI work (none exist).

## Reading-first constraint (hard)

The chunks page is where users spend long periods reading translated text. The modern design must **never hinder that**:

- The chunk **content area** (`.chunk-content-area`) stays **near-opaque** (`rgba` ≥ 0.92 over a solid base), with **unchanged contrast** between text and its immediate background. No translucency, no blur, no animated effect on the text surface.
- Text size, line-height (`1.8`), `max-width` (`--chunk-max-width`, default unlimited, user-configurable), and font remain as today. The reading column does not narrow.
- The aurora background (see Signature) sits **behind** the glass cards, is **low-contrast cool tone on dark**, and never touches the content area. Reading text always renders against an opaque surface.
- All ambient motion **halts** under `prefers-reduced-motion: reduce`.
- No effect on the chunks page may reduce the legibility, scan-ability, or stability of translated text. When a glass treatment would compromise that, the opaque treatment wins.

## Architecture (approach A — additive layer)

### Theme switch mechanism

- A new shared `ui-theme.js` (≈15 lines), loaded synchronously in `<head>` of both pages, runs a pre-paint boot:
  - Read `uiTheme` from `storage.local`. (Synchronous read: for a webextension page, `browser.storage.local.get` is async, so the snippet first sets `data-ui="modern"` as the safe default synchronously, then reads storage and corrects the attribute if the stored value is `classic`. Worst case is one paint-avoided-frame of Modern on a Classic install — acceptable and rare. No FOUC for the common path.)
- The **Modern UI is a single additive CSS layer** in a new `ui-theme.css`, linked in both pages **after** the existing inline `<style>`.
  - Token overrides live under `:root[data-ui="modern"]`.
  - Every component override is prefixed `[data-ui="modern"] …` (e.g. `[data-ui="modern"] .card`).
  - Because every override carries the prefix, specificity is predictable (`[attribute]` ≈ class+attribute, beats the bare element/class selectors of Classic) and **Classic is hermetically isolated** — the modern layer can never leak into the Old UI.
- The existing inline `<style>` blocks (the entire current UI) stay **byte-for-byte untouched** and remain the default for `:root` without the attribute. This is the rollback path: remove `ui-theme.css` + its `<link>` and the Old UI is exactly as it was.

### Appearance section (Settings)

- New nav item under General: **🎨 Appearance**, `data-section="appearance"`.
- A segmented control: **Modern** | **Classic**. Selecting either:
  - writes `uiTheme: 'modern' | 'classic'` to `storage.local`,
  - calls the shared `applyUiTheme(value)` helper which sets `document.documentElement.setAttribute('data-ui', value)` live (no reload needed),
- A short helper line under the control: Modern — frosted glass surfaces and refined depth; Classic — the original flat dark theme.
- `uiTheme` is added to `DEFAULTS` in [options.js](options.js) (`'modern'`), loaded/saved with the other fields, and excluded from nothing special — it is a normal local setting.

### Files added / changed

| File | Change |
|---|---|
| `ui-theme.css` (new) | Modern UI token overrides + all component restyles, scoped under `[data-ui="modern"]`. |
| `ui-theme.js` (new) | Pre-paint boot + `applyUiTheme(value)` helper, shared by both pages. |
| `options.html` | Add `<link rel="stylesheet" href="ui-theme.css">` after the inline `<style>`; add `<script src="ui-theme.js"></script>` before `browser-polyfill`; add the Appearance `<section>` + nav `<button>`. No existing markup changes. |
| `chunks.html` | Same `<link>` + `<script>` additions. No existing markup changes. |
| `options.js` | Add `uiTheme: 'modern'` to `DEFAULTS`; include in `loadSettings`/`saveSettings`; wire the Appearance segmented control. No other logic changes. |
| `chunks.js` | None (no UI-setting logic lives here). |

## Visual language — Modern UI

### Color (6 tokens, overridden under `:root[data-ui="modern"]`)

| Token | Value | Role |
|---|---|---|
| `--g-bg` | `#0a0c14` | Page base, slightly deeper than Classic so glass has contrast to sit over. |
| `--g-glass` | `rgba(22,26,38,0.72)` | Primary glass surface (cards, sidebar, inputs). |
| `--g-glass-2` | `rgba(30,35,52,0.60)` | Elevated / sticky glass (header, action bars, dropdowns, toast). |
| `--g-border` | `rgba(255,255,255,0.08)` | Hairline edge on every glass surface. |
| `--g-specular` | `rgba(255,255,255,0.14)` | The 1px brighter **top** edge — the liquid-glass motif, repeated on every surface. |
| `--g-accent` | `#8b7dff` | Accent brightened a touch to read through blur; `--accent2 #5eead4` unchanged. Text `#e6e9f2`, muted `#8b93a7`. |

Two low-opacity cool orbs (purple `rgba(124,106,247,0.18)`, teal `rgba(94,234,212,0.10)`) live on `body` behind all content as the aurora the glass refracts. They are fixed, behind the page flow, and never above z-index of content.

### Surfaces — blur where it earns its keep, opaque elsewhere (frosted-dark)

- **Sidebar** (Settings) and **sticky header / chunk action bar** (Chunks): real `backdrop-filter: blur(24px) saturate(160%)` + specular top edge — these float over scrolling content, so the frost is legible and earned.
- **Cards, inputs, toast, dropdowns, chunk-cards**: near-opaque glass (`0.72–0.92`) with a soft 1px inner-top specular highlight, layered drop shadow for depth, and gentle **16px radii** (bumped from 12).
  - **Chunk content area is the exception** — see Reading-first constraint: near-opaque (`≥0.92` over solid base), no blur, no animation, high-contrast text.
- Hover lifts a glass surface 1px (translateY) and brightens its specular edge; focus keeps the accent ring + glow (unchanged behavior, refined color).

### Type

Inter unified, refined scale (Apple-like calm — display is not decorative here):

| Role | Size / weight / tracking |
|---|---|
| Page H1 | `1.5rem / 600 / -0.01em` |
| Card title | `0.9rem / 600` |
| Body | `0.875rem / 400` |
| Labels | `0.8rem / 500` |
| Mono (session ID, prompt preview) | `JetBrains Mono, SF Mono, ui-monospace` (replaces `Courier New`) |

### Signature — the chunks reading view as hero

The chunks reading view is the thesis of the modern UI: glass chunk-cards float over a **slow, very-low-opacity cool aurora** (two radial gradients, drifting on a ~24s ease). This gives the glass something to refract — the whole point of liquid glass — and makes the reading surface unmistakably this app rather than a generic dark theme.

**Risk and justification:** motion on a reading surface. Justified because (1) the aurora is low-opacity cool tone on dark, never bright; (2) it is the **backdrop, not the content container** — the content area stays opaque and high-contrast (Reading-first constraint); (3) it is the single memorable element, everything else is disciplined; (4) it fully halts under `prefers-reduced-motion: reduce`. The specular hairline on every glass edge is the unifying motif across both pages; the aurora is what makes the chunks page the hero.

### Motion budget (self-imposed restraint)

- Aurora drift: ~24s ease, low-opacity, halts under reduced-motion.
- Hover lift: 1px, 180ms.
- Section/page transitions: none added (existing behavior preserved).
- No entry animations on cards, no scroll-triggered reveals, no parallax. The reading page stays still while you read; only the backdrop breathes, slowly.

## Per-page restyle summary

### Settings page ([options.html](options.html))

- `body`: deep base + two aurora orbs behind content.
- `.sidebar`: frosted glass (`blur(24px)`), specular edge, refined active nav state (glass pill with accent specular).
- `.card`: near-opaque glass, 16px radius, specular top edge, soft layered shadow.
- Inputs / selects / textareas: glass surface, refined focus (accent ring + glow), specular top edge.
- `.switch` / toggles: glass track, accent fill with a subtle glow when on.
- `.btn-*`: glass primary/secondary/danger with specular edges; primary keeps accent fill, secondary is glass-on-glass.
- Dropdown menus, toast: elevated glass (`--g-glass-2`) with specular edge.
- Sticky save bar: frosted glass like the header.
- **New Appearance section** with the Modern/Classic segmented control.

### Chunks page ([chunks.html](chunks.html))

- `body`: deep base + drifting aurora orbs (Signature).
- `.header`: frosted glass (refine existing `blur(14px)` → `blur(24px) saturate(160%)`), specular edge.
- `#progressSection`, `.progress-bar-track/fill`: glass track, gradient fill unchanged (accent→teal).
- `.chunk-card`: near-opaque glass, 16px radius, specular top edge. State borders (done/error/processing) refined to softer glass-tinted edges with a faint glow on `processing`.
- `.chunk-header`: subtle glass hover, specular top edge.
- **`.chunk-content-area`: near-opaque (≥0.92 over solid base), no blur, no animation** — the reading surface is sacrosanct (Reading-first constraint).
- `.chunk-actions` (sticky footer): frosted glass with specular top edge (currently opaque `--surface`).
- `.part-tab`, `.chunk-micro-bar`: refined to glass; gradient fill unchanged.
- Toast, dropdowns, spinner: elevated glass with specular edge.

## Accessibility & robustness

- `prefers-reduced-motion: reduce` → halt aurora drift, keep all static glass (color/specular remain).
- Keyboard focus: visible accent ring + glow preserved on all interactive elements (unchanged behavior).
- Contrast: text-on-glass computed against the **worst-case** backdrop (solid base), not the translucent layer, to guarantee WCAG AA regardless of what sits behind the glass.
- `backdrop-filter` falls back gracefully: where unsupported, `@supports not (backdrop-filter)` collapses glass surfaces to the opaque base color — legible, just without the frost. No broken layouts.
- Responsive breakpoints (existing) preserved; the modern layer only changes surface treatment, not layout.
- The Old UI remains fully usable when `data-ui="classic"` (or attribute absent on a fresh install that somehow defaults to it).

## Testing plan

1. Fresh install → `uiTheme` unset → boot defaults to `modern` → Settings shows Modern, Appearance toggle = Modern.
2. Toggle to Classic in Appearance → page restyles live to the existing flat UI, no reload.
3. Toggle back to Modern → glass returns.
4. Reload both pages in both themes → no FOUC, correct theme persists.
5. Chunks page: read a long translated session in Modern — content area opaque, text crisp, aurora visible only behind cards, no motion sickness. Verify `prefers-reduced-motion` halts the aurora.
6. `@supports not (backdrop-filter)` path: disable blur in devtools → glass collapses to opaque, all text still legible, layout intact.
7. Classic theme visually identical to the current production UI (same inline CSS, unchanged rendering) — the only HTML additions are the Appearance nav item and the `<link>`/`<script>` tags, which are inert under Classic. Visual-diff the two states.
8. Export/import settings round-trips `uiTheme` (it's a normal local setting).

## Out of scope / future

- A per-session UI preference on the chunks page (currently inherits the global setting) — not needed; the global toggle is enough for v1.
- Refining the extension icon / brand mark.
- Light-mode glass (the brief pins dark).
