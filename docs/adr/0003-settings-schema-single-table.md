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
