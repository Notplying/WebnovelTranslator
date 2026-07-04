# Few-Shot Examples — Design Spec

**Date:** 2026-07-03
**Feature:** Save a customizable number of recent (raw → translation) pairs and inject them as few-shot examples into the translation prompt.
**Status:** Approved (brainstormed 2026-07-03)
**Target version:** manifest `3.0.12` → `3.0.13`

## Goal

Improve translation consistency and quality by feeding the model example (raw text → translation result) pairs drawn from recent work. The user controls how many examples are used; custom (persistent) examples can be curated alongside an auto-maintained pool of recent translations.

## Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Example source | Persistent cross-session pool (rolling recent translations across all pages) |
| Injection format | Native per provider — multi-turn for API providers, inline text block for web-automation providers |
| Pool trigger | Per chunk — each successfully translated chunk is a candidate |
| Size guardrail | Count cap + auto-fit to provider context window (sacrifice examples, never content) |
| Auto pool + custom | Two separate storage arrays; custom examples take priority within the count cap |
| Manage UI | New options-page section with toggle, settings, and management for both pools |

## Architecture

Approach A from brainstorming: a single new focused module `fewshot.js` holds the shared pool/format/fit logic; provider functions change only by ~3–5 lines each to consume it. No grand refactor of the existing inline-prompt style.

```
content.js ─┐
           ├──> service_worker.js ──> processChunk() ──> [Gemini | OpenRouter | OpenAI | ChatGPTWeb | GeminiWeb]
chunks.js ──┘                                          │
                                                        ├── reads fewshot.js (pool/format/fit)
                                                        └── on success: fewshot.js addExample()
options.js ──> fewshot section (settings + management) ──> fewshot.js (pool mutations)
```

## Section 1 — Data model & storage

**Storage location:** `browser.storage.local` (existing pattern).

**New keys:**

- `fewShotExamples` — array of auto-pool example pair objects, newest-first:
  ```js
  { id, raw, translation, timestamp }
  ```
- `fewShotCustomExamples` — array of user-curated persistent example pair objects, insertion order:
  ```js
  { id, raw, translation, timestamp }
  ```

Two separate arrays (not a pinned-flag on one array) because the sets have different lifecycles: auto rotates by recency, custom persists in insertion order.

**New settings (added to `DEFAULTS` in options.js):**

- `fewShotEnabled` (bool, default `false`) — master toggle. Opt-in so existing users see no behavior change on upgrade.
- `fewShotCount` (int, default `3`) — max number of pairs used per request (covers both custom + auto).
- `fewShotMaxExamples` (int, default `20`) — ceiling on stored auto-pool pairs; bounds `storage.local` size.

**Export/import:**

- `fewShotExamples` and `fewShotCustomExamples` are added to `KEYS_TO_EXCLUDE_FROM_EXPORT` (translation content, not config) — same treatment as `processedChunks` / `translationSessions`.
- The three `fewShot*` settings stay exportable (added to `ALLOWED_IMPORT_KEYS`).

**Count semantics:** `fewShotCount` caps the **total** examples in a shot. **Custom examples take priority** — they fill first; auto examples fill remaining slots. With `fewShotCount=3` and 2 custom → 2 custom + 1 auto. With 3 custom → 0 auto. Custom examples implicitly survive rotation without a separate pin mechanism.

**Clear results:** the existing Data-section **Clear results** button keeps its current scope (`processedChunks` + `translationSessions`) and does NOT touch the few-shot pools. Pools are cleared separately from the management UI.

## Section 2 — The `fewshot.js` module

A single new file, loaded by the SW and options page before their own scripts. Single-purpose, side-effect-free helpers.

### Pool management

```js
// ─── Auto pool (rolling recent) ───
// Append a newly-translated pair. Dedupes by raw text; enforces the
// fewShotMaxExamples rolling cap (drops oldest = tail).
async function addExample({ raw, translation, timestamp }) {}

// Read current auto pool.
async function getExamples() {}

// Wipe the auto pool only.
async function clearExamples() {}

// ─── Custom (persistent, user-managed) ───
async function addCustomExample({ raw, translation, timestamp }) {}
async function getCustomExamples() {}
async function removeCustomExample(id) {}
async function clearCustomExamples() {}   // clears custom only
```

### Selection + formatting

