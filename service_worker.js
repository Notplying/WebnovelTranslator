// service_worker.js — Manifest V3 Service Worker for AI Webnovel Translator
// Cross-browser (Firefox + Chrome) via webextension-polyfill

// In Firefox: background.scripts loads these before this file runs, so no importScripts needed.
// In Chrome: service_worker runs as a true SW with no background.scripts, so we load via importScripts.
// Guard against double-load in either case.
if (typeof browser === 'undefined' || !browser.runtime) {
    importScripts('browser-polyfill.min.js');
    if (typeof WEB_PERMISSIONS === 'undefined') {
        importScripts('shared_web_permissions.js');
    }
}
// jsrsasign-all-min.js removed – no KJUR/RSAKey symbols are used in this file.



// ─── Config ───────────────────────────────────────────────────────────────────
const WebAutomationConfig = {
    DELAY_CHATGPT_MS: 2000,
    DELAY_GEMINI_MS: 3000,
    TAB_LOAD_TIMEOUT_MS: 15000,
    EXECUTION_TIMEOUT_MS: 10000
};

// Per-session streaming state (debounce bookkeeping) lives in llm.js — the
// seam owns it, keyed by sessionId so concurrent streams don't share timers.

// Track tab IDs and AbortControllers per session
let sessionTabIds = {};
let sessionControllers = {};

// Periodic cleanup of stale sessionTabIds entries — removes entries for tabs that no longer exist
setInterval(async () => {
    const tabs = await browser.tabs.query({}).catch(() => []);
    const validTabIds = new Set(tabs.map(t => t.id));
    for (const [sessionId, tabId] of Object.entries(sessionTabIds)) {
        if (!validTabIds.has(tabId)) {
            delete sessionTabIds[sessionId];
        }
    }
}, 15 * 60 * 1000); // every 15 minutes

// ─── Toolbar click → inject content script ───────────────────────────────────
browser.action.onClicked.addListener(function (tab) {
    browser.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['browser-polyfill.min.js', 'content.js']
    }).catch(err => console.error('executeScript error:', err));
});

// ─── First-install defaults ───────────────────────────────────────────────────
// Writes the shared DEFAULTS table from settings.js so a fresh install is
// identical to a Save All on the options page (the two used to drift).
browser.runtime.onInstalled.addListener(function (details) {
    if (details.reason === 'install') {
        browser.storage.local.set(DEFAULTS);
    }
});

// ─── Message Router ───────────────────────────────────────────────────────────
// Serialized read-modify-write lives in the shared store.js module (per-key
// queues). mutateCollection wraps store.mutate for the collections key; the
// mutator contract is the store's { changed, note } shape. Call sites that
// used the old truthy-skip convention (return true = already present) are
// migrated to return { changed: false, note: 'alreadyPresent' }.

async function mutateCollection(collectionId, mutator) {
    return mutate('collections', async (collections = {}) => {
        const c = collections[collectionId];
        if (!c) throw new Error('Collection not found.');
        const outcome = await mutator(c);
        // Outcome: { changed: false, note } (skip write) or { changed: true } (write).
        if (outcome && outcome.changed === true) {
            c.updatedAt = Date.now();
            return { changed: true, result: collections };
        }
        return { changed: false, note: outcome && outcome.note };
    });
}

