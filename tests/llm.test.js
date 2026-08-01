// LLM adapter seam: SSE normalization, LCS dedup, timeout/abort classification.
// Run: node --test tests/llm.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    streamLLM,
    HttpError, TimeoutError, AbortError,
    longestCommonSuffixPrefix,
} = require('../llm.js');

const encoder = new TextEncoder();
const abortErr = () => { const e = new Error('Aborted'); e.name = 'AbortError'; return e; };

// Build a fake fetch response whose body streams the given byte chunks.
function sseResponse(chunks, { ok = true, status = 200 } = {}) {
    let i = 0;
    const body = new ReadableStream({
        pull(controller) {
            if (i < chunks.length) { controller.enqueue(chunks[i]); i++; }
            else controller.close();
        }
    });
    return { ok, status, body, json: async () => ({ error: { message: 'rate-limited' } }) };
}

const baseMessage = { chunk: '原文', prefix: '', suffix: '', sessionId: 's1' };
const baseOptions = { apiTimeout: 120, fewShotEnabled: false };

// ─── LCS dedup (pure) ──────────────────────────────────────────────────────────

test('longestCommonSuffixPrefix trims overlap at resume boundary', () => {
    const { suffix, prefixLength } = longestCommonSuffixPrefix('abcdef', 'abcdefghij');
    assert.equal(suffix, 'abcdef');
    assert.equal(prefixLength, 6);
});

test('longestCommonSuffixPrefix returns 0 when no overlap', () => {
    const { prefixLength } = longestCommonSuffixPrefix('abc', 'xyz');
    assert.equal(prefixLength, 0);
});

test('longestCommonSuffixPrefix handles empty strings', () => {
    assert.equal(longestCommonSuffixPrefix('', 'abc').prefixLength, 0);
    assert.equal(longestCommonSuffixPrefix('abc', '').prefixLength, 0);
});

// ─── SSE normalization (OpenAI-compatible) ─────────────────────────────────────

test('openai stream accumulates content/reasoning across partial chunks', async () => {
    const evt1 = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n';
    const evt2 = 'data: {"choices":[{"delta":{"reasoning":"think"}}]}\n\n';
    const evt3 = 'data: {"choices":[{"delta":{"content":" world"}}]}\n\n';
    const done = 'data: [DONE]\n\n';
    // Split evt1 mid-JSON to prove buffer reassembly across byte chunks.
    const cut = Math.floor(evt1.length / 2);
    const deltas = [];
    globalThis.fetch = async () => {
        return sseResponse([
            encoder.encode(evt1.slice(0, cut)), encoder.encode(evt1.slice(cut) + evt2 + evt3 + done)
        ]);
    };

    const { content, reasoning } = await streamLLM({
        provider: 'openai',
        message: baseMessage,
        options: baseOptions,
        signal: new AbortController().signal,
        buildUrl: () => 'https://api.openai.com/v1/chat/completions',
        buildHeaders: () => ({ 'Content-Type': 'application/json' }),
        buildBody: () => ({ stream: true }),
        onDelta: (d) => deltas.push(d)
    });

    assert.equal(content, 'Hello world');
    assert.equal(reasoning, 'think');
    assert.ok(deltas.length >= 1);
    assert.equal(deltas[0].content, 'Hello');
});