```js
// Merge custom-first + auto-newest, dedupe by raw text, cap to fewShotCount,
// then auto-fit to the provider's context budget. The single entry point
// providers call. Returns the final example list to inject.
//   maxBudgetChars: provider context window in chars (0 = bypass fitting)
//   chunkText:      the user's chunk text (prefix+chunk+suffix), forwarded so
//                   fitExamplesToContext can detect "chunk alone overflows budget"
//                   and return [] in that case.
async function selectForShot({ maxBudgetChars, chunkText }) {
    const { fewShotCount = 3 } = await browser.storage.local.get('fewShotCount');  // read-only config read
    const custom = await getCustomExamples();   // insertion order (oldest→newest)
    const auto = await getExamples();            // newest-first
    // Custom takes priority: fill custom first, remaining slots from auto.
    const merged = dedupeByRaw([...custom, ...auto]).slice(0, fewShotCount);  // standalone helper; custom wins on raw collision
    // Order oldest→newest (newest pair last, closest to the real user turn).
    const ordered = [...merged].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    return fitExamplesToContext({ examples: ordered, chunkText, budgetChars: maxBudgetChars });
}

// For Gemini/OpenRouter/OpenAI: alternating turns, newest pair LAST
// (most recent example sits closest to the real user turn).
// Returns array shaped to the OpenAI chat schema:
//   [{role:'user', content: raw}, {role:'assistant', content: translation}, ...]
function buildExampleMessages(examples) {}

// For ChatGPT Web / Gemini Web: a single text block prepended to the
// pasted prompt, since web automation only pastes one blob.
function buildExampleTextBlock(examples) {}
```

### Auto-fit guardrail

```js
// Drop oldest examples first (and if still too big, truncate the oldest
// surviving example pair) until examples fit the budget.
// If the chunk alone would overflow, drop ALL examples (never trim the chunk).
function fitExamplesToContext({ examples, chunkText, budgetChars }) {}
```

**Design notes:**

- Size math in **characters** (`string.length`). Context-window settings are per-provider (`geminiContextWindow`, `openRouterContextWindow`, `openaiContextWindow`) — treated as char budgets. Token count ≈ chars × 4 for English, fewer per token for CJK; char math is a conservative, model-agnostic heuristic. Documented in code.
- `buildExampleTextBlock` produces a clearly-delimited block mirroring the extension's existing tag-based default prompt style (`<Instructions>` / `<Excerpt>`):

  ```
  <Examples>
  <Example>
  <Raw>原文本...</Raw>
  <Translation>译文...</Translation>
  </Example>
  ...
  </Examples>
  ```

- The module **reads** the `fewShot*` config values via `browser.storage.local.get`, but never *writes* config — it only writes to the two pool arrays. Clean boundary: config flows down into the selection; selection never mutates config.

## Section 3 — Provider integration

Minimal, uniform touch per provider; all shared logic stays in `fewshot.js`.

### Trigger for adding to the auto pool

A chunk's translation is final when the stream completes successfully (`isComplete: true`, no error). At that point — the call to `updateChunksPage(..., { isComplete: true })` near the end of each provider function — also call `addExample({ raw: message.chunk, translation: fullContent, timestamp: Date.now() })`.

- One added line per provider, right after the final `updateChunksPage`.
- Success path only, not the error/catch path, so failed translations never pollute the pool.
- Web-automation providers (ChatGPT Web, Gemini Web) settle `fullContent` from injected-script callbacks; the same success-path → `addExample` rule applies (verify exact success-completion point per provider during implementation).

### API providers (Gemini, OpenRouter, OpenAI) — multi-turn injection

Today each builds a single `parts` / `messages` entry: `` `${prefix}\n${chunk}\n${suffix}` ``. The change:

1. Before building the request body:
   ```js
   const budget = parseInt(options.<provider>ContextWindow) || 0;
   const examples = options.fewShotEnabled ? await selectForShot({ maxBudgetChars: budget }) : [];
   const exampleTurns = buildExampleMessages(examples);   // []
   ```
2. The user's actual chunk **stays** in the `<Instructions>…<Excerpt>…</Excerpt>` wrapped form — it becomes the final user turn.
3. Prepend the example turns:
   - **Gemini** (`processChunkWithGemini`, `service_worker.js:387`): `contents` becomes `[...exampleContents, { role:'user', parts:[{text: chunkText}] }]` where each example turn is `{role:'user'|'assistant', parts:[{text}]}`.
   - **OpenAI / OpenRouter** (`processChunkWithOpenAICompatible`, `service_worker.js:511`): `messages` becomes `[...exampleMessages, {role:'user', content: chunkText}]`.
   - Both `buildExampleMessages` helpers map to the provider's native shape from the same internal `[{role,content}]` array; provider functions just spread + cast.

