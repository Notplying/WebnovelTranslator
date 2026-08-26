# The settings schema is one shared table

## Decision

All settings are described by a single flat table in `settings.js`: key → `{ default, type, min, max, integer, allowEmpty, area, elementId }`. Every loop that touches settings derives from the table:

- load (options page → form)
- save (form → storage, through the table-driven numeric sanitizer)
- export / import allow-list
- fresh-install defaults (`storage.local.set(DEFAULTS)` on `onInstalled`)

`NON_SETTING_STORAGE_KEYS` (and `IMPORTABLE_DATA_KEYS`) also live there.

## Context

Before the table, five lists spelled out the same schema by hand — `DEFAULTS`, the load list, the save list, the sanitizer's hardcoded fallbacks, and the import allow-list — and they had drifted: a fresh install differed from a Save All (`retryCount` 1 vs 3, `openaiModelId` '' vs `gpt-4o-mini`, divergent `prefix`). Drift bugs of that class are impossible when every path reads one table.

## Consequences

- Adding a setting = one row, then the form element. No five-place edit to forget.
- Install is structurally identical to Save All.
- The sanitizer is testable through the table (`tests/settings.test.js`).
- The table is the contract for drift-free behavior; a future review should not re-suggest a duplicate-list refactor.

## Exception: instant-apply settings

A setting row may carry `instant: true`. The Save All loop filters these rows out (`options.js:119`: `if (def.area === 'sync' || def.instant) continue;`); the `change` handler on the form element writes them straight to `storage.local` via `setRaw` instead, so the change takes effect on the next paint without a Save All click. The `uiTheme` row is the only current user. Rationale: the theme must apply instantly, and Save All is a coarse-grained user action that doesn't fit a per-keystroke visual. Adding a second `instant` row is allowed but should be a deliberate decision (e.g. a future "show debug log" toggle that needs to take effect mid-session), not a convenience. The flag keeps the exception table-driven — every instant row is still described by the schema, just with a different persistence path.

## Consequence: migration is implicit, not one-shot

There is no explicit `onInstalled` migration step for users upgrading from a pre-UI-Rework version. The "existing users are migrated to Modern once" claim is achieved by the schema default: pre-UI-Rework users have no `storage.local.uiTheme` row, the schema default `uiTheme: 'modern'` is merged in by `{ ...DEFAULTS, ...stored }` in `options.js:74`, and the next page load re-applies Modern and re-mirrors to `localStorage`. A future reader looking for an explicit migration code path will not find one — by design.
