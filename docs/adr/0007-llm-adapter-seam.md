# One LLM adapter seam with provider descriptors

## Decision

`llm.js` exposes `streamLLM({ provider, message, options, signal, buildUrl, buildHeaders, buildBody, onDelta, fewShot })` — the single seam owning fetch, timeout, abort, SSE normalization and the longest-common-suffix-prefix overlap helper (exported for tests; retry-resume dedup is not wired). Each HTTP provider is a descriptor row (`extractEvent`, `parseErrorBody`, `acceptsLineWithoutNewline`, `contextWindowKey`); URL/header/body builders that read option keys live in the worker's `HTTP_PROVIDER_CONFIGS`. Errors are classed at the seam (`HttpError` / `TimeoutError` / `AbortError`) and mapped to user strings at the worker edge (401 → Invalid API key, 429 → Rate limit exceeded). The web-automation providers (chatgptWeb / geminiWeb) share no transport with HTTP and stay in the worker.

## Context

Five providers each re-implemented the timeout/abort dance, the SSE parse + LCS dedup loop was written twice, auth was three mechanisms, and the result shape leaked which provider ran — consumers feature-detected `parts` vs `result`.

## Consequences

- Five providers, one interface; a new provider is a descriptor row plus builders.
- The result shape is owned by the `service_worker.js` boundary, not the seam: `streamLLM` returns `{ content, reasoning }`, and the worker maps that to `{ result, parts, streaming, complete }` when replying to the pages. Consumers of the worker (chunks.js / options.js) must not depend on the seam's shape, and seam callers must not depend on the worker's reply shape; feature-detection between them is gone.
- Timeout, parse and debounce are written once and covered by `tests/llm.test.js` (fake `fetch` with ReadableStream bodies).
- The seam owns per-session debounce bookkeeping, so concurrent streams don't share timers.