### Web-automation providers (ChatGPT Web, Gemini Web) — inline block injection

Today: `const fullContent = \`${prefix}\n${chunk}\n${suffix}\``. The change:

```js
const examples = options.fewShotEnabled ? await selectForShot({ maxBudgetChars: 0 }) : [];
const exampleBlock = buildExampleTextBlock(examples);
const fullContent = exampleBlock
    ? `${exampleBlock}\n\n${prefix}\n${message.chunk}\n${suffix}`
    : `${prefix}\n${message.chunk}\n${suffix}`;
```

Web providers pass `maxBudgetChars: 0` (no trimming) — we can't reliably know the web model's context window, and the Manage UI already lets the user control pool size via `fewShotCount`.

### What does NOT change

- `prefix` / `suffix` content and chunk-wrapping behavior stay identical — examples are **additive**, never replacing the user's prompt.
- Retry/resume "checkpoint prefix" logic in `chunks.js:477` (Continue-from directive) is untouched — it mutates `prefix` upstream of where examples are injected, so they compose cleanly: examples always come first, then the checkpoint/real-prompt.
- Streaming, abort/timeout, LCS dedup — all untouched.

### Failure modes & guards

- If `selectForShot` or `buildExampleMessages` throws → wrap in try/catch, fall back to **zero examples** and log, rather than failing the translation. Translations must never break because of the few-shot subsystem.
- `fewShotEnabled=false` (default) → all provider code paths short-circuit to `examples=[]`, identical to today's behavior. Upgrade-safety guarantee.
- Pools are read-only at injection time (writes only at the success point of the previous request).

## Section 4 — Options page UI

Existing convention: `.section` (id `section-X`) + matching `.nav-item` (data-section `X`), content as `.card` blocks with `.card-title` + `.field` inputs.

### New nav item + section: `fewshot`

New nav entry between **Prompt** and **Gemini** (prompt-related, sits naturally there):

```html
<button class="nav-item" data-section="fewshot" id="nav-fewshot">
  <span class="icon">📚</span><span>Few-Shot Examples</span>
</button>
```

Section `section-fewshot` contains these cards:

**Card 1 — Settings:**
- Toggle: `fewShotEnabled` (checkbox). When off, the feature is dormant; management cards remain visible but inactive.
- Number input: `fewShotCount` (label "Number of examples per request", range 0–`fewShotMaxExamples`). Tooltip: "Custom examples fill first; auto examples fill the remaining slots. 0 = examples disabled."

**Card 2 — Custom examples (persistent):**
- Inline form: two textareas (`raw`, `translation`) + "Add example" button → `addCustomExample()`.
- Scrollable list of existing custom examples, each row showing a truncated `raw` / `translation` preview and a delete (🗑) button → `removeCustomExample(id)`.
- "Clear all custom" button → `clearCustomExamples()`.