async function storeHasCollection(id) {
    const { collections = {} } = await browser.storage.local.get('collections');
    return !!collections[id];
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.sessionId && sender?.tab?.id) {
        // Validate before storing in global state
        if (typeof message.sessionId === 'string' && message.sessionId.length > 0 && Number.isInteger(sender.tab.id)) {
            sessionTabIds[message.sessionId] = sender.tab.id;
        }
    }

    if (message.action === 'processChunk') {
        processChunk(message)
            .then(sendResponse)
            .catch(error => { console.error('Error in processChunk:', error); sendResponse({ error: error.message }); });
        return true;
    }
    if (message.action === 'openChunksPage') {
        const payload = message.chunks
            ? { chunks: message.chunks, prefix: message.prefix, suffix: message.suffix, retryCount: message.retryCount }
            : null;
        openChunksPage(payload)
            .then(() => sendResponse({ success: true }))
            .catch(error => { console.error('Error in openChunksPage:', error); sendResponse({ success: false, error: error.message }); });
        return true;
    }
    if (message.action === 'updateChunksPage') {
        updateChunksPage(message.sessionId, message.data);
        return false;
    }
    if (message.action === 'getStoredData') {
        // Read from the stored session keyed by the requested sessionId
        browser.storage.local.get('translationSessions').then(({ translationSessions = [] }) => {
            const session = translationSessions.find(s => s.id === message.sessionId);
            sendResponse(session
                ? { chunks: session.chunks, prefix: session.prefix, suffix: session.suffix, retryCount: session.retryCount }
                : { chunks: [], prefix: '', suffix: '', retryCount: 3 }
            );
        }).catch(() => sendResponse({ chunks: [], prefix: '', suffix: '', retryCount: 3 }));
        return true; // async sendResponse
    }
    if (message.action === 'terminateRequest') {
        terminateRequest(message.sessionId)
            .then(result => sendResponse(result))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }
    // ─── Collections ────────────────────────────────────────────────────────
    if (message.action === 'getCollections') {
        browser.storage.local.get('collections').then(({ collections = {} }) =>
            sendResponse({ collections })).catch(err => sendResponse({ error: err.message }));
        return true;
    }
    if (message.action === 'createCollection') {
        const name = (message.name || '').trim();
        if (!name) { sendResponse({ error: 'Collection name is required.' }); return true; }
        const now = Date.now();
        const collection = { id: crypto.randomUUID(), name, createdAt: now, updatedAt: now, entries: [] };
        // Serialized via the store so a concurrent addEntryToCollection or
        // deleteCollection can't read a stale snapshot and clobber this write.
        mutate('collections', (collections = {}) => {
            collections[collection.id] = collection;
            return { changed: true, result: collections };
        }).then(() => sendResponse({ collection })).catch(err => sendResponse({ error: err.message }));
        return true;
    }
    if (message.action === 'updateCollection') {
        const { collectionId, name } = message;
        if (!collectionId || !(name || '').trim()) { sendResponse({ error: 'Invalid input.' }); return true; }
        mutate('collections', (collections = {}) => {
            const c = collections[collectionId]; if (!c) throw new Error('Collection not found.');
            c.name = name.trim(); c.updatedAt = Date.now();
            return { changed: true, result: collections };
        }).then(() => sendResponse({ success: true })).catch(err => sendResponse({ error: err.message }));
        return true;
    }
    if (message.action === 'deleteCollection') {
        const { collectionId } = message;
        // Delete the collection, then clean up defaults referencing it. Two
        // serialized writes; the defaults cleanup is idempotent, so the small
        // window between them is safe against a concurrent create.
        Promise.all([
            mutate('collections', (collections = {}) => {
                delete collections[collectionId];
                return { changed: true, result: collections };
            }),
            mutate('collectionDefaults', (collectionDefaults = { global: null, perSession: {} }) => {
                // Clear any default that referenced the deleted collection so we don't point at nothing.
                if (collectionDefaults.global === collectionId) collectionDefaults.global = null;
                for (const sid of Object.keys(collectionDefaults.perSession)) {
                    if (collectionDefaults.perSession[sid] === collectionId) delete collectionDefaults.perSession[sid];
                }
                return { changed: true, result: collectionDefaults };
            })
        ]).then(() => sendResponse({ success: true })).catch(err => sendResponse({ error: err.message }));
        return true;
    }
    if (message.action === 'addEntryToCollection') {
        const { collectionId, entry } = message;
        if (!collectionId || !entry) { sendResponse({ error: 'Invalid input.' }); return true; }
        // Validate the entry before persisting: require a non-empty sessionId and a non-negative integer chunkIndex.
        if (!entry.sessionId || !Number.isInteger(entry.chunkIndex) || entry.chunkIndex < 0) {
            sendResponse({ error: 'Invalid input.' }); return true;
        }
        mutateCollection(collectionId, c => {
            // Prevent duplicate entries from the same chunk.
            const exists = c.entries.some(e => e.sessionId === entry.sessionId && e.chunkIndex === entry.chunkIndex);
            if (exists) return { changed: false, note: 'alreadyPresent' };
            c.entries.push({ ...entry, id: crypto.randomUUID(), addedAt: Date.now() });
            return { changed: true };
        }).then(({ note }) => sendResponse({ success: true, alreadyPresent: note === 'alreadyPresent' }))
            .catch(err => sendResponse({ error: err.message }));
        return true;
    }
    if (message.action === 'removeEntryFromCollection') {
        const { collectionId, entryId } = message;
        if (!collectionId || !entryId) { sendResponse({ error: 'Invalid input.' }); return true; }
        mutateCollection(collectionId, c => {
            const idx = c.entries.findIndex(e => e.id === entryId);
            if (idx === -1) throw new Error('Entry not found.');
            c.entries.splice(idx, 1);
            return { changed: true };
        }).then(() => sendResponse({ success: true })).catch(err => sendResponse({ error: err.message }));
        return true;
    }
    // Update a single entry's title — routed through the serialized mutation path.
    if (message.action === 'updateEntryTitle') {
        const { collectionId, entryId, title } = message;
        if (!collectionId || !entryId || title == null) { sendResponse({ error: 'Invalid input.' }); return true; }
        mutateCollection(collectionId, c => {
            const entry = c.entries.find(e => e.id === entryId);
            if (!entry) throw new Error('Entry not found.');
            entry.title = title;
            return { changed: true };
        }).then(() => sendResponse({ success: true })).catch(err => sendResponse({ error: err.message }));
        return true;
    }
    // Update a single entry's translated content (e.g. after re-processing) — serialized.
    if (message.action === 'updateEntryContent') {
        const { collectionId, entryId, content } = message;
        if (!collectionId || !entryId || content == null) { sendResponse({ error: 'Invalid input.' }); return true; }
        mutateCollection(collectionId, c => {
            const entry = c.entries.find(e => e.id === entryId);
            if (!entry) throw new Error('Entry not found.');
            entry.content = content;
            return { changed: true };
        }).then(() => sendResponse({ success: true })).catch(err => sendResponse({ error: err.message }));
        return true;
    }
    // Clear all entries in a collection — serialized.
    if (message.action === 'clearCollectionEntries') {
        const { collectionId } = message;
        if (!collectionId) { sendResponse({ error: 'Invalid input.' }); return true; }
        mutateCollection(collectionId, c => {
            c.entries = [];
            return { changed: true };
        }).then(() => sendResponse({ success: true })).catch(err => sendResponse({ error: err.message }));
        return true;
    }
    if (message.action === 'reorderEntries') {
        const { collectionId, fromIndex, toIndex } = message;
        if (!collectionId || fromIndex == null || toIndex == null) { sendResponse({ error: 'Invalid input.' }); return true; }
        mutateCollection(collectionId, c => {
            // Validate the original indices are already integers within bounds before mutating.
            if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex < 0 || fromIndex >= c.entries.length || toIndex < 0 || toIndex >= c.entries.length) {
                throw new Error('Invalid fromIndex or toIndex.');
            }
            const [moved] = c.entries.splice(fromIndex, 1);
            c.entries.splice(toIndex, 0, moved);
            return { changed: true };
        }).then(() => sendResponse({ success: true })).catch(err => sendResponse({ error: err.message }));
        return true;
    }
    if (message.action === 'getCollectionDefaults') {
        browser.storage.local.get('collectionDefaults').then(({ collectionDefaults }) =>
            sendResponse({ defaults: collectionDefaults ?? { global: null, perSession: {} } }))
            .catch(err => sendResponse({ error: err.message }));
        return true;
    }
    // Merge-based: updates only the global default, preserving per-session overrides.
    if (message.action === 'setCollectionGlobalDefault') {
        const value = message.value ?? null;
        mutate('collectionDefaults', async (collectionDefaults = { global: null, perSession: {} }) => {
            // Null/empty clears the default; any referenced collection must actually exist.
            if (value !== null && value !== undefined && value !== '' && !(await storeHasCollection(value))) {
                throw new Error('Invalid collection reference.');
            }
            collectionDefaults.global = value;
            return { changed: true, result: collectionDefaults };
        }).then(() => sendResponse({ success: true }))
            .catch(err => sendResponse({ error: err.message }));
        return true;
    }
    // Merge-based: updates only one session's override, preserving global + other sessions.
    if (message.action === 'setCollectionSessionDefault') {
        const { sessionId, value } = message;
        if (!sessionId) { sendResponse({ error: 'sessionId is required.' }); return true; }
        mutate('collectionDefaults', async (collectionDefaults = { global: null, perSession: {} }) => {
            // Null/empty clears the override; any referenced collection must actually exist.
            if (value !== null && value !== undefined && value !== '' && !(await storeHasCollection(value))) {
                throw new Error('Invalid collection reference.');
            }
            if (value === null || value === undefined || value === '') delete collectionDefaults.perSession[sessionId];
            else collectionDefaults.perSession[sessionId] = value;
            return { changed: true, result: collectionDefaults };
        }).then(() => sendResponse({ success: true }))
            .catch(err => sendResponse({ error: err.message }));
        return true;
    }
    if (message.action === 'reprocessEntry') {
        // Re-translate an entry from its rawContent using current settings.
        const { sessionId, chunkIndex, prefix, suffix, retryCount } = message;
        // An empty prefix is valid (rawContent-only reprocess); reject only missing sessionId/chunkIndex or a non-string rawContent.
        if (!sessionId || chunkIndex == null || typeof message.rawContent !== 'string') {
            sendResponse({ error: 'Invalid input.' }); return true;
        }
        processChunk({ chunk: message.rawContent, prefix, suffix, sessionId, retryCount: retryCount ?? 3 })
            .then(result => sendResponse({ success: true, result }))
            .catch(err => sendResponse({ error: err.message }));
        return true;
    }
});

