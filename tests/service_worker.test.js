// Service worker edge: pure helpers, provider config builders, error mapping.
// Run: node --test tests/service_worker.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { installStorageFake } = require('./helpers/storage-fake.js');
const { memory, reset } = installStorageFake();

// Mirror the worker's global shape: the Firefox background.scripts load order
// puts the shared modules on globalThis before service_worker.js runs.
Object.assign(globalThis, require('../settings.js'));
Object.assign(globalThis, require('../store.js'));
Object.assign(globalThis, require('../collections.js'));
Object.assign(globalThis, require('../llm.js'));
Object.assign(globalThis, require('../fewshot.js'));
Object.assign(globalThis, require('../shared_web_permissions.js'));

// AbortController / TextEncoder are Node globals. The worker's setInterval
// cleanup stays harmless (browser.tabs.query fake below). The event-listener
// registration at module load needs no-op stubs. The installStorageFake above
// already set globalThis.browser — extend it with the worker's other surfaces.
const noopListeners = { addListener() {}, removeListener() {} };
globalThis.browser.storage.sync = { async get() { return {}; } };
globalThis.browser.runtime = {
  onMessage: { addListener() {} },
  onInstalled: { addListener() {} },
  getURL: (p) => `moz-extension://test/${p}`,
};
globalThis.browser.tabs = {
  async query() { return []; },
  async create() { return { id: 999 }; },
  onUpdated: noopListeners,
  onRemoved: noopListeners,
};
globalThis.browser.action = { onClicked: { addListener() {} } };
globalThis.browser.scripting = {};
globalThis.browser.permissions = {};

// All worker modules must be loaded as bare globals (service_worker.js does
// not import them) — evaluate it once and destructure the exports.
// Stub setInterval: the worker registers a 15-minute cleanup interval at
// load; Node must not stay alive waiting on it.
globalThis.setInterval = () => ({});
const {
  urlPatternToRegExp, withMaxTokens, withTemperature,
  HTTP_PROVIDER_CONFIGS, respond, messageHandlers, processChunk,
  ensureWebPermission, hasStoredWebPermission, setStoredWebPermission,
  requestAndStoreWebPermission,
} = require('../service_worker.js');

// ─── urlPatternToRegExp (pure) ─────────────────────────────────────────────────

test('urlPatternToRegExp: anchors and escapes regex metacharacters', () => {
  assert.ok(urlPatternToRegExp('https://chatgpt.com/*').test('https://chatgpt.com/'));
  assert.ok(urlPatternToRegExp('https://chatgpt.com/*').test('https://chatgpt.com/anything/else'));
  assert.ok(!urlPatternToRegExp('https://chatgpt.com/*').test('https://chatgpt.comx/page'));
});

test('urlPatternToRegExp: exact pattern without wildcard anchors fully', () => {
  const re = urlPatternToRegExp('https://example.com/');
  assert.ok(re.test('https://example.com/'));
  assert.ok(!re.test('https://example.com/page'));
});

test('urlPatternToRegExp: dots are literal, not wildcard', () => {
  const re = urlPatternToRegExp('https://a.b.c/*');
  assert.ok(!re.test('https://axbxc/page'));
  assert.ok(re.test('https://a.b.c/page'));
});

// ─── withMaxTokens / withTemperature (pure) ────────────────────────────────────

test('withMaxTokens: positive integer written to body', () => {
  const body = {};
  withMaxTokens(body, 'max_tokens', 'openaiMaxTokens', { openaiMaxTokens: '4096' });
  assert.deepEqual(body, { max_tokens: 4096 });
});

test('withMaxTokens: empty / non-numeric / non-positive skipped', () => {
  assert.deepEqual(withMaxTokens({}, 'max_tokens', 'k', { k: '' }), {});
  assert.deepEqual(withMaxTokens({}, 'max_tokens', 'k', { k: 'abc' }), {});
  assert.deepEqual(withMaxTokens({}, 'max_tokens', 'k', { k: '-3' }), {});
  assert.deepEqual(withMaxTokens({}, 'max_tokens', 'k', {}), {});
});

test('withTemperature: numeric string written', () => {
  assert.deepEqual(withTemperature({}, { temperature: '0.7' }), { temperature: 0.7 });
});

test('withTemperature: number written', () => {
  assert.deepEqual(withTemperature({}, { temperature: 1 }), { temperature: 1 });
});

test('withTemperature: non-numeric skipped', () => {
  assert.deepEqual(withTemperature({}, { temperature: '' }), {});
  assert.deepEqual(withTemperature({}, {}), {});
});

// ─── HTTP_PROVIDER_CONFIGS builders (pure) ─────────────────────────────────────

test('gemini: buildUrl uses the model id and SSE endpoint', () => {
  const url = HTTP_PROVIDER_CONFIGS.gemini.buildUrl({ geminiModelId: 'gemini-2.0-flash' });
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse');
});