test('gemini descriptor accepts final data line without trailing newline', async () => {
    globalThis.fetch = async () => {
        return sseResponse([encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}')]);
    };

    const { content } = await streamLLM({
        provider: 'gemini',
        message: baseMessage,
        options: baseOptions,
        signal: new AbortController().signal,
        buildUrl: () => 'https://generativelanguage.googleapis.com/...',
        buildHeaders: () => ({ 'Content-Type': 'application/json' }),
        buildBody: () => ({})
    });

    assert.equal(content, 'Hi');
});

test('gemini stream-level error event is thrown, not swallowed as benign', async () => {
    globalThis.fetch = async () => {
        return sseResponse([encoder.encode('data: {"error":{"message":"blocked"}}\n\n')]);
    };

    await assert.rejects(
        streamLLM({
            provider: 'gemini',
            message: baseMessage,
            options: baseOptions,
            signal: new AbortController().signal,
            buildUrl: () => 'x', buildHeaders: () => ({}), buildBody: () => ({})
        }),
        /Gemini Stream Error: blocked/
    );
});

// ─── Error classification ──────────────────────────────────────────────────────

test('non-ok response throws HttpError with parsed body for gemini', async () => {
    globalThis.fetch = async () => sseResponse([], { ok: false, status: 429 });

    await assert.rejects(
        streamLLM({
            provider: 'gemini',
            message: baseMessage,
            options: baseOptions,
            signal: new AbortController().signal,
            buildUrl: () => 'x', buildHeaders: () => ({}), buildBody: () => ({})
        }),
        (e) => e instanceof HttpError && e.status === 429 && e.bodyMessage === 'rate-limited'
    );
});

test('non-ok response throws HttpError with empty body for openai-compatible', async () => {
    globalThis.fetch = async () => sseResponse([], { ok: false, status: 401 });

    await assert.rejects(
        streamLLM({
            provider: 'openai',
            message: baseMessage,
            options: baseOptions,
            signal: new AbortController().signal,
            buildUrl: () => 'x', buildHeaders: () => ({}), buildBody: () => ({})
        }),
        (e) => e instanceof HttpError && e.status === 401 && e.bodyMessage === ''
    );
});

test('stalled fetch throws TimeoutError', async () => {
    globalThis.fetch = (url, { signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(abortErr()), { once: true });
    });

    await assert.rejects(
        streamLLM({
            provider: 'openai',
            message: baseMessage,
            options: { ...baseOptions, apiTimeout: 1 }, // 1s
            signal: new AbortController().signal,
            buildUrl: () => 'x', buildHeaders: () => ({}), buildBody: () => ({})
        }),
        (e) => e instanceof TimeoutError
    );
});

test('pre-aborted session signal throws AbortError', async () => {
    globalThis.fetch = (url, { signal }) => {
        if (signal.aborted) return Promise.reject(abortErr());
        return sseResponse([encoder.encode('data: [DONE]\n\n')]);
    };
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
        streamLLM({
            provider: 'openai',
            message: baseMessage,
            options: baseOptions,
            signal: controller.signal,
            buildUrl: () => 'x', buildHeaders: () => ({}), buildBody: () => ({})
        }),
        (e) => e instanceof AbortError
    );
});

// ─── Few-shot injection ────────────────────────────────────────────────────────

test('fewShot adapter is consulted when fewShotEnabled', async () => {
    let capturedBody = null;
    globalThis.fetch = async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return sseResponse([encoder.encode('data: [DONE]\n\n')]);
    };
    const seen = [];
    const fewShot = {
        selectExamples: async ({ maxBudgetChars, chunkText }) => {
            seen.push({ maxBudgetChars, chunkText });
            return [{ role: 'user', content: 'ex' }, { role: 'assistant', content: '訳' }];
        },
        buildExampleMessages: (examples) => examples,
    };

    await streamLLM({
        provider: 'openai',
        message: baseMessage,
        options: { ...baseOptions, fewShotEnabled: true, openaiContextWindow: '500' },
        signal: new AbortController().signal,
        buildUrl: () => 'x', buildHeaders: () => ({}),
        buildBody: (options, message, exampleMessages) => ({ messages: exampleMessages }),
        fewShot
    });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].maxBudgetChars, 500);
    assert.equal(seen[0].chunkText, '\n原文\n');
    assert.deepEqual(capturedBody.messages, [
        { role: 'user', content: 'ex' }, { role: 'assistant', content: '訳' }
    ]);
});

test('few-shot selection failure never breaks the translation', async () => {
    globalThis.fetch = async () => sseResponse([encoder.encode('data: [DONE]\n\n')]);
    const fewShot = {
        selectExamples: async () => { throw new Error('pool broken'); },
        buildExampleMessages: () => [],
    };

    const { content } = await streamLLM({
        provider: 'openai',
        message: baseMessage,
        options: { ...baseOptions, fewShotEnabled: true, openaiContextWindow: '500' },
        signal: new AbortController().signal,
        buildUrl: () => 'x', buildHeaders: () => ({}), buildBody: () => ({}),
        fewShot
    });

    assert.equal(content, '');
});