// ─── Session helpers ──────────────────────────────────────────────────────────
async function generateContentHash(chunks, prefix, suffix) {
    const allChunksString = chunks.join('');
    const textEncoder = new TextEncoder();
    const data = textEncoder.encode(prefix + allChunksString + suffix);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Session upsert + maxSessions eviction now lives in store.js saveSession,
// serialized per-key (replaces the old per-sessionId lock map).
async function updateSessionStorage(sessionId, sessionDataToStore) {
    await saveSession(sessionId, sessionDataToStore);
}

async function openChunksPage(payload) {
    // If no payload (reopening a session), use data already in storage via session hash
    const chunks = payload?.chunks ?? [];
    const prefix = payload?.prefix ?? '';
    const suffix = payload?.suffix ?? '';
    const retryCount = payload?.retryCount ?? 3;

    const contentSessionId = await generateContentHash(chunks, prefix, suffix);
    const { translationSessions = [] } = await browser.storage.local.get('translationSessions');
    const sessionDataForStorage = { chunks, prefix, suffix, retryCount };
    await updateSessionStorage(contentSessionId, sessionDataForStorage);

    const url = browser.runtime.getURL(`chunks.html?session=${contentSessionId}`);
    let tab;
    try {
        tab = await browser.tabs.create({ url });
    } catch (err) {
        console.error('Failed to create chunks tab (tabs permission may be denied):', err);
        throw err;
    }
    sessionTabIds[contentSessionId] = tab.id;

    browser.tabs.onUpdated.addListener(function listener(tabId, info) {
        if (tabId === tab.id && info.status === 'complete') {
            browser.tabs.onUpdated.removeListener(listener);
            browser.tabs.sendMessage(tab.id, { action: 'initializeChunksPage' }).catch(err => {
                console.error('Failed to initialize chunks page:', err);
            });
        }
    });
}

function updateChunksPage(sessionId, data) {
    const tabId = sessionTabIds[sessionId];
    if (tabId != null) {
        browser.tabs.sendMessage(tabId, data).catch(error => {
            // Clean up stale tab mapping for any error (not just connection errors)
            delete sessionTabIds[sessionId];
            console.warn('updateChunksPage: tab message failed:', error.message || error);
        });
    }
}

async function terminateRequest(sessionId) {
    const controller = sessionControllers[sessionId];
    if (controller) {
        controller.abort();
        delete sessionControllers[sessionId];
        return { success: true };
    }
    return { success: false, error: 'No active request to terminate' };
}



// ─── Chunk Router ─────────────────────────────────────────────────────────────
async function processChunk(message) {
    const options = await browser.storage.local.get();
    const type = options.apiType;
    if (type === 'gemini' || type === 'openRouter' || type === 'openai') {
        return processChunkWithHttpProvider(message, options, type);
    }

    if (type === 'chatgptWeb') return processChunkWithChatGPTWeb(message, options);
    if (type === 'geminiWeb') return processChunkWithGeminiWeb(message, options);
    throw new Error('Invalid API type selected');
}

// ─── HTTP LLM providers ───────────────────────────────────────────────────────
// The fetch/SSE/timeout/abort/LCS core lives in the shared llm.js seam
// (streamLLM). Each provider shrinks to URL/headers/body builders here in the
// worker (they read option keys) plus a descriptor row in llm.js.
// Few-shot selection/saving is injected into the seam from fewshot.js.

const fewShotAdapter = {
    selectExamples: ({ maxBudgetChars, chunkText }) => selectForShot({ maxBudgetChars, chunkText }),
    buildExampleMessages,
    saveExample: addExample
};

const HTTP_PROVIDER_CONFIGS = {
    gemini: {
        buildUrl: (options) => `https://generativelanguage.googleapis.com/v1beta/models/${options.geminiModelId}:streamGenerateContent?key=${options.geminiApiKey}&alt=sse`,
        buildHeaders: () => ({ 'Content-Type': 'application/json' }),
        buildBody: (options, message, exampleMessages) => {
            // Gemini casts OpenAI-shaped examples to model/user roles with parts.
            const exampleContents = exampleMessages
                .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
            const body = {
                contents: [...exampleContents, { role: 'user', parts: [{ text: `${message.prefix}\n${message.chunk}\n${message.suffix}` }] }],
                generationConfig: {
                    temperature: (v => Number.isFinite(v) ? v : 0.9)(parseFloat(options.temperature)),
                    topK: (v => Number.isFinite(v) ? v : 40)(parseInt(options.topK)),
                    topP: (v => Number.isFinite(v) ? v : 0.95)(parseFloat(options.topP)),
                    thinkingConfig: { thinkingBudget: 0 }
                },
                safetySettings: [
                    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
                ]
            };
            if (options.geminiMaxTokens?.trim()) {
                const t = parseInt(options.geminiMaxTokens);
                if (!isNaN(t) && t > 0) body.generationConfig.maxOutputTokens = t;
            }
            return body;
        }
    },
    openRouter: {
        buildUrl: () => 'https://openrouter.ai/api/v1/chat/completions',
        buildHeaders: (options) => ({
            'Authorization': `Bearer ${options.openRouterApiKey}`,
            'HTTP-Referer': 'https://addons.mozilla.org/en-US/firefox/addon/ai-webnovel-translator/',
            'X-OpenRouter-Title': 'AI Webnovel Translator',
            'Content-Type': 'application/json'
        }),
        buildBody: (options, message, exampleMessages) => {
            const body = {
                model: options.openRouterModelId || 'openai/gpt-4',
                messages: [...exampleMessages, { role: 'user', content: `${message.prefix}\n${message.chunk}\n${message.suffix}` }],
                stream: true
            };
            if (options.openRouterMaxTokens?.trim()) { const t = parseInt(options.openRouterMaxTokens); if (!isNaN(t) && t > 0) body.max_tokens = t; }
            const temperature = typeof options.temperature === 'string'
                ? parseFloat(options.temperature.trim())
                : Number(options.temperature);
            if (!isNaN(temperature)) body.temperature = temperature;
            if (options.openRouterProviderOrder?.trim()) {
                const order = options.openRouterProviderOrder.split(',').map(s => s.trim()).filter(Boolean);
                if (order.length) body.provider = { order, allow_fallbacks: options.openRouterAllowFallback !== false };
            }
            return body;
        }
    },
    openai: {
        buildUrl: (options) => `${(options.openaiBaseUrl?.trim() || 'https://api.openai.com/v1')}/chat/completions`,
        buildHeaders: (options) => ({
            'Authorization': `Bearer ${options.openaiApiKey}`,
            'Content-Type': 'application/json'
        }),
        buildBody: (options, message, exampleMessages) => {
            const body = {
                model: options.openaiModelId || 'gpt-4o-mini',
                messages: [...exampleMessages, { role: 'user', content: `${message.prefix}\n${message.chunk}\n${message.suffix}` }],
                stream: true
            };
            if (options.openaiMaxTokens?.trim()) { const t = parseInt(options.openaiMaxTokens); if (!isNaN(t) && t > 0) body.max_tokens = t; }
            const temperature = typeof options.temperature === 'string'
                ? parseFloat(options.temperature.trim())
                : Number(options.temperature);
            if (!isNaN(temperature)) body.temperature = temperature;
            return body;
        }
    }
};

/**
 * Runs one HTTP-provider translation through the shared llm.js seam.
 * Owns the browser edge: session controller, tab-close abort, stream pushes,
 * few-shot finalize, and error-class → user-string mapping.
 */
async function processChunkWithHttpProvider(message, options, providerKey) {
    const config = HTTP_PROVIDER_CONFIGS[providerKey];
    const controller = new AbortController();
    const sessionId = message.sessionId;
    sessionControllers[sessionId] = controller;
    const label = { gemini: 'Gemini', openRouter: 'OpenRouter', openai: 'OpenAI' }[providerKey];

    let tabCloseListener;
    tabCloseListener = tabId => {
        if (tabId === sessionTabIds[sessionId]) { controller.abort(); browser.tabs.onRemoved.removeListener(tabCloseListener); delete sessionTabIds[sessionId]; }
    };
    browser.tabs.onRemoved.addListener(tabCloseListener);
    updateChunksPage(sessionId, { action: 'updateStreamContent', content: '', rawContent: message.chunk, isInitial: true });

    try {
        const { content, reasoning } = await streamLLM({
            provider: providerKey,
            message,
            options,
            signal: controller.signal,
            buildUrl: config.buildUrl,
            buildHeaders: config.buildHeaders,
            buildBody: config.buildBody,
            onDelta: (delta) => updateChunksPage(sessionId, { action: 'updateStreamContent', content: delta.content, reasoning: delta.reasoning, rawContent: message.chunk }),
            fewShot: fewShotAdapter
        });
        updateChunksPage(sessionId, { action: 'updateStreamContent', content, reasoning, rawContent: message.chunk, isComplete: true });
        if (options.fewShotEnabled && content) {
            try { await fewShotAdapter.saveExample({ raw: message.chunk, translation: content, timestamp: Date.now() }); }
            catch (e) { console.error('[fewshot] addExample failed:', e); }
        }
        await new Promise(r => setTimeout(r, 100));
        return { result: content, parts: [content], streaming: true, complete: true };
    } catch (error) {
        updateChunksPage(sessionId, { action: 'updateStreamContent', content: '', rawContent: message.chunk, isComplete: true, error: true });
        if (error.name === 'AbortError') return { error: `${label} request cancelled` };
        if (error.name === 'TimeoutError') return { error: `${label} request timed out` };
        if (error.name === 'HttpError') {
            if (error.status === 401) return { error: `${label}: Invalid API key` };
            if (error.status === 429) return { error: `${label}: Rate limit exceeded` };
            return { error: `${label} Error: HTTP ${error.status}${error.bodyMessage ? ': ' + error.bodyMessage : ''}` };
        }
        return { error: `${label} Error: ${error.message}` };
    } finally {
        // Cleanup on BOTH success and failure — the tab-close abort listener
        // would otherwise accumulate per processed chunk.
        if (tabCloseListener) browser.tabs.onRemoved.removeListener(tabCloseListener);
        delete sessionControllers[sessionId];
    }
}

// Safely convert a URL match pattern (with * wildcards) into an anchored RegExp.
// All regex metacharacters except * are escaped so e.g. '.' in 'chatgpt.com' is literal.
function urlPatternToRegExp(pattern) {
    const escaped = pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp('^' + escaped.join('.*') + '$');
}

// ─── Web Permission Management ────────────────────────────────────────────────
async function hasStoredWebPermission(provider) {
    const { webPermissions = {} } = await browser.storage.local.get('webPermissions');
    return webPermissions[provider] === true;
}

async function setStoredWebPermission(provider, granted) {
    const { webPermissions = {} } = await browser.storage.local.get('webPermissions');
    webPermissions[provider] = granted;
    await browser.storage.local.set({ webPermissions });
}

async function ensureWebPermission(provider) {
    if (!WEB_PERMISSIONS[provider]) throw new Error(`Unknown web provider: ${provider}`);
    const { origins, permissions } = WEB_PERMISSIONS[provider];
    const hasOrigins = origins.length === 0 || await browser.permissions.contains({ origins });
    const hasPerms = permissions.length === 0 || await browser.permissions.contains({ permissions });
    return hasOrigins && hasPerms;
}

async function requestAndStoreWebPermission(provider) {
    if (!WEB_PERMISSIONS[provider]) throw new Error(`Unknown web provider: ${provider}`);
    const { origins, permissions } = WEB_PERMISSIONS[provider];
    const granted = await browser.permissions.request({
        origins: origins ?? [],
        permissions: permissions ?? []
    });
    await setStoredWebPermission(provider, granted);
    return granted;
}

const injectedTabs = new Set();

async function injectWebAutomationScript(tabId, scriptType) {
    if (injectedTabs.has(tabId)) return;
    if (scriptType === 'chatgptWeb') {
        await browser.scripting.executeScript({
            target: { tabId },
            files: ['browser-polyfill.min.js', 'chatgpt_injector.js']
        });
    } else if (scriptType === 'geminiWeb') {
        await browser.scripting.executeScript({
            target: { tabId },
            files: ['browser-polyfill.min.js', 'gemini_injector.js']
        });
    }
    injectedTabs.add(tabId);
}

// Clear injectedTabs when a tab navigates (loading) or is closed so re-injection works on revisit
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading' || changeInfo.url) {
        injectedTabs.delete(tabId);
    }
});
browser.tabs.onRemoved.addListener((tabId) => {
    injectedTabs.delete(tabId);
});