test('gemini: API key travels in the x-goog-api-key header, not the URL', () => {
  const headers = HTTP_PROVIDER_CONFIGS.gemini.buildHeaders({ geminiApiKey: 'SECRET-KEY' });
  assert.deepEqual(headers, { 'Content-Type': 'application/json', 'x-goog-api-key': 'SECRET-KEY' });
  assert.ok(!HTTP_PROVIDER_CONFIGS.gemini.buildUrl({ geminiModelId: 'm' }).includes('SECRET-KEY'));
});

test('gemini: buildBody casts examples to model/user roles and appends the user chunk', () => {
  const body = HTTP_PROVIDER_CONFIGS.gemini.buildBody(
    { geminiMaxTokens: '', temperature: '0.5', topK: '40', topP: '0.9' },
    { prefix: 'P', chunk: 'C', suffix: 'S' },
    [{ role: 'user', content: 'raw' }, { role: 'assistant', content: 'trans' }],
  );
  assert.equal(body.contents[0].role, 'user');
  assert.equal(body.contents[1].role, 'model'); // assistant -> model
  assert.deepEqual(body.contents[2], { role: 'user', parts: [{ text: 'P\nC\nS' }] });
  assert.deepEqual(body.generationConfig, {
    temperature: 0.5, topK: 40, topP: 0.9, thinkingConfig: { thinkingBudget: 0 },
  });
  assert.equal(body.generationConfig.maxOutputTokens, undefined); // empty max -> skipped
});

test('gemini: buildBody parses non-finite config fallbacks to DEFAULTS', () => {
  const body = HTTP_PROVIDER_CONFIGS.gemini.buildBody(
    { temperature: 'abc', topK: 'x', topP: '' },
    { prefix: '', chunk: 'C', suffix: '' },
    [],
  );
  assert.equal(body.generationConfig.temperature, DEFAULTS.temperature);
  assert.equal(body.generationConfig.topK, DEFAULTS.topK);
  assert.equal(body.generationConfig.topP, DEFAULTS.topP);
});

test('gemini: buildBody positive maxOutputTokens written', () => {
  const body = HTTP_PROVIDER_CONFIGS.gemini.buildBody(
    { geminiMaxTokens: '2048' },
    { prefix: '', chunk: 'C', suffix: '' },
    [],
  );
  assert.equal(body.generationConfig.maxOutputTokens, 2048);
});

test('openRouter: buildBody model fallback, max_tokens, temperature, provider order', () => {
  const body = HTTP_PROVIDER_CONFIGS.openRouter.buildBody(
    { openRouterProviderOrder: 'novita, other ', openRouterAllowFallback: true },
    { prefix: '', chunk: 'C', suffix: '' },
    [],
  );
  assert.equal(body.model, 'openai/gpt-4');
  assert.deepEqual(body.provider, { order: ['novita', 'other'], allow_fallbacks: true });
});

test('openRouter: provider order skipped when empty; allow_fallbacks false honored', () => {
  const body = HTTP_PROVIDER_CONFIGS.openRouter.buildBody(
    { openRouterProviderOrder: '', openRouterAllowFallback: false },
    { prefix: '', chunk: 'C', suffix: '' },
    [],
  );
  assert.equal(body.provider, undefined);
  const withOrder = HTTP_PROVIDER_CONFIGS.openRouter.buildBody(
    { openRouterProviderOrder: 'a,b', openRouterAllowFallback: false },
    { prefix: '', chunk: 'C', suffix: '' },
    [],
  );
  assert.equal(withOrder.provider.allow_fallbacks, false);
});

test('openai: buildUrl respects custom base URL', () => {
  assert.equal(
    HTTP_PROVIDER_CONFIGS.openai.buildUrl({ openaiBaseUrl: 'https://my-proxy.example/v1' }),
    'https://my-proxy.example/v1/chat/completions',
  );
});

test('openai: buildUrl falls back to api.openai.com', () => {
  assert.equal(HTTP_PROVIDER_CONFIGS.openai.buildUrl({}), 'https://api.openai.com/v1/chat/completions');
});

test('openai: buildBody defaults model to gpt-4o-mini and writes max_tokens', () => {
  const body = HTTP_PROVIDER_CONFIGS.openai.buildBody(
    { openaiMaxTokens: '1000', temperature: '0.2' },
    { prefix: '', chunk: 'C', suffix: '' },
    [],
  );
  assert.equal(body.model, 'gpt-4o-mini');
  assert.equal(body.max_tokens, 1000);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.stream, true);
});

test('HTTP provider builders: messages append examples before the user turn', () => {
  const examples = [{ role: 'user', content: 'r' }, { role: 'assistant', content: 't' }];
  const body = HTTP_PROVIDER_CONFIGS.openai.buildBody({}, { prefix: 'P', chunk: 'C', suffix: 'S' }, examples);
  assert.equal(body.messages.length, 3);
  assert.deepEqual(body.messages[2], { role: 'user', content: 'P\nC\nS' });
});

