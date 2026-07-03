# Few-Shot Examples Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save a customizable number of recent (raw → translation) pairs and inject them as few-shot examples into the translation prompt to improve consistency/quality.

**Architecture:** A new focused `fewshot.js` module (loaded by the service worker and options page before their own scripts) holds all pool-management, selection, and formatting logic. Each of the 5 translation providers changes by ~3–8 lines to consume it: API providers (Gemini/OpenRouter/OpenAI) get multi-turn example messages prepended and save successful translations to the auto pool; web-automation providers (ChatGPT Web/Gemini Web) get an inline text block prepended but save nothing (they never receive the translation back). A new options-page section exposes the toggle, count setting, and management UI for both the auto pool and custom examples.

**Tech Stack:** Vanilla JS (browser extension MV3), `browser.storage.local` (via webextension-polyfill), no build step, no runtime dependencies. Tests use Node's built-in `node:test` + `node:assert` (Node 18+).

## Global Constraints

- **Manifest version:** bump `3.0.12` → `3.0.13` (manifest.json line 4). Gecko id unchanged.
- **Backward compatibility:** `fewShotEnabled` defaults to `false` everywhere (DEFAULTS, onInstalled first-install). Existing users must see zero behavior change until they opt in.
- **Never break a translation for the few-shot subsystem:** every call into `fewshot.js` from a provider must be guarded so a throw falls back to "no examples" rather than failing the request.
- **Auto pool writes only on success:** `addExample` fires only on the `isComplete: true` success path; never in `catch`.
- **Web-automation providers do not save translations:** they only paste input and never receive the result back, so they call `buildExampleTextBlock`/inject but never `addExample`. (Documented constraint.)
- **Style:** match existing codebase — bare top-level function declarations as globals (like `processChunk`, `WEB_PERMISSIONS`), 4-space indent in service_worker.js, 2-space indent in options.js, `browser.*` (polyfill) not `chrome.*`.
- **Export scope:** `fewShotExamples` and `fewShotCustomExamples` are excluded from settings export (translation content); the three `fewShot*` config settings are exportable.
- **Spec:** the authoritative design is `docs/superpowers/specs/2026-07-03-few-shot-examples-design.md`. Two deliberate refinements to the spec are made below (flagged); they are the implementer's contract.

### Refinements to the spec (implement to these, not the spec text)

1. **`selectForShot` signature:** `selectForShot({ maxBudgetChars, chunkText })` — adds `chunkText` (the spec showed only `maxBudgetChars`). Without `chunkText`, `fitExamplesToContext` cannot detect "chunk alone overflows budget."
2. **`fitExamplesToContext` does not truncate pairs:** it keeps a contiguous block of the newest examples that fit and drops whole oldest examples; if even the newest single example doesn't fit (or the chunk alone overflows), it returns `[]`. Rationale: a truncated (mid-sentence) example pair is lower quality and may confuse the model more than help; whole-example dropping is cleaner and predictable.

---

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `fewshot.js` | Pool storage, selection (merge/dedupe/cap/fit), formatting (messages + text block) | New |
| `tests/fewshot.test.js` | Node tests for `fewshot.js` pure logic + storage funcs with a `browser` mock | New |
| `service_worker.js` | Load `fewshot.js`; inject examples into 5 providers; `addExample` on API success; first-install defaults | Modify |
| `manifest.json` | Add `fewshot.js` to `background.scripts`; bump version | Modify |
| `options.html` | Load `fewshot.js`; new `fewshot` nav item + `section-fewshot` (3 cards) | Modify |
| `options.js` | DEFAULTS + load/save; render/manage both pools; export/import keys; clear-results label | Modify |
| `README.md` | "Few-Shot Examples" section documenting the feature + web-automation caveat | Modify |

---

## Task 1: Create `fewshot.js` — pool + storage functions (with tests)

**Files:**
- Create: `fewshot.js`
- Create: `tests/fewshot.test.js`

**Interfaces:**
- Consumes: `browser.storage.local` (`get`/`set`) — provided by polyfill in browser, by a mock in tests.
- Produces (this task): `addExample({raw, translation, timestamp})`, `getExamples()`, `clearExamples()`, `addCustomExample({raw, translation, timestamp})`, `getCustomExamples()`, `removeCustomExample(id)`, `clearCustomExamples()`. Also reads settings `fewShotCount`/`fewShotMaxExamples` from storage.

**Contract notes for later tasks:** `addExample` writes to `fewShotExamples` (array, newest-first), dedupes by `raw`, caps length to `fewShotMaxExamples` (default 20, dropping the oldest = last element). `getExamples()` returns the array (possibly empty). Custom examples live in `fewShotCustomExamples` (insertion order, appended). `id` is a string (`timestamp`-based, see Step 3). All functions are async. In the browser they're bare globals; in Node they're `module.exports`.

- [ ] **Step 1: Write the failing tests for pool/storage**

Create `tests/fewshot.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

// ─── In-memory browser.storage.local mock ───────────────────────────────────
const store = {};
global.browser = {
  storage: {
    local: {
      async get(keys) {
        if (keys === null || keys === undefined) return { ...store };
        const ks = typeof keys === 'string' ? [keys] : keys;
        const out = {};
        for (const k of ks) if (k in store) out[k] = store[k];
        return out;
      },
      async set(obj) { Object.assign(store, obj); },
    },
  },
};

// Set defaults the module expects to read
store.fewShotMaxExamples = 20;
store.fewShotCount = 3;

const FewShot = require('../fewshot.js');

test('addExample stores a pair newest-first', async () => {
  store.fewShotExamples = [];
  await FewShot.addExample({ raw: 'a', translation: 'A', timestamp: 1 });
  await FewShot.addExample({ raw: 'b', translation: 'B', timestamp: 2 });
  const got = await FewShot.getExamples();
  assert.equal(got.length, 2);
  assert.equal(got[0].raw, 'b');      // newest first
  assert.equal(got[1].raw, 'a');
});

test('addExample dedupes by raw text', async () => {
  store.fewShotExamples = [];
  await FewShot.addExample({ raw: 'dup', translation: 'first', timestamp: 1 });
  await FewShot.addExample({ raw: 'dup', translation: 'second', timestamp: 2 });
  const got = await FewShot.getExamples();
  assert.equal(got.length, 1);
  assert.equal(got[0].translation, 'second');  // re-added bumps to front with new translation
});

test('addExample caps to fewShotMaxExamples, dropping oldest', async () => {
  store.fewShotMaxExamples = 3;
  store.fewShotExamples = [];
  await FewShot.addExample({ raw: '1', translation: 't', timestamp: 1 });
  await FewShot.addExample({ raw: '2', translation: 't', timestamp: 2 });
  await FewShot.addExample({ raw: '3', translation: 't', timestamp: 3 });
  await FewShot.addExample({ raw: '4', translation: 't', timestamp: 4 });
  const got = await FewShot.getExamples();
  assert.equal(got.length, 3);
  assert.deepEqual(got.map(e => e.raw), ['4', '3', '2']);  // oldest ('1') dropped
});

test('clearExamples removes the auto pool only', async () => {
  store.fewShotExamples = [{ id: '1', raw: 'a', translation: 'A', timestamp: 1 }];
  store.fewShotCustomExamples = [{ id: 'c1', raw: 'c', translation: 'C', timestamp: 9 }];
  await FewShot.clearExamples();
  const got = await FewShot.getExamples();
  assert.equal(got.length, 0);
  const custom = await FewShot.getCustomExamples();
  assert.equal(custom.length, 1);  // custom untouched
});

test('custom examples: add in insertion order, remove by id, clear independently', async () => {
  store.fewShotCustomExamples = [];
  await FewShot.addCustomExample({ raw: 'r1', translation: 't1', timestamp: 1 });
  await FewShot.addCustomExample({ raw: 'r2', translation: 't2', timestamp: 2 });
  let custom = await FewShot.getCustomExamples();
  assert.deepEqual(custom.map(c => c.raw), ['r1', 'r2']);  // insertion order
  await FewShot.removeCustomExample(custom[0].id);
  custom = await FewShot.getCustomExamples();
  assert.deepEqual(custom.map(c => c.raw), ['r2']);
  await FewShot.clearCustomExamples();
  custom = await FewShot.getCustomExamples();
  assert.equal(custom.length, 0);
});

test('clearCustomExamples does not touch the auto pool', async () => {
  store.fewShotExamples = [{ id: 'x', raw: 'a', translation: 'A', timestamp: 1 }];
  store.fewShotCustomExamples = [{ id: 'c', raw: 'c', translation: 'C', timestamp: 9 }];
  await FewShot.clearCustomExamples();
  assert.equal((await FewShot.getCustomExamples()).length, 0);
  assert.equal((await FewShot.getExamples()).length, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/fewshot.test.js`