// ─── Web Automation ───────────────────────────────────────────────────────────
async function getOrCreateTab(url, urlPattern, sessionId) {
    if (sessionTabIds[sessionId]) {
        try {
            const tab = await browser.tabs.get(sessionTabIds[sessionId]);
            if (tab.url && urlPatternToRegExp(urlPattern).test(tab.url)) return { tab, reused: true };
        } catch (e) {
            // Only swallow "tab not found" — rethrow unexpected errors
            if (e.message && e.message.includes('No tab with id')) {
                delete sessionTabIds[sessionId];
            } else {
                console.error('Unexpected error getting tab:', e);
                throw e;
            }
        }
    }
    try {
        const tabs = await browser.tabs.query({ url: urlPattern });
        if (tabs.length > 0) { sessionTabIds[sessionId] = tabs[0].id; await browser.tabs.update(tabs[0].id, { active: true }); return { tab: tabs[0], reused: true }; }
        const tab = await browser.tabs.create({ url }); sessionTabIds[sessionId] = tab.id; return { tab, reused: false };
    } catch (err) {
        console.error('Tabs operation failed (tabs permission may be denied):', err);
        throw err;
    }
}

function waitForTabLoad(tabId, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('Aborted'));
        let settled = false;
        const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };
        let cleanup = null;
        const timer = setTimeout(() => { if (cleanup) cleanup(); settle(reject, new Error('Tab load timeout')); }, timeoutMs);
        const listener = (tid, changeInfo) => {
            if (tid === tabId && changeInfo.status === 'complete') {
                clearTimeout(timer);
                if (cleanup) cleanup();
                settle(resolve);
            }
        };
        cleanup = () => {
            browser.tabs.onUpdated.removeListener(listener);
            if (signal) signal.removeEventListener('abort', abortHandler);
        };
        const abortHandler = () => { clearTimeout(timer); if (cleanup) cleanup(); settle(reject, new Error('Aborted')); };
        if (signal) signal.addEventListener('abort', abortHandler);
        browser.tabs.onUpdated.addListener(listener);
        // Check if tab is already loaded
        browser.tabs.get(tabId).then(tab => {
            if (signal?.aborted) { clearTimeout(timer); if (cleanup) cleanup(); return settle(reject, new Error('Aborted')); }
            if (tab.status === 'complete') { clearTimeout(timer); if (cleanup) cleanup(); settle(resolve); }
        }).catch(e => { clearTimeout(timer); if (cleanup) cleanup(); settle(reject, e); });
    });
}