// ─── respond (error mapping through sendResponse) ──────────────────────────────

test('respond: resolves sendResponse with the promise value, returns true', async () => {
  let response = null;
  const ret = respond((val) => { response = val; }, Promise.resolve({ ok: 1 }), 'testAction');
  assert.equal(ret, true);
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(response, { ok: 1 });
});

test('respond: rejection becomes { error: message }', async () => {
  let response = null;
  respond((val) => { response = val; }, Promise.reject(new Error('boom')), 'testAction');
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(response, { error: 'boom' });
});

// ─── messageHandlers (routing) ────────────────────────────────────────────────

test('messageHandlers: openChunksPage message builds a payload with defaults', async () => {
  const result = await messageHandlers.openChunksPage({
    chunks: ['a', 'b'], prefix: 'P', suffix: 'S', retryCount: 5,
  });
  assert.deepEqual(result, { success: true });
  // The session was persisted to storage under a content-hash session id.
  const { translationSessions = [] } = await browser.storage.local.get('translationSessions');
  assert.equal(translationSessions.length, 1);
  const { id, timestamp, firstChunk, ...stored } = translationSessions[0];
  assert.ok(id.length === 64); // sha-256 hex of the content hash
  assert.equal(firstChunk, 'a');
  assert.deepEqual(stored, { chunks: ['a', 'b'], prefix: 'P', suffix: 'S', retryCount: 5 });
});

test('messageHandlers: reprocessEntry throws on missing sessionId or non-string rawContent', () => {
  assert.throws(() => messageHandlers.reprocessEntry({ chunkIndex: 0, rawContent: 'x' }), /Invalid input\./);
  assert.throws(() => messageHandlers.reprocessEntry({ sessionId: 's', chunkIndex: 0 }), /Invalid input\./);
});

test('messageHandlers: removeEntriesFromCollection removes only the listed entries', async () => {
  reset();
  const { collection } = await createCollection('C');
  await addEntryToCollection(collection.id, { sessionId: 's1', chunkIndex: 0 });
  await addEntryToCollection(collection.id, { sessionId: 's1', chunkIndex: 1 });
  const ids = (await getCollections()).collections[collection.id].entries.map(e => e.id);
  const res = await messageHandlers.removeEntriesFromCollection({ collectionId: collection.id, entryIds: [ids[0]] });
  assert.equal(res.removed, 1);
  const after = (await getCollections()).collections[collection.id];
  assert.deepEqual(after.entries.map(e => e.id), [ids[1]]);
});

test('messageHandlers: getStoredData returns empty defaults for unknown session', async () => {
  const result = await messageHandlers.getStoredData({ sessionId: 'nope' });
  assert.deepEqual(result, { chunks: [], prefix: '', suffix: '', retryCount: DEFAULTS.retryCount });
});

test('messageHandlers: getStoredData returns the stored session shape', async () => {
  const session = { id: 'abc', chunks: ['c'], prefix: 'P', suffix: 'S', retryCount: 2 };
  memory.set('translationSessions', [session]);
  const result = await messageHandlers.getStoredData({ sessionId: 'abc' });
  assert.deepEqual(result, { chunks: ['c'], prefix: 'P', suffix: 'S', retryCount: 2 });
});

// ─── web permissions (storage-backed) ─────────────────────────────────────────

test('hasStoredWebPermission: true only when provider stored as true', async () => {
  assert.equal(await hasStoredWebPermission('chatgptWeb'), false);
  memory.set('webPermissions', { chatgptWeb: true });
  assert.equal(await hasStoredWebPermission('chatgptWeb'), true);
  assert.equal(await hasStoredWebPermission('geminiWeb'), false);
});

test('setStoredWebPermission: persists the grant and preserves other providers', async () => {
  memory.set('webPermissions', { chatgptWeb: true });
  await setStoredWebPermission('geminiWeb', true);
  assert.deepEqual(memory.get('webPermissions'), { chatgptWeb: true, geminiWeb: true });
});

test('ensureWebPermission: unknown provider throws', async () => {
  await assert.rejects(() => ensureWebPermission('nope'), /Unknown web provider/);
});

test('ensureWebPermission: grants satisfied only when both origins and permissions contained', async () => {
  // ensureWebPermission calls contains({ origins }) and contains({ permissions })
  // separately — the stub must tolerate either shape.
  browser.permissions.contains = async ({ origins = [], permissions = [] }) =>
    origins.length === 2 || permissions.length === 1;
  assert.equal(await ensureWebPermission('chatgptWeb'), true);
  browser.permissions.contains = async () => false;
  assert.equal(await ensureWebPermission('chatgptWeb'), false);
});

// ─── processChunk routing ─────────────────────────────────────────────────────

test('processChunk: unknown apiType throws', async () => {
  memory.set('apiType', 'bogus');
  await assert.rejects(() => processChunk({}), /Invalid API type selected/);
});