Expected: FAIL — `Cannot find module '../fewshot.js'` (file does not exist yet).

- [ ] **Step 3: Write minimal `fewshot.js` (pool + storage only)**

Create `fewshot.js`:

```js
// fewshot.js — few-shot example pool + prompt formatting for AI Webnovel Translator.
// Loaded before service_worker.js (background) and options.js (options page).
// Top-level functions are browser globals; the module.exports block at the bottom
// enables Node testing (Node-only; inert in the browser).

// ─── Internal helpers ──────────────────────────────────────────────────────────
// Generate a compact unique-ish id (timestamp + counter). Math.random/Date.now in
// the SW are fine; in Node tests timestamps are passed in by the caller.
let _idCounter = 0;
function makeId(timestamp) {
  _idCounter = (_idCounter + 1) % 100000;
  return `${timestamp || 0}-${_idCounter}`;
}

// ─── Auto pool (rolling recent translations) ──────────────────────────────────
// fewShotExamples: array newest-first. Each pair: { id, raw, translation, timestamp }.
async function addExample({ raw, translation, timestamp }) {
  if (!raw || !translation) return;
  const { fewShotExamples = [] } = await browser.storage.local.get('fewShotExamples');
  const { fewShotMaxExamples = 20 } = await browser.storage.local.get('fewShotMaxExamples');
  // Dedupe by raw: drop any existing entry with the same raw text.
  const filtered = fewShotExamples.filter(e => e.raw !== raw);
  // Newest-first: prepend the new pair.
  const updated = [{ id: makeId(timestamp), raw, translation, timestamp }, ...filtered];
  // Cap to fewShotMaxExamples (drop oldest = tail).
  const capped = updated.slice(0, Math.max(1, fewShotMaxExamples));
  await browser.storage.local.set({ fewShotExamples: capped });
}

async function getExamples() {
  const { fewShotExamples = [] } = await browser.storage.local.get('fewShotExamples');
  return Array.isArray(fewShotExamples) ? fewShotExamples : [];
}

async function clearExamples() {
  await browser.storage.local.set({ fewShotExamples: [] });
}

// ─── Custom examples (persistent, user-managed) ────────────────────────────────
// fewShotCustomExamples: array, insertion order (append). Each pair like above.
async function addCustomExample({ raw, translation, timestamp }) {
  if (!raw || !translation) return null;
  const { fewShotCustomExamples = [] } = await browser.storage.local.get('fewShotCustomExamples');
  const entry = { id: makeId(timestamp), raw, translation, timestamp };
  const updated = [...fewShotCustomExamples, entry];
  await browser.storage.local.set({ fewShotCustomExamples: updated });
  return entry.id;
}

async function getCustomExamples() {
  const { fewShotCustomExamples = [] } = await browser.storage.local.get('fewShotCustomExamples');
  return Array.isArray(fewShotCustomExamples) ? fewShotCustomExamples : [];
}

async function removeCustomExample(id) {
  const { fewShotCustomExamples = [] } = await browser.storage.local.get('fewShotCustomExamples');
  const updated = fewShotCustomExamples.filter(e => e.id !== id);
  await browser.storage.local.set({ fewShotCustomExamples: updated });
}

async function clearCustomExamples() {
  await browser.storage.local.set({ fewShotCustomExamples: [] });
}

// ─── Node export (inert in browser) ───────────────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    addExample, getExamples, clearExamples,
    addCustomExample, getCustomExamples, removeCustomExample, clearCustomExamples,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/fewshot.test.js`
Expected: PASS — all 6 tests pass; exit code 0.

- [ ] **Step 5: Commit**

```bash
git add fewshot.js tests/fewshot.test.js
git commit -m "Add fewshot.js pool + storage functions with Node tests"
```

---

## Task 2: Add pure formatting + selection + fit functions (with tests)

**Files:**
- Modify: `fewshot.js` (add functions + export them)
- Modify: `tests/fewshot.test.js` (add tests)

**Interfaces:**
- Consumes: `getCustomExamples()`/`getExamples()` from Task 1; `browser.storage.local.get('fewShotCount')`.
- Produces (this task):
  - `buildExampleMessages(examples)` → `[{role:'user'|'assistant', content:string}, ...]` ordered oldest→newest (newest last). OpenAI-native shape.
  - `buildExampleTextBlock(examples)` → string `<Examples>…</Examples>` (empty string for empty input).
  - `dedupeByRaw(examples)` → array, first occurrence kept.
  - `fitExamplesToContext({ examples, chunkText, budgetChars })` →array.
  - `selectForShot({ maxBudgetChars, chunkText })` → array of example objects to inject.
- Later tasks rely on these exact names and shapes.

