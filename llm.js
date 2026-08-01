// llm.js — LLM streaming adapter (shared pure core for HTTP providers)
// Owns: fetch + timeout + abort, SSE parsing, LCS overlap dedup, stream-state
// debounce bookkeeping (the push target is injected), error classification.
// Web-automation providers (ChatGPT Web / Gemini Web) stay in the worker: they
// share no transport with HTTP streaming.
//
// Leaf module: no imports. Few-shot selection/saving are injected via the
// `fewShot` parameter so Node tests can stub them and the module graph stays
// acyclic.
//
// Node seam: `module.exports` guard at the bottom (same pattern as fewshot.js,
// settings.js, store.js).

'use strict';

// ─── Error taxonomy ───────────────────────────────────────────────────────────
// Classed errors cross the seam; the worker maps them to user-facing strings
// at the edge (provider label + friendly message live there, not here).

class HttpError extends Error {
    constructor(status, bodyMessage = '') {
        super(`HTTP ${status}`);
        this.name = 'HttpError';
        this.status = status;
        this.bodyMessage = bodyMessage;
    }
}

class TimeoutError extends Error {
    constructor(message = 'API response timeout') {
        super(message);
        this.name = 'TimeoutError';
    }
}

class AbortError extends Error {
    constructor(message = 'Aborted') {
        super(message);
        this.name = 'AbortError';
    }
}

// ─── Stream-state helpers ─────────────────────────────────────────────────────
// Per-session streaming state — keyed by sessionId so concurrent streams don't
// share timers or counters. Debounce bookkeeping only; the actual push is the
// injected onDelta callback in the worker.

const UPDATE_DELAY = 500;

const sessionStreamState = {}; // { [sessionId]: { debounceTimeout, lastUpdateTime } }

function getStreamState(sessionId) {
    if (!sessionStreamState[sessionId]) {
        sessionStreamState[sessionId] = { debounceTimeout: undefined, lastUpdateTime: 0 };
    }
    return sessionStreamState[sessionId];
}

function clearStreamState(sessionId) {
    const state = sessionStreamState[sessionId];
    if (state) clearTimeout(state.debounceTimeout);
    delete sessionStreamState[sessionId];
}

// ─── Overlap dedup (LCS) ──────────────────────────────────────────────────────
/**
 * Finds the longest substring that is both a suffix of oldStr and a prefix of newStr.
 * Used to trim duplicate overlap at stream boundaries when a retry run continues
 * from where a previous run left off.
 *
 * @param {string} oldStr - The previously accumulated content (ending portion checked).
 * @param {string} newStr - The new streaming content (starting portion checked).
 * @returns {{ suffix: string, prefixLength: number }} overlap substring and chars to skip in newStr
 */
function longestCommonSuffixPrefix(oldStr, newStr) {
    const maxLen = Math.min(oldStr.length, newStr.length);
    let overlapLen = 0;
    for (let i = 1; i <= maxLen; i++) {
        const suffix = oldStr.slice(-i);
        if (newStr.startsWith(suffix)) overlapLen = i;
    }
    const suffix = overlapLen > 0 ? oldStr.slice(-overlapLen) : '';
    return { suffix, prefixLength: overlapLen };
}

// ─── Read loop with transient-network retry ───────────────────────────────────
/**
 * Wraps ReadableStreamDefaultReader.read() with retry logic for transient network errors.
 *
 * @param {ReadableStreamDefaultReader} reader
 * @param {number} maxErrors - Maximum consecutive errors before throwing (default 3)
 * @param {number} baseDelayMs - Initial delay between retries in ms (default 1000)
 * @returns {Promise<{done: boolean, value: Uint8Array|null}>}
 */
