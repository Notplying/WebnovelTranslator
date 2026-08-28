// Chunk translation retry/checkpoint/timeout loop decision tree.
// Run: node --test tests/chunks_pipeline.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runChunkAttempts } = require('../chunks_pipeline.js');

// ─── Fake harness ──────────────────────────────────────────────────────────────
// Builds the injected deps. Results can be queued per request; isTerminated
// can flip after N calls; sleep records calls and resolves immediately.
function harness({ results = [], terminatedAt = Infinity } = {}) {
  const calls = {
    requestChunk: [],
    onAttempt: [],
    renderDirect: [],
    onFailure: [],
    sleep: [],
    waitStream: [],
  };
  let requestCount = 0;
  let terminatedCalls = 0;
  const h = {
    calls,
    deps: {
      index: 0,
      chunk: 'chunk text',
      pfx: 'PREFIX',
      sfx: 'SUFFIX',
      retryCount: 3,
      getExistingContent: () => null,
      isTerminated: () => ++terminatedCalls >= terminatedAt,
      onAttempt: (n) => calls.onAttempt.push(n),
      requestChunk: async (req) => { calls.requestChunk.push(req); return results[Math.min(requestCount++, results.length - 1)]; },
      waitStream: async (i) => { calls.waitStream.push(i); return { timedOut: false }; },
      renderDirect: async (i, r) => { calls.renderDirect.push([i, r]); },
      onFailure: async (err) => { calls.onFailure.push(err); },
      sleep: async (ms) => { calls.sleep.push(ms); },
    },
  };
  return h;
}

// ─── Non-streaming ─────────────────────────────────────────────────────────────

test('non-streaming success: one request, renderDirect, no retry', async () => {
  const h = harness({ results: [{ result: 'T', parts: ['T'], streaming: false }] });
  const out = await runChunkAttempts(h.deps);
  assert.deepEqual(out, { success: true });
  assert.equal(h.calls.requestChunk.length, 1);
  assert.equal(h.calls.renderDirect.length, 1);
  assert.equal(h.calls.onFailure.length, 0);
});

test('non-streaming multi-part result passes through renderDirect untouched', async () => {
  const h = harness({ results: [{ result: 'T', parts: ['a', 'b'], streaming: false }] });
  await runChunkAttempts(h.deps);
  assert.deepEqual(h.calls.renderDirect[0][1].parts, ['a', 'b']);
});

// ─── Streaming ─────────────────────────────────────────────────────────────────

test('streaming success: waits, no renderDirect, flags streamed', async () => {
  const h = harness({ results: [{ result: 'T', streaming: true }] });
  const out = await runChunkAttempts(h.deps);
  assert.deepEqual(out, { success: true, streamed: true });
  assert.equal(h.calls.waitStream.length, 1);
  assert.equal(h.calls.renderDirect.length, 0);
});

test('streaming timeout with direct response: uses the response (no retry)', async () => {
  const h = harness({ results: [{ result: 'T', streaming: true }] });
  h.deps.waitStream = async () => ({ timedOut: true });
  const out = await runChunkAttempts(h.deps);
  assert.deepEqual(out, { success: true, usedTimeoutFallback: true });
  assert.equal(h.calls.renderDirect.length, 1);
  assert.equal(h.calls.requestChunk.length, 1); // no retry
});

test('streaming timeout without response: throws, retries, fails after retryCount', async () => {
  const h = harness({ results: [{ result: null, streaming: true }] });
  h.deps.waitStream = async () => ({ timedOut: true });
  const out = await runChunkAttempts(h.deps);
  assert.deepEqual(out.success, false);
  assert.ok(out.error instanceof Error);
  assert.match(out.error.message, /timed out/);
  assert.equal(h.calls.requestChunk.length, 3); // all attempts made
  assert.equal(h.calls.onFailure.length, 1); // onFailure ran once, at the end
  assert.equal(h.calls.sleep.length, 2); // 7s delay between attempts 1→2, 2→3
  assert.equal(h.calls.sleep[0], 7000);
});