async function processChunkWithChatGPTWeb(message, options) {
    // Check permission first
    const hasPermission = await ensureWebPermission('chatgptWeb');
    if (!hasPermission) {
        return { error: 'Permission required: Please enable ChatGPT Web in settings to grant access.' };
    }

    const chunkText = `${message.prefix}\n${message.chunk}\n${message.suffix}`;
    let exampleBlock = '';
    try {
        if (options.fewShotEnabled) {
            const examples = await selectForShot({ maxBudgetChars: 0, chunkText: '' });
            exampleBlock = buildExampleTextBlock(examples);
        }
    } catch (e) { console.error('[fewshot] ChatGPT Web example selection failed:', e); }
    const fullContent = exampleBlock ? `${exampleBlock}\n\n${chunkText}` : chunkText;
    const controller = new AbortController();
    const sessionId = message.sessionId;
    sessionControllers[sessionId] = controller;
    try {
        const { tab, reused } = await getOrCreateTab('https://chatgpt.com/', 'https://chatgpt.com/*', sessionId);
        await waitForTabLoad(tab.id, WebAutomationConfig.TAB_LOAD_TIMEOUT_MS, controller.signal);
        if (controller.signal.aborted) throw new Error('Aborted');

        // Inject script if tab was created (not reused) or if we need to ensure it's injected
        await injectWebAutomationScript(tab.id, 'chatgptWeb');

        await new Promise((resolve, reject) => { const t = setTimeout(resolve, WebAutomationConfig.DELAY_CHATGPT_MS); controller.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Aborted')); }, { once: true }); });
        const execTimeout = (parseInt(options.webAutomationTimeout) || 30) * 1000;
        const result = await Promise.race([
            browser.tabs.sendMessage(tab.id, { action: 'paste_chunk_v2', text: fullContent }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), execTimeout)),
            new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }))
        ]);
        if (!result?.success) throw new Error(result?.error || 'Unknown error');
        return { result: 'Sent to ChatGPT Web', parts: ['Sent to ChatGPT Web'], streaming: false };
    } catch (error) {
        return { error: 'Failed to send to ChatGPT: ' + error.message };
    } finally {
        delete sessionControllers[sessionId];
    }
}