**Card 3 — Auto pool (recent):**
- Read-only count: "X cached recent translations" (refreshes on section open).
- "Clear recent pool" button → `clearExamples()` (auto-only, doesn't touch custom).
- Explanation text: "This pool fills automatically as you translate. Most recent translations are used first."

### Wiring in `options.js`

- `DEFAULTS`: add `fewShotEnabled: false`, `fewShotCount: 3`, `fewShotMaxExamples: 20`.
- `loadSettings()` / `saveSettings()`: read/write the three `fewShot*` settings like existing fields. `fewShotCount` clamped in `sanitizeNumericSettings()`.
- New functions: `renderFewShotCustomList()`, `renderFewShotAutoCount()` — called on section open and after each mutation, mirroring `updatePromptPreview()` pattern.
- Live preview enhancement: extend `updatePromptPreview()` (options.js:175) to show whether examples would be included — a one-line "(N examples will be prepended)" note in the existing preview card. (Light touch; if it complicates the preview logic, flag it and drop it.)
- Key whitelist: add the three `fewShot*` settings to `ALLOWED_IMPORT_KEYS`; both `fewShotExamples` and `fewShotCustomExamples` to the exclude list.

### Clear results scope

The existing Data-section **Clear results** button (options.js:342) keeps its scope (`processedChunks` + `translationSessions`) and gets a confirming label line: "Session results only — does not affect few-shot examples." Few-shot pools are cleared separately from Cards 2/3 above.

## Section 5 — Edge cases, testing & rollout

### Edge cases & semantics

1. **Empty pool, first-ever translation** — `fewShotEnabled=true` but no examples yet → `selectForShot()` returns `[]` → providers get empty-turns/empty-block path → identical to today. No special handling beyond `examples.length` check inside formatters.
2. **Chunk alone exceeds context budget** — `fitExamplesToContext` called with a budget where the chunk itself already overflows it → drop **all** examples, attempt no trimming of the user's chunk. Examples are always the thing sacrificed, never the real content.
3. **Web providers, no context budget** — `maxBudgetChars: 0` means "skip fit, use all merged examples up to `fewShotCount`." User controls size there via `fewShotCount`.
4. **`fewShotCount = 0`** — feature enabled but zero slots → `selectForShot` returns `[]`. Effectively disabled despite the toggle. Documented in tooltip as "0 = examples disabled."
5. **Custom-only operation** — user adds 2 custom examples, sets count to 2 → only those 2 are ever sent; auto pool fills nothing into the shot. Auto pool *can still accumulate* in the background for future use when count is raised or custom is removed.
6. **Duplicate protection** — `addExample` dedupes by raw text within the auto pool; `selectForShot` dedupes across custom+auto by raw text. So re-translating the same chunk doesn't double it.
7. **Concurrency** — SW message handling is effectively single-threaded under MV3; writes to the pool happen at the success point. Reads at injection time read a fresh snapshot via `await browser.storage.local.get`. No mutex needed; documented as an assumption.
8. **Storage quota** — `fewShotMaxExamples` default 20, each pair up to ~14k chars worst-case → ~280KB worst case, well under `storage.local` quotas. Custom examples are user-managed (their responsibility, capped implicitly by `fewShotCount` for *usage* but stored in full — noted in management UI as a soft expectation).

### Testing strategy

Browser extension with no existing test harness (runtime files only). Add a manual test checklist rather than a unit-test framework (scope-creep). The checklist covers:

- **Module logic (testable in a Node sandbox by extracting `fewshot.js`):**
  - `addExample` respects cap & dedup.
  - `selectForShot` merges custom-first + auto-newest, caps to count, dedupes by raw.
  - `fitExamplesToContext` drops oldest-under-budget, hits zero if chunk alone overflows.
  - `buildExampleMessages` produces alternating user/assistant.
  - `buildExampleTextBlock` produces well-formed tagged block.
  - `fewShotEnabled=false` → all formatters return empty.
- **Integration (manual, loaded extension):**
  - Toggle on → translate a chunk on a test page → confirm next chunk's request (via SW `console.debug`) includes example turns/block.
  - Custom example appears in injection.
  - Clearing pools works (auto-only and custom-only).
  - Export/import excludes pool but includes settings.
  - "Clear results" leaves pools intact.

Follow TDD for the pure module logic where feasible to extract and run with Node — invoke the test-driven-development skill during implementation.

### Rollout / migration

- **Version bump:** `3.0.12` → `3.0.13` in `manifest.json`. Gecko id unchanged.
- **Backward compatibility:** new settings default safe (`fewShotEnabled=false`), so existing users upgrade with zero behavior change until they opt in. No data migration — `fewShotExamples` / `fewShotCustomExamples` don't exist yet and are created on first use via `addExample`.
- **First-install defaults** in `service_worker.js` `onInstalled` (line ~67): add the same three `fewShot*` defaults so fresh installs match `DEFAULTS`.
- **README:** add a short "Few-Shot Examples" section documenting the feature and the opt-in toggle.

## Files touched (summary)

| File | Change |
|---|---|
| `fewshot.js` (**new**) | Pool management, selection, formatting, auto-fit |
| `service_worker.js` | Load `fewshot.js`; call `selectForShot` + formatters in each of 5 providers; `addExample` on success; first-install `fewShot*` defaults |
| `options.html` | New `fewshot` nav item + `section-fewshot` with 3 cards |
| `options.js` | `DEFAULTS` + load/save 3 settings; render/manage both pools; export/import key lists; clear-results label |
| `manifest.json` | `3.0.12` → `3.0.13` |
| `README.md` | "Few-Shot Examples" section |
