// chunks_pipeline.js — the one retry/checkpoint/timeout loop for chunk
// translation. Page-only (loaded by chunks.html before chunks.js); every
// browser/DOM dependency is injected so the decision tree is testable in Node
// without a DOM or messaging harness.
//
// Why: processAllChunks and reprocessOne used to duplicate this loop and had
// already drifted — reprocessOne had no terminate check, and the
// checkpoint/error/timeout handling diverged. One owner now; callers keep
// only their UI ceremony (statuses, toasts, auto-add-to-collection).
//
// Top-level functions are browser globals; the module.exports block at the
// bottom enables Node testing (Node-only; inert in the browser).

const RETRY_DELAY_MS = 7000;
const STREAM_TIMEOUT_MS = 300000;

// Runs one chunk through the retry loop:
//   - per attempt: checkpoint prefix from accumulated partial content
//   - streaming: waits on waitStream(index) for the message-listener promise
//   - timeout with a direct response: uses the response instead of retrying
//   - errors: retries up to retryCount with RETRY_DELAY_MS between attempts
//   - terminate (isTerminated() true at any checkpoint): clean stop
//
// Deps:
//   getExistingContent()      → partial content text or null (per-attempt)
//   isTerminated()            → true once the user hit Terminate
//   onAttempt(n)              → progress UI for attempt n
//   requestChunk({chunk, checkpointPrefix, suffix}) → sendMessage result
//   waitStream(index)         → page-side promise resolved by the stream
//                               completion message, or { timedOut: true }
//   renderDirect(index, result) → render + persist a completed (non-streamed)
//                               result, incl. the timeout-fallback case
//   onFailure(err)            → last-attempt failure UI
//   sleep(ms)                 → retry delay (injected for tests)
//
// Returns:
//   { success: true, streamed: true }             — stream completed via messages
//   { success: true, usedTimeoutFallback: true }  — safety timeout + direct response
//   { success: true }                             — non-streaming completion
//   { success: false, error }                     — exhausted retries (onFailure ran)
//   { success: false, terminated: true }          — stopped by Terminate
async function runChunkAttempts({
    index, chunk, pfx, sfx, retryCount,
    getExistingContent, isTerminated, onAttempt, requestChunk, waitStream, renderDirect, onFailure,
    sleep = (ms) => new Promise(r => setTimeout(r, ms)),
}) {
    // Normalize retryCount into a valid attempt count: zero or NaN still
    // performs one attempt and must not fall through as "terminated".
    const rc = Number(retryCount);
    const attempts = Number.isFinite(rc) && rc >= 1 ? Math.floor(rc) : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
        if (isTerminated()) break;
        onAttempt(attempt + 1);
        // Capture accumulated content as checkpoint for this retry attempt.
        // Uses a minimal directive to avoid confusing LLMs that might echo the marker text.
        const existingContent = getExistingContent();
        const checkpointPrefix = existingContent
            ? `${pfx}\n\nContinue from the following content:\n${existingContent}\n\n`
            : pfx;
        try {
            const result = await requestChunk({ chunk, checkpointPrefix, suffix: sfx });
            if (isTerminated()) break;
            if (result.error) throw new Error(result.error);

            if (result.streaming) {
                // Streaming updates come via the message listener; wait for them.
                const { timedOut } = await waitStream(index);
                if (isTerminated()) break;
                // If the safety timeout fired but we have a direct response, use it instead of retrying.
                if (timedOut && result.result) {
                    await renderDirect(index, result);
                    return { success: true, usedTimeoutFallback: true };
                }
                if (timedOut) throw new Error('Streaming timed out after 5 minutes');
                return { success: true, streamed: true };
            }

            await renderDirect(index, result);
            return { success: true };
        } catch (err) {
            if (isTerminated()) break;
            if (attempt === attempts - 1) {
                await onFailure(err);
                return { success: false, error: err };
            }
            await sleep(RETRY_DELAY_MS);
        }
    }
    return { success: false, terminated: true };
}

// ─── Node test seam (fewshot.js/settings.js pattern; inert in the browser) ─────
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { runChunkAttempts, RETRY_DELAY_MS, STREAM_TIMEOUT_MS };
}