**Refinement contracts (from plan header):**
- `fitExamplesToContext`: `budgetChars <= 0` → bypass (return examples as-is). Else `available = budgetChars - chunkText.length`; if `available <= 0` return `[]`. Keep contiguous newest block (iterate end→start, break on first that doesn't fit).
- `selectForShot`: merge custom-first + auto-newest, dedupe by raw (custom wins), cap to `fewShotCount`, order oldest→newest (newest last) by `timestamp`, then `fitExamplesToContext`.

- [ ] **Step 1: Write the failing tests for formatting + selection + fit**

Append to `tests/fewshot.test.js` (before the `FewShot` require is best — actually the require is already at top; just add new tests at the bottom of the file):

```js
const { buildExampleMessages, buildExampleTextBlock, dedupeByRaw,
        fitExamplesToContext, selectForShot } = require('../fewshot.js');

const EX = [
  { id: '1', raw: 'raw-A', translation: 'trans-A', timestamp: 100 },
  { id: '2', raw: 'raw-B', translation: 'trans-B', timestamp: 200 },
  { id: '3', raw: 'raw-C', translation: 'trans-C', timestamp: 300 },
];

test('buildExampleMessages alternates user/assistant, newest last', () => {
  const msgs = buildExampleMessages(EX);
  assert.equal(msgs.length, 6);
  assert.deepEqual(msgs.map(m => m.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  assert.equal(msgs[0].content, 'raw-A');
  assert.equal(msgs[1].content, 'trans-A');
  assert.equal(msgs[5].content, 'trans-C');  // newest pair, assistant turn last
});

test('buildExampleMessages empty input returns []', () => {
  assert.deepEqual(buildExampleMessages([]), []);
});

test('buildExampleTextBlock wraps pairs in <Examples> tags', () => {
  const block = buildExampleTextBlock([EX[0]]);
  assert.ok(block.startsWith('<Examples>'));
  assert.ok(block.endsWith('</Examples>'));
  assert.ok(block.includes('<Raw>raw-A</Raw>'));
  assert.ok(block.includes('<Translation>trans-A</Translation>'));
});

test('buildExampleTextBlock empty input returns empty string', () => {
  assert.equal(buildExampleTextBlock([]), '');
});

test('dedupeByRaw keeps first occurrence', () => {
  const dup = [{ raw: 'x', translation: '1', timestamp: 1 }, { raw: 'x', translation: '2', timestamp: 2 }];
  assert.deepEqual(dedupeByRaw(dup).map(e => e.translation), ['1']);
});

test('fitExamplesToContext bypass when budgetChars <= 0', () => {
  const out = fitExamplesToContext({ examples: EX, chunkText: 'bigchunk', budgetChars: 0 });
  assert.equal(out.length, 3);
});

test('fitExamplesToContext drops oldest to fit budget', () => {
  // Each EX pair is 12 chars (e.g. raw-A=5 + trans-A=7). budget 30, chunk 'thirteenchars'
  // (13 chars) → available = 17 → fits ONE pair (12), not two (24). Newest (raw-C) kept.
  const out = fitExamplesToContext({ examples: EX, chunkText: 'thirteenchars', budgetChars: 30 });
  assert.equal(out.length, 1);
  assert.equal(out[0].raw, 'raw-C');
});

test('fitExamplesToContext drops all when chunk alone overflows', () => {
  const out = fitExamplesToContext({ examples: EX, chunkText: 'x'.repeat(100), budgetChars: 30 });
  assert.equal(out.length, 0);
});

test('selectForShot merges custom-first + auto-newest, caps, orders newest last', async () => {
  store.fewShotCount = 3;
  store.fewShotMaxExamples = 20;
  store.fewShotCustomExamples = [
    { id: 'c1', raw: 'custom-1', translation: 'c1-t', timestamp: 50 },
    { id: 'c2', raw: 'custom-2', translation: 'c2-t', timestamp: 250 },
  ];
  store.fewShotExamples = [
    { id: 'a1', raw: 'auto-1', translation: 'a1-t', timestamp: 300 },  // newest
    { id: 'a2', raw: 'auto-2', translation: 'a2-t', timestamp: 100 },
  ];
  const out = await selectForShot({ maxBudgetChars: 0, chunkText: '' });  // bypass fit
  assert.equal(out.length, 3);  // 2 custom + 1 auto (count=3)
  // newest last: timestamps 50(c1), 100(a2), 250(c2), 300(a1) → but count cap=3 keeps custom-first
  // Keep set = [c1, c2, a1(newest auto)]; sorted by timestamp asc => [c1(50), a2?...]
  // Actually: remaining after custom = count-len(custom) = 1; auto taken = [newest auto = a1]
  // kept = [c1, c2, a1]; sorted asc => [c1(50), c2(250), a1(300)] → newest (a1) last
  assert.deepEqual(out.map(e => e.id), ['c1', 'c2', 'a1']);
});

test('selectForShot dedupes by raw across custom+auto (custom wins)', async () => {
  store.fewShotCount = 5;
  store.fewShotCustomExamples = [{ id: 'c1', raw: 'shared', translation: 'custom-ver', timestamp: 10 }];
  store.fewShotExamples = [{ id: 'a1', raw: 'shared', translation: 'auto-ver', timestamp: 999 }];
  const out = await selectForShot({ maxBudgetChars: 0, chunkText: '' });
  assert.equal(out.length, 1);
  assert.equal(out[0].translation, 'custom-ver');  // custom wins
});

test('selectForShot returns [] when fewShotCount is 0', async () => {
  store.fewShotCount = 0;
  store.fewShotCustomExamples = [{ id: 'c1', raw: 'x', translation: 'y', timestamp: 1 }];
  store.fewShotExamples = [];
  const out = await selectForShot({ maxBudgetChars: 0, chunkText: '' });
  assert.equal(out.length, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/fewshot.test.js`
Expected: FAIL — `buildExampleMessages`, `dedupeByRaw`, etc. are undefined (not exported).

- [ ] **Step 3: Add the formatting + selection + fit functions to `fewshot.js`**

In `fewshot.js`, insert these functions **before** the `if (typeof module !== 'undefined' …)` export block, and add them to the `module.exports` object:

```js
// ─── Pure formatting helpers ───────────────────────────────────────────────────
// Alternating user/assistant turns, oldest→newest (newest pair last, closest to the
// real user turn in the final prompt). OpenAI-native shape: { role, content }.
function buildExampleMessages(examples) {
  const out = [];
  for (const ex of examples) {
    out.push({ role: 'user', content: ex.raw });
    out.push({ role: 'assistant', content: ex.translation });
  }
  return out;
}

// Inline text block for web-automation providers (single pasted blob).
// Mirrors the extension's tag-based prompt style (<Instructions>/<Excerpt>).
function buildExampleTextBlock(examples) {
  if (!examples || examples.length === 0) return '';
  const parts = examples.map(ex =>
    `<Example>\n<Raw>${ex.raw}</Raw>\n<Translation>${ex.translation}</Translation>\n</Example>`
  );
  return `<Examples>\n${parts.join('\n')}\n</Examples>`;
}

// Keep first occurrence of each raw text (custom appears before auto in selectForShot,
// so custom wins on collision).
function dedupeByRaw(examples) {
  const seen = new Set();
  const out = [];
  for (const ex of examples) {
    if (seen.has(ex.raw)) continue;
    seen.add(ex.raw);
    out.push(ex);
  }
  return out;
}

// Drop oldest whole examples to fit the provider's context budget (chars).
// budgetChars <= 0 → bypass (no fitting; web providers + unconfigured API windows).
// Keeps a contiguous block of the NEWEST examples (drops oldest); if the chunk alone
// overflows the budget, or even the newest single example doesn't fit, returns [].
// Note: deliberately does NOT truncate pairs (truncated examples are low quality).
function fitExamplesToContext({ examples, chunkText, budgetChars }) {
  if (!budgetChars || budgetChars <= 0) return examples;
  const available = budgetChars - (chunkText || '').length;
  if (available <= 0) return [];
  const kept = [];
  let used = 0;
  for (let i = examples.length - 1; i >= 0; i--) {
    const ex = examples[i];
    const size = (ex.raw || '').length + (ex.translation || '').length;
    if (used + size > available) break;  // stop at first (going newest→oldest) that won't fit
    kept.unshift(ex);
    used += size;
  }
  return kept;
}

// ─── Selection (single entry point providers call) ────────────────────────────
// Merge custom-first + auto-newest, dedupe by raw (custom wins), cap to fewShotCount,
// order oldest→newest (newest last), then auto-fit to the provider's context budget.
//   maxBudgetChars: provider context window in chars (0 = bypass fitting)
//   chunkText:      the user's chunk text (prefix+chunk+suffix) for fit overflow check
async function selectForShot({ maxBudgetChars, chunkText }) {
  const { fewShotCount = 3 } = await browser.storage.local.get('fewShotCount');
  const custom = await getCustomExamples();        // insertion order (oldest→newest)
  const auto = await getExamples();                // newest-first
  // Custom takes priority: fill custom first, then remaining slots from auto (newest first).
  const remaining = Math.max(0, fewShotCount - custom.length);
  const autoTaken = auto.slice(0, remaining);
  const merged = [...custom, ...autoTaken];
  const deduped = dedupeByRaw(merged).slice(0, fewShotCount);
  // Order oldest→newest (newest last, closest to the real user turn).
  const ordered = [...deduped].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return fitExamplesToContext({ examples: ordered, chunkText, budgetChars: maxBudgetChars });
}
```

Update the `module.exports` block to include the new functions:

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    addExample, getExamples, clearExamples,
    addCustomExample, getCustomExamples, removeCustomExample, clearCustomExamples,
    buildExampleMessages, buildExampleTextBlock, dedupeByRaw,
    fitExamplesToContext, selectForShot,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/fewshot.test.js`
Expected: PASS — all tests (Task 1's 6 + Task 2's 9 = 15) pass; exit code 0.

- [ ] **Step 5: Commit**

```bash
git add fewshot.js tests/fewshot.test.js
git commit -m "Add fewshot formatting, selection, and fit helpers with tests"
```

---

## Task 3: Wire `fewshot.js` into load order (manifest + options.html)

**Files:**
- Modify: `manifest.json` (line 38-42 `background.scripts`, line 4 version)
- Modify: `options.html` (lines 867-869 script tags)

**Interfaces:**
- Consumes: `fewshot.js` (from Tasks 1–2).
- Produces: `fewshot.js` loaded as a classic script in the service-worker global scope (visible to `service_worker.js`) and in the options-page scope (visible to `options.js`). Top-level functions (`addExample`, `selectForShot`, `buildExampleMessages`, `buildExampleTextBlock`, `getExamples`, `getCustomExamples`, `addCustomExample`, `removeCustomExample`, `clearExamples`, `clearCustomExamples`) are now bare globals available to the rest of each page.

**Note:** `chunks.html` (lines 856-859) does NOT load `fewshot.js` — `chunks.js` neither injects prompts nor manages the pool; the service worker does both.

- [ ] **Step 1: Add `fewshot.js` to manifest background.scripts and bump version**

In `manifest.json`, change the `background.scripts` array (currently lines 38–42) from:

```json
    "scripts": [
      "browser-polyfill.min.js",
      "shared_web_permissions.js",
      "service_worker.js"
    ]
```

to:

```json
    "scripts": [
      "browser-polyfill.min.js",
      "shared_web_permissions.js",
      "fewshot.js",
      "service_worker.js"
    ]
```

And change `"version": "3.0.12"` (line 4) to `"version": "3.0.13"`.

- [ ] **Step 2: Add `fewshot.js` script tag to options.html**

In `options.html`, change lines 867-869 from:

```html
  <script src="browser-polyfill.min.js"></script>
  <script src="shared_web_permissions.js"></script>
  <script src="options.js"></script>
```

to:

```html
  <script src="browser-polyfill.min.js"></script>
  <script src="shared_web_permissions.js"></script>
  <script src="fewshot.js"></script>
  <script src="options.js"></script>
```

- [ ] **Step 3: Verify the extension still loads with no errors**

Load/reload the extension in the browser (Firefox `about:debugging` or Chrome `chrome://extensions`):
1. Reload the extension. Expected: no errors in the service-worker console.
2. Open the Options page. Expected: opens with no console errors, existing nav still works.

(If a CI/lint is desired, no automated test for this step — it is a wiring step validated manually. Continue.)

- [ ] **Step 4: Commit**

```bash
git add manifest.json options.html
git commit -m "Load fewshot.js in service worker and options page; bump to 3.0.13"
```

---

## Task 4: Inject few-shot examples into the Gemini provider + save on success

**Files:**
- Modify: `service_worker.js` — `processChunkWithGemini` (request body at lines 386-402, success `updateChunksPage` at line 492).

**Interfaces:**
- Consumes: `selectForShot({maxBudgetChars, chunkText})`, `buildExampleMessages(examples)`, `addExample({raw, translation, timestamp})` — bare globals from `fewshot.js`.
- Produces: Gemini requests now include example turns when `options.fewShotEnabled`; successful Gemini translations are saved to the auto pool.

**Gemini shape note:** Gemini uses role `'model'` for assistant turns (not `'assistant'`) and `parts: [{text}]`. `buildExampleMessages` returns OpenAI-shaped `{role:'user'|'assistant', content}`; cast in this function.

- [ ] **Step 1: Modify the Gemini request body to prepend example turns**

In `service_worker.js`, inside `processChunkWithGemini`, replace the `requestBody` construction (lines 386-402, the block starting `const requestBody = { contents: [{ parts: [{ text: \`${message.prefix}\n${message.chunk}\n${message.suffix}\` }] }],`) with:

```js
    const chunkText = `${message.prefix}\n${message.chunk}\n${message.suffix}`;
    let exampleContents = [];
    try {
      if (options.fewShotEnabled) {
        const budget = parseInt(options.geminiContextWindow) || 0;
        const examples = await selectForShot({ maxBudgetChars: budget, chunkText });
        exampleContents = buildExampleMessages(examples)
          .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
      }
    } catch (e) { console.error('[fewshot] Gemini example selection failed:', e); }

    const requestBody = {
        contents: [...exampleContents, { role: 'user', parts: [{ text: chunkText }] }],
        generationConfig: {
            temperature: (v => Number.isFinite(v) ? v : 0.9)(parseFloat(options.temperature)),
            topK: (v => Number.isFinite(v) ? v : 40)(parseInt(options.topK)),
            topP: (v => Number.isFinite(v) ? v : 0.95)(parseFloat(options.topP)),
            thinkingConfig: {
                thinkingBudget: 0,
            }
        },
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DARMOUS_CONTENT', threshold: 'BLOCK_NONE' },
        ],
    };
```

(Keep the existing `if (options.geminiMaxTokens?.trim()) { ... }` block at lines 403-406 exactly as-is, immediately after `requestBody`.)

- [ ] **Step 2: Add `addExample` on the Gemini success path**

In `service_worker.js`, find the Gemini success line (line 492):

```js
            updateChunksPage(sessionId, { action: 'updateStreamContent', content: fullContent, rawContent: message.chunk, isComplete: true });
            await new Promise(r => setTimeout(r, 100));
            return { result: fullContent, streaming: true, complete: true };
```

Change it to:

```js
            updateChunksPage(sessionId, { action: 'updateStreamContent', content: fullContent, rawContent: message.chunk, isComplete: true });
            if (options.fewShotEnabled && fullContent) {
                try { await addExample({ raw: message.chunk, translation: fullContent, timestamp: Date.now() }); }
                catch (e) { console.error('[fewshot] addExample failed:', e); }
            }
            await new Promise(r => setTimeout(r, 100));
            return { result: fullContent, streaming: true, complete: true };
```

- [ ] **Step 3: Manual verification (no automated test for SW provider integration)**

1. Reload the extension. Open Options → Few-Shot Examples → enable the toggle (set in Task 7/8; if the UI isn't built yet, set `fewShotEnabled=true` and `fewShotCount=2` via `about:debugging` storage inspector or the browser console: `browser.storage.local.set({fewShotEnabled:true, fewShotCount:2})`).
2. Add a custom example via storage: `browser.storage.local.set({fewShotCustomExamples:[{id:'t1',raw:'テスト',translation:'test',timestamp:1}]})`.
3. Translate a page with the Gemini provider. In the SW console, watch the network request to `streamGenerateContent`: the `contents` array should start with the example turns (`role:'model'`/`'user'`) before the real chunk turn.
4. After the translation completes, verify the auto pool gained an entry: `browser.storage.local.get('fewShotExamples')` shows the just-translated pair.

- [ ] **Step 4: Commit**

```bash
git add service_worker.js
git commit -m "Inject few-shot examples into Gemini; save successful translations"
```

---

## Task 5: Inject few-shot examples into OpenRouter + OpenAI; save on success

**Files:**
- Modify: `service_worker.js` — `processChunkWithOpenRouter` (request body at lines 572-589), `processChunkWithOpenAI` (request body at lines 591-605), shared `processChunkWithOpenAICompatible` (success path at line 554).

**Interfaces:**
- Consumes: `selectForShot`, `buildExampleMessages`, `addExample` (globals from `fewshot.js`).
- Produces: OpenRouter/OpenAI chat requests prepend example messages; successful translations are saved to the auto pool (single shared success point covers both providers).

**OpenAI shape note:** `buildExampleMessages` returns `{role:'user'|'assistant', content}` directly — that is already the OpenAI chat schema. Spread + the real user turn.

- [ ] **Step 1: Prepend example messages in `processChunkWithOpenRouter`**

In `service_worker.js`, replace the top of `processChunkWithOpenRouter` (lines 572-577) from:

```js
async function processChunkWithOpenRouter(message, options) {
    const requestBody = {
        model: options.openRouterModelId || 'openai/gpt-4',
        messages: [{ role: 'user', content: `${message.prefix}\n${message.chunk}\n${message.suffix}` }],
        stream: true
    };
```

to:

```js
async function processChunkWithOpenRouter(message, options) {
    const chunkText = `${message.prefix}\n${message.chunk}\n${message.suffix}`;
    let exampleMessages = [];
    try {
        if (options.fewShotEnabled) {
            const budget = parseInt(options.openRouterContextWindow) || 0;
            const examples = await selectForShot({ maxBudgetChars: budget, chunkText });
            exampleMessages = buildExampleMessages(examples);
        }
    } catch (e) { console.error('[fewshot] OpenRouter example selection failed:', e); }
    const requestBody = {
        model: options.openRouterModelId || 'openai/gpt-4',
        messages: [...exampleMessages, { role: 'user', content: chunkText }],
        stream: true
    };
```

- [ ] **Step 2: Prepend example messages in `processChunkWithOpenAI`**

In `service_worker.js`, replace the top of `processChunkWithOpenAI` (lines 591-596) from:

```js
async function processChunkWithOpenAI(message, options) {
    const requestBody = {
        model: options.openaiModelId || 'gpt-4o-mini',
        messages: [{ role: 'user', content: `${message.prefix}\n${message.chunk}\n${message.suffix}` }],
        stream: true
    };
```

to:

```js
async function processChunkWithOpenAI(message, options) {
    const chunkText = `${message.prefix}\n${message.chunk}\n${message.suffix}`;
    let exampleMessages = [];
    try {
        if (options.fewShotEnabled) {
            const budget = parseInt(options.openaiContextWindow) || 0;
            const examples = await selectForShot({ maxBudgetChars: budget, chunkText });
            exampleMessages = buildExampleMessages(examples);
        }
    } catch (e) { console.error('[fewshot] OpenAI example selection failed:', e); }
    const requestBody = {
        model: options.openaiModelId || 'gpt-4o-mini',
        messages: [...exampleMessages, { role: 'user', content: chunkText }],
        stream: true
    };
```

- [ ] **Step 3: Add `addExample` on the shared OpenAI-compatible success path**

In `service_worker.js`, inside `processChunkWithOpenAICompatible`, find the success line (line 554):

```js
        updateChunksPage(sessionId, { action: 'updateStreamContent', content: fullContent, reasoning: streamResult.reasoning || '', rawContent: message.chunk, isComplete: true });
        await new Promise(r => setTimeout(r, 100));
        return { result: fullContent, streaming: true, complete: true };
```

Change it to:

```js
        updateChunksPage(sessionId, { action: 'updateStreamContent', content: fullContent, reasoning: streamResult.reasoning || '', rawContent: message.chunk, isComplete: true });
        if (options.fewShotEnabled && fullContent) {
            try { await addExample({ raw: message.chunk, translation: fullContent, timestamp: Date.now() }); }
            catch (e) { console.error('[fewshot] addExample failed:', e); }
        }
        await new Promise(r => setTimeout(r, 100));
        return { result: fullContent, streaming: true, complete: true };
```

- [ ] **Step 4: Manual verification**

For each of OpenRouter and OpenAI: set `apiType` to that provider, ensure `fewShotEnabled=true` with a custom example in storage, translate a page, and confirm (via SW console network inspection of `/chat/completions`) the request `messages` array begins with `user`/`assistant` example turns before the real chunk turn. After completion, confirm `browser.storage.local.get('fewShotExamples')` gained the new pair.

- [ ] **Step 5: Commit**

```bash
git add service_worker.js
git commit -m "Inject few-shot examples into OpenRouter/OpenAI; save successful translations"
```

---

## Task 6: Inject few-shot examples into web-automation providers (ChatGPT Web, Gemini Web)

**Files:**
- Modify: `service_worker.js` — `processChunkWithChatGPTWeb` (line 736), `processChunkWithGeminiWeb` (line 771).

**Interfaces:**
- Consumes: `selectForShot({maxBudgetChars:0, chunkText:''})`, `buildExampleTextBlock(examples)` — globals from `fewshot.js`.
- Produces: When enabled, the text pasted into the chat tab is prepended with an `<Examples>` block. **No `addExample`** — these providers never receive the translation back, so they cannot feed the auto pool (documented constraint).

- [ ] **Step 1: Prepend the examples block in `processChunkWithChatGPTWeb`**

In `service_worker.js`, replace line 736:

```js
    const fullContent = `${message.prefix}\n${message.chunk}\n${message.suffix}`;
```

with:

```js
    const chunkText = `${message.prefix}\n${message.chunk}\n${message.suffix}`;
    let exampleBlock = '';
    try {
        if (options.fewShotEnabled) {
            const examples = await selectForShot({ maxBudgetChars: 0, chunkText: '' });
            exampleBlock = buildExampleTextBlock(examples);
        }
    } catch (e) { console.error('[fewshot] ChatGPT Web example selection failed:', e); }
    const fullContent = exampleBlock ? `${exampleBlock}\n\n${chunkText}` : chunkText;
```

- [ ] **Step 2: Prepend the examples block in `processChunkWithGeminiWeb`**

In `service_worker.js`, replace line 771:

```js
    const fullContent = `${message.prefix}\n${message.chunk}\n${message.suffix}`;
```

with the identical block:

```js
    const chunkText = `${message.prefix}\n${message.chunk}\n${message.suffix}`;
    let exampleBlock = '';
    try {
        if (options.fewShotEnabled) {
            const examples = await selectForShot({ maxBudgetChars: 0, chunkText: '' });
            exampleBlock = buildExampleTextBlock(examples);
        }
    } catch (e) { console.error('[fewshot] Gemini Web example selection failed:', e); }
    const fullContent = exampleBlock ? `${exampleBlock}\n\n${chunkText}` : chunkText;
```

- [ ] **Step 3: Manual verification**

Set `apiType` to `chatgptWeb` (with host+tabs permissions granted), `fewShotEnabled=true`, and a custom example in storage. Translate a page. In the ChatGPT tab that opens, the pasted text should begin with the `<Examples>…</Examples>` block followed by the normal prompt. Repeat for `geminiWeb`. (Auto pool will not grow from these — expected.)

- [ ] **Step 4: Commit**

```bash
git add service_worker.js
git commit -m "Inject few-shot examples into ChatGPT/Gemini Web automation"
```

---

## Task 7: Add the options-page Few-Shot section (HTML)

**Files:**
- Modify: `options.html` — add a nav item (after line 537) and a new `<section>` (after the prompt section, after line 663).

**Interfaces:**
- Consumes: element IDs that Task 8 wires up.
- Produces: a nav button `nav-fewshot` (`data-section="fewshot"`) and `section-fewshot` containing cards with these IDs:
  - Settings: `#fewShotEnabled` (checkbox), `#fewShotCount` (number input), `#fewShotMaxExamples` (number input).
  - Custom management: `#fewShotCustomRaw` (textarea), `#fewShotCustomTranslation` (textarea), `#fewShotAddCustom` (button), `#fewShotCustomList` (list container), `#fewShotClearCustom` (button).
  - Auto pool: `#fewShotAutoCount` (text span), `#fewShotClearAuto` (button).

- [ ] **Step 1: Add the nav item**

In `options.html`, after the prompt nav item (line 537, `<button class="nav-item" data-section="prompt" id="nav-prompt">…`), insert:

```html
      <button class="nav-item" data-section="fewshot" id="nav-fewshot">
        <span class="icon">📚</span><span>Few-Shot Examples</span>
      </button>
```

(Place it between the `prompt` and `gemini` nav items — it is prompt-related.)

- [ ] **Step 2: Add the `section-fewshot` markup**

In `options.html`, immediately after the prompt section closes (after the `</section>` at line 663 that ends `section-prompt`), insert:

```html
    <!-- ── Few-Shot Examples ─────────────────────────────────────── -->
    <section class="section" id="section-fewshot">
      <div class="page-header">
        <h1>Few-Shot Examples</h1>
        <p>Save recent (raw → translation) pairs and inject them as few-shot examples to improve consistency. Custom examples take priority within the count.</p>
      </div>

      <div class="card">
        <div class="card-title">⚙️ Settings</div>
        <div class="field">
          <label><input type="checkbox" id="fewShotEnabled"> Enable few-shot examples</label>
        </div>
        <div class="field">
          <label for="fewShotCount">Number of examples per request</label>
          <input type="number" id="fewShotCount" min="0" max="100" step="1">
          <small>Custom examples fill first; auto examples fill the remaining slots. 0 = examples disabled.</small>
        </div>
        <div class="field">
          <label for="fewShotMaxExamples">Max recent translations to keep (auto pool size)</label>
          <input type="number" id="fewShotMaxExamples" min="1" max="100" step="1">
        </div>
      </div>

      <div class="card">
        <div class="card-title">📌 Custom Examples (persistent)</div>
        <div class="field">
          <label for="fewShotCustomRaw">Raw text</label>
          <textarea id="fewShotCustomRaw" rows="4" placeholder="Original text excerpt…"></textarea>
        </div>
        <div class="field">
          <label for="fewShotCustomTranslation">Translation</label>
          <textarea id="fewShotCustomTranslation" rows="4" placeholder="Desired translation…"></textarea>
        </div>
        <button type="button" id="fewShotAddCustom" class="primary">➕ Add example</button>
        <div id="fewShotCustomList" class="example-list"></div>
        <button type="button" id="fewShotClearCustom">🗑 Clear all custom</button>
      </div>

      <div class="card">
        <div class="card-title">🕒 Recent Translations (auto pool)</div>
        <p>This pool fills automatically as you translate with API providers (Gemini, OpenRouter, OpenAI). Most recent translations are used first.</p>
        <p><strong id="fewShotAutoCount">0</strong> cached recent translations.</p>
        <button type="button" id="fewShotClearAuto">🗑 Clear recent pool</button>
      </div>
    </section>
```

- [ ] **Step 3: Verify the section renders and is reachable**

Reload the Options page. Click the "Few-Shot Examples" nav item. Expected: the section appears with all three cards and the inputs/buttons visible. (No behavior yet — wiring is Task 8.)

- [ ] **Step 4: Commit**

```bash
git add options.html
git commit -m "Add Few-Shot Examples section to options page"
```

---

## Task 8: Wire the options-page Few-Shot section (JS) + first-install defaults

**Files:**
- Modify: `options.js` — `DEFAULTS` (lines 4-24), `loadSettings` field list (lines 85-92), `sanitizeNumericSettings` (lines 102-114), `saveSettings` `raw` object (lines 125-162), `setupNav` (lines 39-50), `KEYS_TO_EXCLUDE_FROM_EXPORT` (line 26), `updatePromptPreview` (lines 175-185), `DOMContentLoaded` init (around lines 280-320). Add new render/management functions.
- Modify: `service_worker.js` — first-install defaults in `onInstalled` (lines 67-98).

**Interfaces:**
- Consumes: `fewShot*` element IDs (from Task 7); `fewshot.js` globals (`getCustomExamples`, `addCustomExample`, `removeCustomExample`, `clearCustomExamples`, `getExamples`, `clearExamples`, `selectForShot`, `buildExampleMessages`).
- Produces: settings persist/load; the two pools render and are manageable; export excludes pools; first-install sets the three `fewShot*` defaults.

- [ ] **Step 1: Add `fewShot*` defaults to `DEFAULTS` in options.js**

In `options.js`, in the `DEFAULTS` object (lines 4-24), add these three keys (insert before the closing `};` at line 24, after `webAutomationTimeout: 30,`):

```js

  fewShotEnabled: false,
  fewShotCount: 3,
  fewShotMaxExamples: 20,
```

- [ ] **Step 2: Add the pool keys to `KEYS_TO_EXCLUDE_FROM_EXPORT`**

In `options.js`, change line 26 from:

```js
const KEYS_TO_EXCLUDE_FROM_EXPORT = ['processedChunks', 'translationSessions'];
```

to:

```js
const KEYS_TO_EXCLUDE_FROM_EXPORT = ['processedChunks', 'translationSessions', 'fewShotExamples', 'fewShotCustomExamples'];
```

- [ ] **Step 3: Add `fewShot*` to `loadSettings` field list**

In `options.js`, in `loadSettings` (lines 85-92), append `'fewShotEnabled', 'fewShotCount', 'fewShotMaxExamples'` to the array. The array (lines 85-92) becomes:

```js
  ['apiType', 'maxLength', 'prefix', 'suffix', 'retryCount', 'temperature', 'topK', 'topP', 'maxSessions', 'chunkFontSize', 'chunkMaxWidth',
    'geminiApiKey', 'geminiModelId', 'geminiMaxTokens', 'geminiContextWindow',

    'openRouterApiKey', 'openRouterModelId', 'openRouterMaxTokens', 'openRouterContextWindow', 'openRouterProviderOrder', 'openRouterAllowFallback',
    'openaiApiKey', 'openaiModelId', 'openaiMaxTokens', 'openaiContextWindow', 'openaiBaseUrl',

    'apiTimeout', 'webAutomationTimeout',

    'fewShotEnabled', 'fewShotCount', 'fewShotMaxExamples'
  ].forEach(key => { setField(key, settings[key]); });
```

- [ ] **Step 4: Add clamps in `sanitizeNumericSettings`**

In `options.js`, in the returned object of `sanitizeNumericSettings` (lines 102-114), add three entries before the closing `}`. Insert after the `topP: ...` line (line 113):

```js
    fewShotCount: clamp(parseInt2(raw.fewShotCount, DEFAULTS.fewShotCount), 0, 100),
    fewShotMaxExamples: clamp(parseInt2(raw.fewShotMaxExamples, DEFAULTS.fewShotMaxExamples), 1, 100),
```

(`fewShotEnabled` is a boolean checkbox — no sanitize needed; it flows through `sanitizeNumericSettings` unchanged via the `...raw` spread.)

- [ ] **Step 5: Add `fewShot*` to the `saveSettings` `raw` object**

In `options.js`, in `saveSettings` (lines 125-162), add the three fields to `raw`. Insert after the `webAutomationTimeout: getField('webAutomationTimeout'),` line (line 160), before the closing `};` (line 162):

```js

    fewShotEnabled: getField('fewShotEnabled'),
    fewShotCount: getField('fewShotCount'),
    fewShotMaxExamples: getField('fewShotMaxExamples'),
```

- [ ] **Step 6: Add render + management functions**

In `options.js`, insert a new block (e.g. after `updatePromptPreview`, after line 185):

```js
// ─── Few-Shot management ──────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function renderFewShotCustomList() {
  const list = document.getElementById('fewShotCustomList');
  if (!list) return;
  const items = await getCustomExamples();
  if (items.length === 0) {
    list.innerHTML = '<p class="muted">No custom examples yet.</p>';
    return;
  }
  list.innerHTML = items.map(ex => {
    const raw = escapeHtml(ex.raw.length > 120 ? ex.raw.slice(0, 120) + '…' : ex.raw);
    const tr  = escapeHtml(ex.translation.length > 120 ? ex.translation.slice(0, 120) + '…' : ex.translation);
    return `<div class="example-row">
      <div class="example-cell"><strong>Raw:</strong> ${raw}</div>
      <div class="example-cell"><strong>Translation:</strong> ${tr}</div>
      <button type="button" class="danger fewshot-remove" data-id="${escapeHtml(ex.id)}">🗑</button>
    </div>`;
  }).join('');
  list.querySelectorAll('.fewshot-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      await removeCustomExample(btn.dataset.id);
      await renderFewShotCustomList();
      updatePromptPreview();
      showToast('🗑 Custom example removed', 'success');
    });
  });
}

async function renderFewShotAutoCount() {
  const el = document.getElementById('fewShotAutoCount');
  if (!el) return;
  const items = await getExamples();
  el.textContent = String(items.length);
}

async function addFewShotCustomFromForm() {
  const raw = document.getElementById('fewShotCustomRaw')?.value?.trim();
  const translation = document.getElementById('fewShotCustomTranslation')?.value?.trim();
  if (!raw || !translation) { showToast('⚠️ Both raw text and translation are required.', 'error'); return; }
  await addCustomExample({ raw, translation, timestamp: Date.now() });
  document.getElementById('fewShotCustomRaw').value = '';
  document.getElementById('fewShotCustomTranslation').value = '';
  await renderFewShotCustomList();
  updatePromptPreview();
  showToast('➕ Custom example added', 'success');
}

async function clearFewShotAuto() {
  if (!confirm('Clear ALL recent translations from the auto pool? Custom examples are kept.')) return;
  await clearExamples();
  await renderFewShotAutoCount();
  updatePromptPreview();
  showToast('🗑 Recent pool cleared', 'success');
}

async function clearFewShotCustom() {
  if (!confirm('Clear ALL custom examples?')) return;
  await clearCustomExamples();
  await renderFewShotCustomList();
  updatePromptPreview();
  showToast('🗑 Custom examples cleared', 'success');
}
```

- [ ] **Step 7: Render the few-shot section when its nav opens, and wire its buttons**

In `options.js`, in `setupNav` (lines 39-50), add a render hook inside the click listener. Replace the listener body (lines 42-48) — currently:

```js
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(b => { b.classList.remove('active'); });
      document.querySelectorAll('.section').forEach(s => { s.classList.remove('active'); });
      btn.classList.add('active');
      const target = document.getElementById('section-' + btn.dataset.section);
      if (target) target.classList.add('active');
    });
```

with:

```js
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(b => { b.classList.remove('active'); });
      document.querySelectorAll('.section').forEach(s => { s.classList.remove('active'); });
      btn.classList.add('active');
      const target = document.getElementById('section-' + btn.dataset.section);
      if (target) target.classList.add('active');
      if (btn.dataset.section === 'fewshot') {
        renderFewShotCustomList();
        renderFewShotAutoCount();
      }
    });
```

Then, in the `DOMContentLoaded` init (around line 305, near the other button listeners — after the `importButton` listener), add:

```js
  // Few-Shot management
  document.getElementById('fewShotAddCustom')?.addEventListener('click', addFewShotCustomFromForm);
  document.getElementById('fewShotClearCustom')?.addEventListener('click', clearFewShotCustom);
  document.getElementById('fewShotClearAuto')?.addEventListener('click', clearFewShotAuto);
  document.getElementById('fewShotCount')?.addEventListener('input', updatePromptPreview);
  document.getElementById('fewShotEnabled')?.addEventListener('change', updatePromptPreview);
```

- [ ] **Step 8: Extend `updatePromptPreview` to show the example count note**

In `options.js`, replace `updatePromptPreview` (lines 175-185) with:

```js
function updatePromptPreview() {
  const prefix = document.getElementById('prefix')?.value || '';
  const suffix = document.getElementById('suffix')?.value || '';
  const sample = '[Sample chunk text would appear here...]';
  const preview = document.getElementById('promptPreview');
  if (!preview) return;
  const full = prefix + '\n' + sample + '\n' + suffix;
  const escaped = full.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let highlighted = escaped.replace(/\[Sample chunk text would appear here\.\.\.\]/g, '<em>[Sample chunk text would appear here...]</em>');
  const enabled = document.getElementById('fewShotEnabled')?.checked;
  if (enabled) {
    const count = parseInt(document.getElementById('fewShotCount')?.value, 10) || 0;
    highlighted = `<div class="badge">${count} example(s) will be prepended</div>\n` + highlighted;
  }
  preview.innerHTML = highlighted;
}
```

- [ ] **Step 9: Add the Clear-results label note (Data section)**

In `options.html`, find the existing Clear results button in section-data (search for the button whose handler is the clear-results flow). Add a `<small>` line directly under its card title or button describing scope. (The implementer should locate the "Clear results" button in `section-data` and add immediately below it:)

```html
        <small class="muted">Session results only — does not affect few-shot examples.</small>
```

(In `options.js`, confirm the `clearResults`/clear-data handler — around line 342 per the spec — still calls only the session `clear`; it must NOT touch `fewShotExamples`/`fewShotCustomExamples`. No code change to the handler if it already only clears session keys; only the HTML label is added.)

- [ ] **Step 10: Add first-install `fewShot*` defaults in the service worker**

In `service_worker.js`, in the `onInstalled` listener (lines 67-98), add the three defaults inside the `browser.storage.local.set({...})` call. Insert after `maxSessions: 3` (line 95), before the closing `});` (line 96):

```js
            ,
            fewShotEnabled: false,
            fewShotCount: 3,
            fewShotMaxExamples: 20
```

(Comma-first to follow the existing object literal style; match surrounding indentation.)

- [ ] **Step 11: Manual end-to-end verification**

1. Reload the extension. Open Options → Few-Shot Examples.
2. Toggle Enable on, set count to 2, set max examples to 20, Save.
3. Add a custom example (raw + translation) → it appears in the list; Delete (🗑) works; Clear all works.
4. Reload the Options page → settings and custom list persist (Load reads them back).
5. Export settings → open the downloaded JSON → confirm `fewShotEnabled`/`fewShotCount`/`fewShotMaxExamples` are present but `fewShotExamples`/`fewShotCustomExamples` are absent.
6. Import a previously exported file → settings restore; pools untouched.
7. Click Clear results (Data section) → confirm the auto/custom pools survive (check the few-shot section counts after).
8. Trigger a translation (any provider) → few-shot section auto count updates for API providers on next section open.

- [ ] **Step 12: Commit**

```bash
git add options.js options.html service_worker.js
git commit -m "Wire Few-Shot options UI, settings, pool management, and first-install defaults"
```

---

## Task 9: Document the feature in the README

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: `options.html` (Task 7).
- Produces: A short user-facing section explaining the feature, the toggle, custom vs auto, and the web-automation caveat.

- [ ] **Step 1: Add a "Few-Shot Examples" section to the README**

In `README.md`, add a new section (place it near the other feature/usage sections). Content:

```markdown
## Few-Shot Examples

The translator can prepend recent (raw → translation) pairs to the prompt as
few-shot examples, improving consistency in terminology and style.

- **Enable** it under **Options → Few-Shot Examples** and turn on "Enable few-shot examples".
- **Number of examples per request** controls how many pairs are sent. Set to `0` to disable.
- **Custom examples (persistent):** add your own raw/translation pairs that always go first
  and survive rotation — useful for pinning a canonical translation of a tricky term.
- **Recent translations (auto pool):** fills automatically as you translate. The most recent
  translations are used first. Custom examples take priority within the count cap.

### Provider notes

- **Gemini, OpenRouter, OpenAI** (API providers): examples are sent as proper alternating
  user/assistant message turns. Successful translations are automatically saved to the pool.
  Set each provider's **context window** so the extension can drop examples that would
  overflow the model's limit.
- **ChatGPT Web / Gemini Web** (web automation): examples are prepended as an inline text
  block. Web automation does not read the translation back, so it **cannot feed the auto
  pool** — use custom examples, or translate with an API provider first to populate the pool.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "Document the Few-Shot Examples feature in the README"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Section 1 (data model & storage) → Tasks 1 (storage funcs + keys), 2, 8 (DEFAULTS + export exclusion + onInstalled defaults). ✓
- Section 2 (`fewshot.js` module, pool/format/fit, `selectForShot`, char budgeting, tag-based block) → Tasks 1, 2. ✓
- Section 3 (provider integration: Gemini multi-turn, OpenAI/OpenRouter multi-turn, web inline, `addExample` on API success, examples-first ordering, fall-back-to-empty guard) → Tasks 4, 5, 6. ✓ (Web providers correctly omit `addExample` — the spec's "verify success point per provider" resolved to: web providers have no translation result, documented as a constraint.)
- Section 4 (options UI: nav item, 3 cards, settings load/save, render/management, export/import lists, clear-results scope) → Tasks 7, 8. ✓
- Section 5 (edge cases, manual test checklist, rollout) → covered by per-task manual steps + Task 9 docs + version bump in Task 3. ✓ Edge case 4 (`fewShotCount=0` → `[]`) is explicitly tested in Task 2.

**Placeholder scan:** No "TBD"/"TODO"/"add error handling". Every code step shows the actual code. The one location where the implementer must locate an element (Clear results button, Task 8 Step 9) gives a precise search anchor (`section-data`, handler near line 342) and an exact HTML snippet — acceptable.

**Type/name consistency:**
- `addExample`, `getExamples`, `clearExamples`, `addCustomExample`, `getCustomExamples`, `removeCustomExample`, `clearCustomExamples` — defined Task 1, used Task 1 (tests), Task 8 (options). ✓
- `selectForShot({maxBudgetChars, chunkText})` — defined Task 2, called Tasks 4/5/6 with matching args. ✓
- `buildExampleMessages(examples)` — defined Task 2, used Tasks 4/5. ✓
- `buildExampleTextBlock(examples)` — defined Task 2, used Task 6. ✓ `fitExamplesToContext`, `dedupeByRaw` — defined Task 2, used internally. ✓
- Storage keys `fewShotExamples` / `fewShotCustomExamples` — consistent across Tasks 1, 8, export exclusion. ✓
- Settings `fewShotEnabled` / `fewShotCount` / `fewShotMaxExamples` — consistent across Tasks 2 (reads fewShotCount/fewShotMaxExamples), 8 (DEFAULTS/load/save/sanitize), onInstalled. ✓

**Signature fix flagged:** `selectForShot` now takes `{maxBudgetChars, chunkText}` (spec refinement #1). `fitExamplesToContext` does whole-example dropping, no truncation (spec refinement #2). Both documented in the plan header for user approval.