// ─── Errors / retries ──────────────────────────────────────────────────────────

test('result.error throws → retries with sleep, onFailure on last attempt', async () => {
  const h = harness({ results: [
    { error: 'boom 1' }, { error: 'boom 2' }, { result: 'T', parts: ['T'], streaming: false },
  ] });
  const out = await runChunkAttempts(h.deps);
  assert.deepEqual(out, { success: true });
  assert.deepEqual(h.calls.onAttempt, [1, 2, 3]);
  assert.equal(h.calls.sleep.length, 2);
});

test('all attempts fail: onFailure called with the last error, { success: false, error }', async () => {
  const h = harness({ results: [{ error: 'x' }, { error: 'y' }, { error: 'z' }] });
  const out = await runChunkAttempts(h.deps);
  assert.deepEqual(out.success, false);
  assert.equal(out.error.message, 'z');
  assert.equal(h.calls.onFailure.length, 1);
  assert.equal(h.calls.onFailure[0].message, 'z');
});

test('retryCount 1: single attempt, no sleep', async () => {
  const h = harness({ results: [{ error: 'x' }] });
  h.deps.retryCount = 1;
  const out = await runChunkAttempts(h.deps);
  assert.equal(h.calls.requestChunk.length, 1);
  assert.equal(h.calls.sleep.length, 0);
  assert.equal(out.success, false);
});

// ─── Checkpoint ────────────────────────────────────────────────────────────────

test('checkpoint: accumulated content becomes the Continue directive', async () => {
  const h = harness({ results: [{ result: 'T', parts: ['T'], streaming: false }] });
  h.deps.getExistingContent = () => 'PARTIAL';
  await runChunkAttempts(h.deps);
  assert.match(h.calls.requestChunk[0].checkpointPrefix,
    /^PREFIX\n\nContinue from the following content:\nPARTIAL\n\n$/);
  assert.equal(h.calls.requestChunk[0].chunk, 'chunk text');
  assert.equal(h.calls.requestChunk[0].suffix, 'SUFFIX');
});

test('checkpoint: no content → plain prefix', async () => {
  const h = harness({ results: [{ result: 'T', parts: ['T'], streaming: false }] });
  await runChunkAttempts(h.deps);
  assert.equal(h.calls.requestChunk[0].checkpointPrefix, 'PREFIX');
});

// ─── Terminate ─────────────────────────────────────────────────────────────────

test('terminate before first attempt: clean stop, no request', async () => {
  const h = harness();
  h.deps.isTerminated = () => true;
  const out = await runChunkAttempts(h.deps);
  assert.deepEqual(out, { success: false, terminated: true });
  assert.equal(h.calls.requestChunk.length, 0);
  assert.equal(h.calls.onFailure.length, 0);
});

test('terminate mid-stream: stops after wait, no onFailure, no retry', async () => {
  const h = harness({ results: [{ result: 'T', streaming: true }] });
  let terminated = false;
  h.deps.isTerminated = () => terminated;
  // Flip terminated right after the streaming wait resolves.
  h.deps.waitStream = async () => { terminated = true; return { timedOut: false }; };
  const out = await runChunkAttempts(h.deps);
  assert.deepEqual(out, { success: false, terminated: true });
  assert.equal(h.calls.requestChunk.length, 1); // first attempt only
  assert.equal(h.calls.onFailure.length, 0);
});

test('terminate after a failed attempt: no retry sleep, no onFailure', async () => {
  const h = harness({ results: [{ error: 'x' }] });
  let terminated = false;
  h.deps.isTerminated = () => terminated;
  h.deps.sleep = async (ms) => { h.calls.sleep.push(ms); terminated = true; }; // "terminated during the 7s wait"
  const out = await runChunkAttempts(h.deps);
  assert.deepEqual(out, { success: false, terminated: true });
  assert.equal(h.calls.requestChunk.length, 1);
  assert.equal(h.calls.sleep.length, 1); // the first 7s delay ran
  assert.equal(h.calls.onFailure.length, 0);
});