async function processChunkWithGeminiWeb(message, options) {
    // Check permission first
    const hasPermission = await ensureWebPermission('geminiWeb');
    if (!hasPermission) {
        return { error: 'Permission required: Please enable Gemini Web in settings to grant access.' };
    }

    const chunkText = `${message.prefix}\n${message.chunk}\n${message.suffix}`;
    let exampleBlock = '';
    try {
        if (options.fewShotEnabled) {
            const examples = await selectForShot({ maxBudgetChars: 0, chunkText: '' });
            exampleBlock = buildExampleTextBlock(examples);
        }
    } catch (e) { console.error('[fewshot] Gemini Web example selection failed:', e); }
    const fullContent = exampleBlock ? `${exampleBlock}\n\n${chunkText}` : chunkText;
    const controller = new AbortController();
    const sessionId = message.sessionId;
    sessionControllers[sessionId] = controller;
    try {
        const { tab } = await getOrCreateTab('https://gemini.google.com/', 'https://gemini.google.com/*', sessionId);
        await waitForTabLoad(tab.id, WebAutomationConfig.TAB_LOAD_TIMEOUT_MS, controller.signal);
        if (controller.signal.aborted) throw new Error('Aborted');

        // Inject script dynamically
        await injectWebAutomationScript(tab.id, 'geminiWeb');

        await new Promise((resolve, reject) => { const t = setTimeout(resolve, WebAutomationConfig.DELAY_GEMINI_MS); controller.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Aborted')); }, { once: true }); });
        const execTimeout = (parseInt(options.webAutomationTimeout) || 30) * 1000;
        const result = await Promise.race([
            browser.tabs.sendMessage(tab.id, { action: 'paste_chunk_gemini', text: fullContent }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), execTimeout)),
            new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }))
        ]);
        if (!result?.success) throw new Error(result?.error || 'Unknown error');
        return { result: 'Sent to Gemini Web', parts: ['Sent to Gemini Web'], streaming: false };
    } catch (error) {
        return { error: 'Failed to send to Gemini: ' + error.message };
    } finally {
        delete sessionControllers[sessionId];
    }
}