async function readWithRetry(reader, maxErrors = 3, baseDelayMs = 1000) {
    let errors = 0;
    let delay = baseDelayMs;
    while (true) {
        try {
            return await reader.read();
        } catch (e) {
            // Do not retry on abort/cancel — these are intentional terminations
            if (e.name === 'AbortError' || (e.name === 'TypeError' && e.message.includes('cancelled'))) {
                throw e;
            }
            // TypeError with "error in input stream" or network-level failures are retryable
            if (e.name === 'TypeError' || e.message.includes('error in input stream') || e.message.includes('network')) {
                errors++;
                if (errors > maxErrors) throw e;
                console.warn(`[Stream read] Attempt ${errors} failed: ${e.message}. Retrying in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
                delay *= 2; // exponential backoff: 1s → 2s → 4s
                continue;
            }
            // Any other error is non-retryable
            throw e;
        }
    }
}

// ─── SSE line buffer ──────────────────────────────────────────────────────────
// Splits an incoming byte chunk into complete lines. When `lineEndFallback` is
// set (Gemini), a buffer holding a complete `data: {...}` with no trailing
// newline is accepted as a final line.
function splitSseLines(buffer, chunk, decoder, lineEndFallback) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = [];
    while (true) {
        let lineEnd = buffer.indexOf('\n');
        if (lineEnd === -1 && lineEndFallback && lineEndFallback(buffer)) lineEnd = buffer.length;
        if (lineEnd === -1) break;
        lines.push(buffer.slice(0, lineEnd).trim());
        buffer = buffer.slice(lineEnd + 1);
    }
    return { buffer, lines };
}

// ─── Debounced delta push ─────────────────────────────────────────────────────
// Calls onDelta at most every UPDATE_DELAY ms, trailing-flush. Owns only the
// timer bookkeeping; the push target is the caller's.
function pushDeltaDebounced(sessionId, onDelta, payload) {
    const state = getStreamState(sessionId);
    const now = Date.now();
    clearTimeout(state.debounceTimeout);
    if (now - state.lastUpdateTime >= UPDATE_DELAY) {
        onDelta(payload);
        state.lastUpdateTime = now;
    } else {
        state.debounceTimeout = setTimeout(() => {
            onDelta(payload);
            state.lastUpdateTime = Date.now();
        }, UPDATE_DELAY);
    }
}

// ─── Provider descriptors ─────────────────────────────────────────────────────
// Each HTTP provider shrinks to: how to pull text/reasoning out of one SSE
// event, how to parse an error body, and its few-shot context-window key. The
// URL/headers/body builders stay in the worker (they read option keys); the
// generic SSE core in streamLLM drives all three.

const PROVIDER_DESCRIPTORS = {
    gemini: {
        label: 'Gemini',
        contextWindowKey: 'geminiContextWindow',
        // SSE events may arrive as a final `data: {...}` with no trailing newline.
        acceptsLineWithoutNewline: true,
        extractEvent(parsed) {
            if (parsed.error) throw new Error(`Gemini Stream Error: ${parsed.error.message}`);
            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
            return { content: text || '' };
        },
        parseErrorBody: async (response) => {
            const err = await response.json().catch(() => ({}));
            return err.error?.message || '';
        }
    },
    openRouter: {
        label: 'OpenRouter',
        contextWindowKey: 'openRouterContextWindow'
    },
    openai: {
        label: 'OpenAI',
        contextWindowKey: 'openaiContextWindow'
    }
};

// OpenAI-compatible providers share one extraction shape and no error body.
PROVIDER_DESCRIPTORS.openRouter.extractEvent = PROVIDER_DESCRIPTORS.openai.extractEvent = (parsed) => {
    const delta = parsed.choices?.[0]?.delta || {};
    return { content: delta.content || '', reasoning: delta.reasoning || '' };
};

// ─── Few-shot example selection (shared by HTTP providers) ────────────────────
// Guarded in try/catch so a few-shot failure never breaks a translation.
// Returns { chunkText, exampleMessages }; the message shape is whatever the
// provider's buildBody expects (OpenAI-shaped [{role, content}] today).
async function buildFewShotExampleMessages(message, options, fewShot, contextWindowKey, label) {
    const chunkText = `${message.prefix}\n${message.chunk}\n${message.suffix}`;
    let exampleMessages = [];
    try {
        if (fewShot && options.fewShotEnabled) {
            const budget = parseInt(options[contextWindowKey]) || 0;
            const examples = await fewShot.selectExamples({ maxBudgetChars: budget, chunkText });
            exampleMessages = fewShot.buildExampleMessages(examples);
        }
    } catch (e) { console.error(`[fewshot] ${label} example selection failed:`, e); }
    return { chunkText, exampleMessages };
}

// ─── The seam ─────────────────────────────────────────────────────────────────
/**
 * Streams a translation from one HTTP LLM provider.
 *
 * @param {object} params
 * @param {string} params.provider - 'gemini' | 'openRouter' | 'openai'
 * @param {object} params.message - { chunk, prefix, suffix, sessionId }
 * @param {object} params.options - full storage options (apiKey, modelId, timeout, ...)
 * @param {AbortSignal} params.signal - session abort signal (worker's controller)
 * @param {Function} params.buildBody - (options, message, exampleMessages) => body object
 * @param {Function} params.buildHeaders - (options) => headers object
 * @param {Function} params.buildUrl - (options) => request URL
 * @param {Function} [params.onDelta] - (delta {content, reasoning}) => push (debounced)
 * @param {object} [params.fewShot] - { selectExamples, buildExampleMessages, saveExample }
 *   injected from the worker (fewshot.js wiring)
 * @returns {Promise<{ content: string, reasoning: string }>}
 * @throws {HttpError | TimeoutError | AbortError}
 */
async function streamLLM({
    provider,
    message,
    options,
    signal,
    buildBody,
    buildHeaders,
    buildUrl,
    onDelta = () => {},
    fewShot = null
}) {
    const descriptor = PROVIDER_DESCRIPTORS[provider];
    if (!descriptor) throw new Error(`Unknown LLM provider: ${provider}`);

    const sessionId = message.sessionId;
    const { chunkText, exampleMessages } = await buildFewShotExampleMessages(
        message, options, fewShot, descriptor.contextWindowKey, descriptor.label);
    const requestBody = buildBody(options, message, exampleMessages);

    let fullContent = '';
    let fullReasoning = '';

    // Timeout + abort: ONE timer covers headers AND body streaming. When it
    // fires it aborts the derived controller, so a stalled body dies too.
    // Session abort propagates into the fetch via the same derived controller.
    const timeoutMs = (parseInt(options.apiTimeout) || 120) * 1000;
    const derivedController = new AbortController();
    let timedOut = false;
    let timeoutId;
    const onOriginalAbort = () => { derivedController.abort(); };
    signal.addEventListener('abort', onOriginalAbort, { once: true });
    // Node does not re-dispatch `abort` when the listener is added to an
    // already-aborted signal — cover that path explicitly (browser parity).
    if (signal.aborted) derivedController.abort();
    timeoutId = setTimeout(() => { timedOut = true; derivedController.abort(); }, timeoutMs);

    try {
        const response = await fetch(buildUrl(options), {
            method: 'POST',
            headers: buildHeaders(options),
            body: JSON.stringify(requestBody),
            signal: derivedController.signal
        });
        if (!response.ok) {
            const bodyMessage = descriptor.parseErrorBody ? await descriptor.parseErrorBody(response) : '';
            throw new HttpError(response.status, bodyMessage);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('Response body not readable');

        const decoder = new TextDecoder();
        let buffer = '';
        try {
            while (true) {
                const read = await readWithRetry(reader);
                if (read.done) break;
                const { buffer: nextBuffer, lines } = splitSseLines(buffer, read.value, decoder,
                    descriptor.acceptsLineWithoutNewline ? (b) => b.startsWith('data: ') && b.endsWith('}') : null);
                buffer = nextBuffer;
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6);
                    if (data === '[DONE]') return { content: fullContent, reasoning: fullReasoning };
                    try {
                        const parsed = JSON.parse(data);
                        let { content, reasoning } = descriptor.extractEvent(parsed);
                        if (content || reasoning) {
                            if (content) fullContent += content;
                            if (reasoning) fullReasoning += reasoning;
                            pushDeltaDebounced(sessionId, onDelta, { content: fullContent, reasoning: fullReasoning });
                        }
                    } catch (e) {
                        // Stream-level errors (Gemini) and benign parse errors both land here.
                        if (e.message && e.message.startsWith('Gemini Stream')) throw e;
                        console.debug(`[${descriptor.label} SSE parse] Ignoring benign parse error:`, e.message, '| raw data:', data);
                    }
                }
            }
        } finally {
            reader.cancel().catch(() => { });
            clearStreamState(sessionId);
        }
        return { content: fullContent, reasoning: fullReasoning };
    } catch (e) {
        if (timedOut) throw new TimeoutError();
        if (e.name === 'AbortError') throw new AbortError();
        throw e;
    } finally {
        clearTimeout(timeoutId);
        signal.removeEventListener('abort', onOriginalAbort);
    }
}

// ─── Node export (inert in browser) ───────────────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        streamLLM,
        HttpError, TimeoutError, AbortError,
        longestCommonSuffixPrefix,
        readWithRetry,
        getStreamState, clearStreamState,
        UPDATE_DELAY,
        PROVIDER_DESCRIPTORS
    };
}
