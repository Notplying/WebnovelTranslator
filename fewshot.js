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
// Serialized read-modify-write via store.js mutate — the SW is single-threaded,
// but storage.local reads await, so two concurrent sessions completing a chunk
// could otherwise interleave a get→set and drop an example.
async function addExample({ raw, translation, timestamp }) {
  if (!raw || !translation) return;
  await mutate('fewShotExamples', async (fewShotExamples = []) => {
    // Dedupe by raw: drop any existing entry with the same raw text.
    const filtered = fewShotExamples.filter(e => e.raw !== raw);
    // Newest-first: prepend the new pair.
    const updated = [{ id: makeId(timestamp), raw, translation, timestamp }, ...filtered];
    // Cap to fewShotMaxExamples (drop oldest = tail).
    const { fewShotMaxExamples = 20 } = await browser.storage.local.get('fewShotMaxExamples');
    const capped = updated.slice(0, Math.max(1, fewShotMaxExamples));
    return { changed: true, result: capped };
  });
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
  let entryId = null;
  await mutate('fewShotCustomExamples', (fewShotCustomExamples = []) => {
    const entry = { id: makeId(timestamp), raw, translation, timestamp };
    entryId = entry.id;
    const updated = [...fewShotCustomExamples, entry];
    return { changed: true, result: updated };
  });
  return entryId;
}

async function getCustomExamples() {
  const { fewShotCustomExamples = [] } = await browser.storage.local.get('fewShotCustomExamples');
  return Array.isArray(fewShotCustomExamples) ? fewShotCustomExamples : [];
}

async function removeCustomExample(id) {
  await mutate('fewShotCustomExamples', (fewShotCustomExamples = []) => {
    const updated = fewShotCustomExamples.filter(e => e.id !== id);
    return { changed: true, result: updated };
  });
}

async function clearCustomExamples() {
  await browser.storage.local.set({ fewShotCustomExamples: [] });
}

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
  // When the custom pool exceeds fewShotCount, prefer the NEWEST custom examples
  // (trim oldest) so recent additions aren't starved — mirrors the auto pool's
  // newest-first policy.
  const customTaken = custom.slice(Math.max(0, custom.length - fewShotCount));
  const remaining = Math.max(0, fewShotCount - customTaken.length);
  const autoTaken = auto.slice(0, remaining);
  const merged = [...customTaken, ...autoTaken];
  const deduped = dedupeByRaw(merged).slice(0, fewShotCount);
  // Order oldest→newest (newest last, closest to the real user turn).
  const ordered = [...deduped].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return fitExamplesToContext({ examples: ordered, chunkText, budgetChars: maxBudgetChars });
}

// ─── Node export (inert in browser) ───────────────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    addExample, getExamples, clearExamples,
    addCustomExample, getCustomExamples, removeCustomExample, clearCustomExamples,
    buildExampleMessages, buildExampleTextBlock, dedupeByRaw,
    fitExamplesToContext, selectForShot,
  };
}
