# The chunk pipeline is one loop with a promise-based stream wait

## Decision

`chunks_pipeline.js` exports `runChunkAttempts`, the single retry/checkpoint/timeout loop for translating one chunk, with every browser/DOM dependency injected (`getExistingContent`, `isTerminated`, `onAttempt`, `requestChunk`, `waitStream`, `renderDirect`, `onFailure`, `sleep`). Both chunks.js callers — process-all and reprocess-one — invoke it with their UI ceremony (statuses, toasts, auto-add-to-collection).

Streaming completion is a promise, not a poll: `waitForStreamComplete(index)` registers a one-shot resolver that the worker's `isComplete` stream message (`completeStreamWait`) settles; a 5-minute safety timer mirrors the old timeout. The terminate button resolves the pending wait too, so a stop never waits out the timer.

`initPage` is idempotent via an `_initStarted` guard.

## Context

`processAllChunks` and `reprocessOne` duplicated the loop and had already drifted — reprocess-one had no terminate check at all, and the checkpoint/error/timeout handling diverged. The worker pushed stream updates while the page polled a shared `_streamCompleteFlags` map every 200 ms with no owner, and `initPage` could double-fire (worker `initializeChunksPage` message vs the 500 ms fallback timer) with no guard, double-translating.

## Consequences

- The retry/checkpoint/timeout decision tree is written once and testable in Node without a DOM or messaging harness (`tests/chunks_pipeline.test.js`).
- Poll-over-push is gone; a stream wait is resolved by the completion message or the timer.
- Terminate is honored uniformly — including mid-reprocess, which previously ran to the timer.
- The `_initStarted` guard makes double-init harmless.
