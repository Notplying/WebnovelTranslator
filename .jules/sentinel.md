## 2025-05-15 - [CRITICAL] Stored XSS in Chunk Rendering
**Vulnerability:** Found multiple instances of `innerHTML` assignment using untrusted content (webnovel text and AI translations) in `chunks.js`. The code was manually reconstructing HTML tags and copying attributes blindly, allowing XSS via event handlers (e.g., `onerror`) or script injection.
**Learning:** Even when using `marked` for markdown parsing, the final HTML output must be sanitized if the input can contain HTML tags (which `marked` allows by default). Manually reconstructing HTML nodes from strings is error-prone and can bypass intended safety checks. Dependencies in `chunks.html` were ordered incorrectly (`chunks.js` before `purify.min.js`), creating a race condition where `DOMPurify` might be undefined.
**Prevention:**
1. Always sanitize HTML content using a library like `DOMPurify` immediately before assigning to `innerHTML`.
2. Ensure security libraries (like `DOMPurify`) are loaded *before* the scripts that use them.
3. Configure `DOMPurify` to allow necessary attributes (e.g., `data-original-src`, `style`, `target`) to avoid breaking functionality while stripping dangerous ones.
