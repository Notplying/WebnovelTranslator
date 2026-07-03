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
