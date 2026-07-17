// chunks.js — Chunks page logic for AI Webnovel Translator v3
// Uses browser-polyfill, marked.js, DOMPurify

// ─── Marked config ────────────────────────────────────────────────────────────
if (typeof marked !== 'undefined') {
    // Disable hyperlinks — render as plaintext [text](url)
    marked.use({
        breaks: true,
        gfm: true,
        pedantic: false,
        mangle: false,
        headerIds: false,
        renderer: {
            link(token) { return token.raw ?? ''; }
        },
        walkTokens(token) {
            // Convert strikethrough tokens to text so the ~~content~~ is preserved literally
            if (token.type === 'del') {
                token.type = 'text';
                token.text = `~~${token.text ?? ''}~~`;
                token.raw = token.raw ?? '';
            }
        }
    });
}

// function renderMarkdown(text) {
//     if (typeof marked === 'undefined') return `<p>${escapeHtml(text)}</p>`;
//     // Escape all HTML tags to plaintext except <img> tags which we need for rendering.
//     // We do this BEFORE marked.parse() so marked never sees real HTML tags → no recursion.
//     // Strategy: temporarily extract <img> tags, escape everything else, put <img> back.
//     const imgTags = [];
//     let processed = (text || '').replace(/<img[^>]*>/gi, match => {
//         imgTags.push(match);
//         return `\x00IMG${imgTags.length - 1}\x00`;
//     });
//     processed = escapeHtml(processed); // escapeHtml has no effect on \x00 placeholders
//     imgTags.forEach((tag, i) => { processed = processed.replace(`\x00IMG${i}\x00`, tag); });
//     const html = marked.parse(processed);
//     return DOMPurify.sanitize(html, {
//         ADD_ATTR: ['target', 'data-original-src', 'style'],
//         FORBID_TAGS: ['style', 'script']
//     });
// }

// function escapeHtml(t) {
//     return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// }
function decodeHtmlEntities(t) {
    return t
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function escapeHtml(t) {
    return t
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderMarkdown(text) {
    if (typeof marked === 'undefined') return `<p>${escapeHtml(text)}</p>`;

    const imgTags = [];
    // Decode entities first so we always work with literal chars, never double-encoded strings
    let processed = decodeHtmlEntities(text || '');

    // Extract <img> tags before escaping
    processed = processed.replace(/<img[^>]*>/gi, match => {
        imgTags.push(match);
        return `\x00IMG${imgTags.length - 1}\x00`;
    });

    // Now escape everything (starting from clean literals, so no double-encoding)
    processed = escapeHtml(processed);

    // Restore <img> tags
    imgTags.forEach((tag, i) => {
        processed = processed.replace(`\x00IMG${i}\x00`, tag);
    });

    const html = marked.parse(processed);
    return DOMPurify.sanitize(html, {
        ADD_ATTR: ['target', 'data-original-src', 'style'],
        FORBID_TAGS: ['style', 'script']
    });
}
// Extract thinking content from <think>...</think> tags
function extractThinking(text) {
    const thinking = [];
    const regex = /<think>([\s\S]*?)<\/think>/gi;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const content = match[1].trim();
        if (content) thinking.push(content);
    }
    return thinking;
}

// Remove thinking tags from text
function removeThinking(text) {
    return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// ─── State ────────────────────────────────────────────────────────────────────
let sessionId = null;
let allChunks = [];
let prefix = '', suffix = '';
let retryCount = 3;
let isProcessing = false;
let totalChunks = 0;
let completedChunks = 0;
let processedResults = [];   // { content, rawContent } per index
let processedThinking = [];  // thinking content per index (extracted from <think> tags)
let streamingIndex = -1;
let reprocessingState = { isActive: false, targetIndex: -1 };
let _terminated = false;

// ─── Collections state ──────────────────────────────────────────────────────
let collectionsList = {};     // collections map from storage
let collectionDefaults = { global: null, perSession: {} };
let autoAddEnabled = false;

function resolveDefaultCollection(sessionId) {
    const per = collectionDefaults.perSession;
    if (Object.prototype.hasOwnProperty.call(per, sessionId)) return per[sessionId];
    return collectionDefaults.global ?? null;
}

async function renderCollectionSelector() {
    const sel = document.getElementById('collectionDefaultSelect');
    const cb = document.getElementById('collectionAutoAdd');
    if (!sel || !cb) return;
    const resolved = resolveDefaultCollection(sessionId);
    // Preserve user selection while rebuilding options.
    const existingValue = sel.value;
    sel.innerHTML = '<option value="">None</option>' +
        Object.values(collectionsList).map(c =>
            `<option value="${escapeHtml(c.id)}"${c.id === resolved ? ' selected' : ''}>${escapeHtml(c.name)}</option>`
        ).join('');
    // If nothing was explicitly set for this session and a global default exists, reflect it.
    if (existingValue) sel.value = existingValue;
    else if (resolved) sel.value = resolved;
    cb.checked = autoAddEnabled && !!resolved;
}

document.getElementById('collectionDefaultSelect')?.addEventListener('change', async (e) => {
    const val = e.target.value || null;
    // Capture the prior value before mutating local state so we can roll back on failure.
    const prior = collectionDefaults.perSession[sessionId] ?? null;
    collectionDefaults.perSession[sessionId] = val;
    try {
        const res = await browser.runtime.sendMessage({ action: 'setCollectionSessionDefault', sessionId, value: val });
        if (res?.error) throw new Error(res.error);
    } catch (err) {
        // Restore the previous value and re-render the selector to reflect it.
        collectionDefaults.perSession[sessionId] = prior;
        renderCollectionSelector();
        showToast(`❌ Failed to save session default: ${err.message}`, 'error');
    }
});

document.getElementById('collectionAutoAdd')?.addEventListener('change', (e) => {
    autoAddEnabled = e.target.checked;
});

// Single delegated handler: close any open "Add to" dropdown when clicking outside it.
document.addEventListener('click', (e) => {
    if (!e.target.closest('.add-to-dropdown')) {
        document.querySelectorAll('.add-to-dropdown.open').forEach(d => d.classList.remove('open'));
    }
});

function populateAddToMenu(index, menuEl) {
    if (!menuEl) return;
    const colls = Object.values(collectionsList);
    if (colls.length === 0) {
        menuEl.innerHTML = `<button class="dropdown-item" data-action="new">✨ New collection…</button>`;
    } else {
        menuEl.innerHTML = colls.map(c => {
            const added = (c.entries || []).some(e => e.sessionId === sessionId && e.chunkIndex === index);
            return `<button class="dropdown-item${added ? ' added' : ''}" data-action="add" data-id="${escapeHtml(c.id)}" ${added ? 'disabled' : ''}>${added ? '✓ ' : ''}${escapeHtml(c.name)}</button>`;
        }).join('') +
            `<div class="dropdown-sep"></div><button class="dropdown-item" data-action="new">✨ New collection…</button>`;
    }
    menuEl.querySelectorAll('.dropdown-item[data-action="add"]').forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); addChunkToCollection(index, btn.dataset.id); });
    });
    menuEl.querySelector('.dropdown-item[data-action="new"]')?.addEventListener('click', (e) => {
        e.stopPropagation(); newCollectionAndAdd(index);
    });
}

async function addChunkToCollection(index, collectionId) {
    const r = processedResults[index];
    const content = r?.content?.text || '';
    const rawContent = r?.rawContent || allChunks[index] || '';
    if (!content && !rawContent) { showToast('Nothing to add — chunk is empty.', 'error'); return; }
    const coll = collectionsList[collectionId];
    if (!coll) { showToast('❌ Collection not found.', 'error'); return; }
    try {
        const res = await browser.runtime.sendMessage({
            action: 'addEntryToCollection',
            collectionId,
            entry: {
                sessionId: sessionId,
                chunkIndex: index,
                title: `Chunk ${index + 1}`,
                content,
                rawContent,
            },
        });
        if (res?.error) throw new Error(res.error);
        if (res?.alreadyPresent) { showToast('ℹ️ Already in this collection.', 'success'); }
        else { showToast(`✅ Added to ${escapeHtml(coll.name)}!`, 'success'); }
        // Update the in-memory cache so the checkmark reflects the new state.
        if (!res?.alreadyPresent && coll) {
            const existing = coll.entries.some(e => e.sessionId === sessionId && e.chunkIndex === index);
            if (!existing) {
                coll.entries.push({
                    id: crypto.randomUUID(),
                    sessionId, chunkIndex: index,
                    title: `Chunk ${index + 1}`,
                    content, rawContent,
                    addedAt: Date.now(),
                });
            }
        }
        // Refresh dropdowns.
        populateAddToMenu(index, document.getElementById(`chunk-addto-menu-${index}`));
    } catch (err) {
        showToast(`❌ Failed to add to collection: ${err.message}`, 'error');
    }
}

async function newCollectionAndAdd(index) {
    const name = prompt('Collection name:');
    if (!name || !name.trim()) return;
    try {
        const { collection } = await browser.runtime.sendMessage({
            action: 'createCollection', name: name.trim(),
        });
        if (!collection) throw new Error('Failed to create collection.');
        collectionsList[collection.id] = collection;
        renderCollectionSelector();
        // Refresh all dropdowns.
        document.querySelectorAll('[id^="chunk-addto-menu-"]').forEach(m => {
            const menuIndex = parseInt(m.id.replace('chunk-addto-menu-', ''), 10);
            if (!isNaN(menuIndex)) populateAddToMenu(menuIndex, m);
        });
        await addChunkToCollection(index, collection.id);
    } catch (err) {
        showToast(`❌ Failed to create collection: ${err.message}`, 'error');
    }
}

// Shared helper: auto-add a processed chunk to the resolved default collection.
// Extracted so both the normal streaming success path and the timeout-fallback path
// add the chunk with identical resolution, entry construction, and error handling.
async function autoAddProcessedChunk(index, sessId) {
    if (!autoAddEnabled) return;
    const collId = resolveDefaultCollection(sessId);
    if (!collId) return;
    const r = processedResults[index] || {};
    const content = r.content?.text || '';
    const rawContent = r.rawContent || allChunks[index] || '';
    if (!content && !rawContent) return;
    const coll = collectionsList[collId];
    try {
        const res = await browser.runtime.sendMessage({
            action: 'addEntryToCollection',
            collectionId: collId,
            entry: {
                sessionId: sessId,
                chunkIndex: index,
                title: `Chunk ${index + 1}`,
                content,
                rawContent,
            },
        });
        if (res?.error) throw new Error(res.error);
    } catch (err) {
        showToast(`❌ Failed to add chunk ${index + 1} to collection: ${err.message}`, 'error');
    }
}

// ─── Image Blob Cache cleanup ─────────────────────────────────────────────────
function cleanupImageBlobCache() {
    for (const blobUrl of imageBlobCache.values()) {
        URL.revokeObjectURL(blobUrl);
    }
    imageBlobCache.clear();
    // Abort any in-flight image fetches
    for (const controller of imageAbortControllers.values()) {
        controller.abort();
    }
    imageAbortControllers.clear();
}

// ─── URL param ────────────────────────────────────────────────────────────────
function getSessionId() {
    return new URLSearchParams(window.location.search).get('session');
}

// ─── Toast ────────────────────────────────────────────────────────────────────
let _toastTimer;
function showToast(msg, type = '') {
    const el = document.getElementById('toast');
    el.textContent = msg; el.className = 'show' + (type ? ' ' + type : '');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.className = '', 2500);
}

// ─── Banner ───────────────────────────────────────────────────────────────────
function showBanner(msg, type = '') {
    const el = document.getElementById('statusBanner');
    el.textContent = msg; el.className = type; el.style.display = msg ? 'block' : 'none';
}

// ─── Progress bars ────────────────────────────────────────────────────────────
function updateOverallProgress(done, total) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    document.getElementById('overallBar').style.width = pct + '%';
    document.getElementById('overallPercent').textContent = pct + '%';
    document.getElementById('overallLabel').textContent = `${done} / ${total} chunks`;
}

function updateAttemptProgress(attempt, max) {
    const section = document.getElementById('attemptProgress');
    if (!attempt || !max) { section.style.display = 'none'; return; }
    section.style.display = 'block';
    const pct = Math.round((attempt / max) * 100);
    document.getElementById('attemptBar').style.width = pct + '%';
    document.getElementById('attemptLabel').textContent = `Attempt ${attempt} / ${max}`;
    document.getElementById('attemptPercent').textContent = pct + '%';
}

// ─── Build chunk cards ────────────────────────────────────────────────────────
function buildChunkCards(chunks) {
    const container = document.getElementById('chunksContainer');
    container.innerHTML = '';
    chunks.forEach((raw, i) => {
        const card = document.createElement('div');
        card.className = 'chunk-card';
        card.id = `chunk-${i}`;
        card.innerHTML = `
      <div class="chunk-header" id="chunk-header-${i}">
        <div class="chunk-num">${i + 1}</div>
        <div class="chunk-header-info">
          <div class="chunk-header-title">Chunk ${i + 1}</div>
          <div class="chunk-header-preview" id="chunk-preview-${i}">${escapeHtml(raw.replace(/<[^>]*>/g, '').slice(0, 80))}…</div>
        </div>
        <span class="chunk-status-badge status-pending" id="chunk-badge-${i}">Pending</span>
        <span class="chunk-chevron">▾</span>
      </div>
      <div class="chunk-body">
        <div class="chunk-micro-bar"><div class="chunk-micro-fill" id="chunk-micro-${i}"></div></div>
        <div class="part-tabs" id="chunk-tabs-${i}"></div>
        <div class="part-contents" id="chunk-contents-${i}">
          <div class="part-content active" data-part="0">
            <div class="chunk-content-area" id="chunk-content-${i}"><em style="color:var(--text-muted)">Waiting…</em></div>
          </div>
        </div>
        <div class="chunk-actions" id="chunk-actions-${i}">
          <button class="btn btn-secondary btn-sm" id="chunk-copy-${i}">📋 Copy</button>
          <button class="btn btn-secondary btn-sm" id="chunk-copy-raw-${i}">📄 Copy Raw</button>
          <button class="btn btn-secondary btn-sm" id="chunk-reprocess-${i}">↩ Reprocess</button>
          <div class="add-to-dropdown" id="chunk-addto-${i}">
            <button class="btn btn-secondary btn-sm" id="chunk-addto-btn-${i}">⊕ Add to ▾</button>
            <div class="dropdown-menu" id="chunk-addto-menu-${i}"></div>
          </div>
        </div>
      </div>`;
        container.appendChild(card);

        // Collapse toggle
        card.querySelector('.chunk-header').addEventListener('click', () => {
            card.classList.toggle('collapsed');
        });

        // Action buttons
        document.getElementById(`chunk-copy-${i}`).addEventListener('click', (e) => { e.stopPropagation(); copyChunk(i, 'processed'); });
        document.getElementById(`chunk-copy-raw-${i}`).addEventListener('click', (e) => { e.stopPropagation(); copyChunkRaw(i); });
        document.getElementById(`chunk-reprocess-${i}`).addEventListener('click', (e) => { e.stopPropagation(); reprocessOne(i); });

        // ── "Add to collection" dropdown ─────────────────────────────────────
        const addEl = document.getElementById(`chunk-addto-${i}`);
        const addBtn = document.getElementById(`chunk-addto-btn-${i}`);
        const addMenu = document.getElementById(`chunk-addto-menu-${i}`);
        if (addEl && addBtn && addMenu) {
            addBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                // Close all other dropdowns.
                document.querySelectorAll('.add-to-dropdown.open').forEach(d => {
                    if (d !== addEl) d.classList.remove('open');
                });
                addEl.classList.toggle('open');
                populateAddToMenu(i, addMenu);
            });
        }
    });
}

function setChunkStatus(index, status) {
    const badge = document.getElementById(`chunk-badge-${index}`);
    const card = document.getElementById(`chunk-${index}`);
    if (!badge || !card) return;
    badge.className = 'chunk-status-badge';
    card.className = 'chunk-card';
    if (status === 'processing') { badge.classList.add('status-processing'); badge.textContent = '⏳ Processing'; card.classList.add('processing'); }
    else if (status === 'done') { badge.classList.add('status-done'); badge.textContent = '✅ Done'; card.classList.add('done'); }
    else if (status === 'error') { badge.classList.add('status-error'); badge.textContent = '❌ Error'; card.classList.add('error'); }
    else { badge.classList.add('status-pending'); badge.textContent = 'Pending'; }
}

function setMicroBar(index, mode) {
    const bar = document.getElementById(`chunk-micro-${index}`);
    const track = bar?.parentElement;
    if (!track) return;
    if (mode === 'pulse') { track.classList.add('pulse'); bar.style.width = '30%'; }
    else if (mode === 'done') { track.classList.remove('pulse'); bar.style.width = '100%'; }
    else { track.classList.remove('pulse'); bar.style.width = '0%'; }
}

// ─── Render content into a chunk ──────────────────────────────────────────────
const imageBlobCache = new Map();
const imageAbortControllers = new Map(); // src → AbortController

// Escape a string for use as a CSS attribute selector value
function escapeCssAttr(str) {
    return str.replace(/[\\"'`\n\r\t\f]/g, c => ({
        '\\': '\\\\', '"': '\\"', "'": "\\'", '\n': '\\A', '\r': '\\D',
        '\t': '\\9', '\f': '\\C'
    })[c]);
}

function renderChunk(index, text, isStreaming = false, reasoning = '') {
    const contentEl = document.getElementById(`chunk-content-${index}`);
    if (!contentEl) return;

    // Extract thinking from <think> tags and combine with OpenRouter reasoning
    const thinkingParts = extractThinking(text);
    if (reasoning) thinkingParts.push(reasoning);
    processedThinking[index] = thinkingParts.join('\n\n');

    // Remove thinking tags from main content
    const cleanText = removeThinking(text);

    contentEl.classList.toggle('streaming', isStreaming);
    contentEl.innerHTML = renderMarkdown(cleanText);
    handleImages(contentEl);

    // Render thinking section if there's thinking content
    renderThinkingSection(index);
}

function renderMultiPart(index, parts) {
    const tabsEl = document.getElementById(`chunk-tabs-${index}`);
    const contentsEl = document.getElementById(`chunk-contents-${index}`);
    if (!tabsEl || !contentsEl) return;
    tabsEl.innerHTML = '';
    contentsEl.innerHTML = '';

    // Extract thinking content from all parts
    const allThinking = [];
    parts.forEach(part => {
        const thinking = extractThinking(part);
        allThinking.push(...thinking);
    });
    processedThinking[index] = allThinking.join('\n\n');

    parts.forEach((part, pi) => {
        const tab = document.createElement('button');
        tab.className = 'part-tab' + (pi === 0 ? ' active' : '');
        tab.textContent = `Part ${pi + 1}`;
        tab.onclick = () => {
            tabsEl.querySelectorAll('.part-tab').forEach((t, i) => t.classList.toggle('active', i === pi));
            contentsEl.querySelectorAll('.part-content').forEach((c, i) => c.classList.toggle('active', i === pi));
        };
        tabsEl.appendChild(tab);
        const content = document.createElement('div');
        content.className = 'part-content' + (pi === 0 ? ' active' : '');
        content.dataset.part = pi;
        const area = document.createElement('div');
        area.className = 'chunk-content-area';
        area.innerHTML = renderMarkdown(removeThinking(part));
        handleImages(area);
        content.appendChild(area);
        contentsEl.appendChild(content);
    });

    // Render thinking section if there's thinking content
    renderThinkingSection(index);
}

function handleImages(el) {
    el.querySelectorAll('img').forEach(img => {
        let src = img.getAttribute('src') || '';

        if (src.startsWith('//')) {
            src = `https:${src}`;
        } else if (src && !src.startsWith('http') && !src.startsWith('data:')) {
            src = `https://images.novelpia.com${src.startsWith('/') ? '' : '/'}${src}`;
        }

        img.style.maxWidth = '100%';

        // Block dangerous URL schemes — prevents javascript: XSS and similar
        if (/^javascript:/i.test(src) || /^data:(?!image\/(png|jpeg|gif|webp))/i.test(src)) {
            const fallback = document.createElement('div');
            fallback.style.cssText = 'background:rgba(255,255,255,0.05);border:1px dashed rgba(255,255,255,0.1);border-radius:6px;padding:12px;font-size:0.75rem;color:var(--text-muted);text-align:center';
            fallback.textContent = '📷 Blocked unsafe image URL';
            img.replaceWith(fallback);
            return;
        }

        if (src.match(/\.file(\?.*)?$/i)) {
            img.dataset.originalSrc = src;

            if (imageBlobCache.has(src)) {
                img.src = imageBlobCache.get(src);
            } else {
                const loadingSvg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='50'%3E%3Ctext x='50' y='25' dominant-baseline='middle' text-anchor='middle' font-family='sans-serif' font-size='12' fill='%23888'%3ELoading...%3C/text%3E%3C/svg%3E";
                img.src = loadingSvg;
                imageBlobCache.set(src, loadingSvg);

                // Abort in-flight fetch if a new fetch for the same src starts (avoid duplicate fetches)
                if (imageAbortControllers.has(src)) {
                    imageAbortControllers.get(src).abort();
                }
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
                imageAbortControllers.set(src, controller);

                fetch(src, { signal: controller.signal })
                    .then(res => {
                        clearTimeout(timeout);
                        if (!res.ok) throw new Error(`HTTP ${res.status}`);
                        return res.blob();
                    })
                    .then(blob => {
                        imageAbortControllers.delete(src);
                        const objUrl = URL.createObjectURL(blob);
                        imageBlobCache.set(src, objUrl);
                        const escapedSrc = escapeCssAttr(src);
                        document.querySelectorAll(`img[data-original-src="${escapedSrc}"]`).forEach(targetImg => {
                            targetImg.src = objUrl;
                        });
                    })
                    .catch(err => {
                        clearTimeout(timeout);
                        imageAbortControllers.delete(src);
                        // Ignore AbortError (intentional abort)
                        if (err.name === 'AbortError') return;
                        console.error('Failed to convert .file image:', err);
                        imageBlobCache.delete(src);
                        const escapedSrc = escapeCssAttr(src);
                        document.querySelectorAll(`img[data-original-src="${escapedSrc}"]`).forEach(targetImg => {
                            targetImg.src = src;
                        });
                    });
            }
        } else if (src) {
            img.src = src;
        }
    });

    // Event delegation for image clicks and errors — bind once per container to avoid duplicates
    if (!el.dataset.imageHandlersBound) {
        el.dataset.imageHandlersBound = true;
        el.addEventListener('click', e => {
            const img = e.target.closest('img');
            if (!img) return;
            const openSrc = img.dataset.originalSrc || img.src;
            if (openSrc && !openSrc.startsWith('data:image/svg+xml')) {
                window.open(openSrc, '_blank');
            }
        });

        el.addEventListener('error', e => {
            const img = e.target.closest('img');
            if (!img || !img.src || img.src.startsWith('data:image/svg+xml')) return;
            const fallback = document.createElement('div');
            fallback.style.cssText = 'background:rgba(255,255,255,0.05);border:1px dashed rgba(255,255,255,0.1);border-radius:6px;padding:12px;font-size:0.75rem;color:var(--text-muted);text-align:center';
            fallback.textContent = '📷 Image failed to load';
            img.replaceWith(fallback);
        }, true);
    }
}

// ─── Render thinking section ────────────────────────────────────────────────────
function renderThinkingSection(index) {
    const thinkingContent = processedThinking[index];
    const card = document.getElementById(`chunk-${index}`);
    if (!card) return;

    // Remove existing thinking section if any
    const existingSection = card.querySelector('.thinking-section');
    if (existingSection) existingSection.remove();

    if (!thinkingContent) return;

    const thinkingSection = document.createElement('div');
    thinkingSection.className = 'thinking-section';
    thinkingSection.innerHTML = `
        <div class="thinking-header" id="thinking-header-${index}">
            <span class="thinking-toggle">▸</span>
            <span class="thinking-label">🤔 Thinking</span>
        </div>
        <div class="thinking-content" id="thinking-content-${index}">${escapeHtml(thinkingContent)}</div>
    `;

    // Insert at the beginning of the chunk body (above the content)
    const chunkBody = card.querySelector('.chunk-body');
    if (chunkBody) {
        chunkBody.insertBefore(thinkingSection, chunkBody.firstChild);
    }

    // Toggle collapse/expand
    const header = thinkingSection.querySelector('.thinking-header');
    header.addEventListener('click', (e) => {
        e.stopPropagation();
        thinkingSection.classList.toggle('collapsed');
        header.querySelector('.thinking-toggle').textContent = thinkingSection.classList.contains('collapsed') ? '▸' : '▾';
    });

    // Start collapsed
    thinkingSection.classList.add('collapsed');
}

// ─── Process all chunks sequentially ─────────────────────────────────────────
async function processAllChunks(resume = false) {
    const sessId = getSessionId();
    if (!sessId) { showBanner('No session ID — cannot process chunks.', 'error'); isProcessing = false; return; }
    _terminated = false;
    isProcessing = true;
    document.getElementById('terminateBtn').style.display = '';

    for (let i = 0; i < allChunks.length; i++) {
        if (_terminated) break;
        if (resume && processedResults[i]?.content) { completedChunks = i + 1; updateOverallProgress(completedChunks, totalChunks); continue; }

        streamingIndex = i;
        setChunkStatus(i, 'processing');
        setMicroBar(i, 'pulse');
        updateAttemptProgress(1, retryCount);

        // Expand card being processed
        const card = document.getElementById(`chunk-${i}`);
        card?.classList.remove('collapsed');

        let success = false;
        for (let attempt = 0; attempt < retryCount; attempt++) {
            if (_terminated) break;
            _streamCompleteFlags[i] = false; // Reset per-chunk streaming state before each retry
            updateAttemptProgress(attempt + 1, retryCount);
            // Capture accumulated content as checkpoint for this retry attempt.
            // Uses a minimal directive to avoid confusing LLMs that might echo the marker text.
            const existingContent = processedResults[i]?.content?.text || null;
            const checkpointPrefix = existingContent
                ? `${prefix}\n\nContinue from the following content:\n${existingContent}\n\n`
                : prefix;
            try {
                const result = await browser.runtime.sendMessage({
                    action: 'processChunk',
                    chunk: allChunks[i],
                    prefix: checkpointPrefix,
                    suffix,
                    sessionId: sessId
                });

                if (_terminated) break;
                if (result.error) throw new Error(result.error);

                if (result.streaming) {
                    // Streaming updates come via message listener; wait for them
                    const { timedOut } = await waitForStreamComplete(i);
                    if (_terminated) { success = !!processedResults[i]?.content?.text; break; }
                    // If safety timeout fired but we have a direct response, use it instead of retrying
                    if (timedOut && result.result) {
                        processedResults[i] = { content: { parts: [result.result], text: result.result }, rawContent: allChunks[i] };
                        renderChunk(i, result.result, false);
                        await saveChunk(i, processedResults[i].content, allChunks[i]);
                        await autoAddProcessedChunk(i, sessId);
                        success = true; break;
                    }
                    if (timedOut) { throw new Error('Streaming timed out after 5 minutes'); }
                    // Normal streaming completion — auto-add so every successfully processed stream adds its chunk.
                    await autoAddProcessedChunk(i, sessId);
                    success = true; break;
                }

                // Non-streaming
                const parts = result.parts || [result.result];
                if (parts.length > 1) renderMultiPart(i, parts);
                else renderChunk(i, result.result, false);

                processedResults[i] = { content: { parts, text: result.result }, rawContent: allChunks[i] };
                await saveChunk(i, processedResults[i].content, allChunks[i]);
                await autoAddProcessedChunk(i, sessId);
                success = true; break;
            } catch (err) {
                if (_terminated) break;
                console.error(`Chunk ${i} attempt ${attempt + 1} failed:`, err);
                if (attempt === retryCount - 1) {
                    const errEl = document.getElementById(`chunk-content-${i}`);
                    if (errEl) errEl.innerHTML = `<div class="chunk-error-box">❌ ${escapeHtml(err.message)}</div>`;
                    setChunkStatus(i, 'error');
                    setMicroBar(i, 'reset');
                    showBanner(`Chunk ${i + 1} failed: ${err.message}`, 'error');
                } else {
                    await new Promise(r => setTimeout(r, 7000));
                }
            }
        }

        if (_terminated) {
            // Mark current chunk as done if it has content
            if (processedResults[i]?.content?.text) {
                setChunkStatus(i, 'done'); setMicroBar(i, 'done');
                completedChunks = i + 1; updateOverallProgress(completedChunks, totalChunks);
            }
            break;
        }
        if (success) { setChunkStatus(i, 'done'); setMicroBar(i, 'done'); completedChunks = i + 1; updateOverallProgress(completedChunks, totalChunks); updateAttemptProgress(0, retryCount); }
    }

    isProcessing = false; streamingIndex = -1;
    document.getElementById('terminateBtn').style.display = 'none';
    updateAttemptProgress(0, retryCount);
    const allDone = processedResults.filter(r => r?.content).length;
    if (allDone === totalChunks) showBanner(`✅ All ${totalChunks} chunks processed!`, 'success');
}

// ─── Streaming wait ───────────────────────────────────────────────────────────
function waitForStreamComplete(index) {
    return new Promise(resolve => {
        const check = setInterval(() => {
            if (!isStreamingActive(index)) { clearInterval(check); resolve({ timedOut: false }); }
        }, 200);
        // Safety timeout 5 min — signal timeout so caller can treat as failure
        setTimeout(() => {
            clearInterval(check);
            resolve({ timedOut: true });
        }, 300000);
    });
}

let _streamCompleteFlags = {};
function isStreamingActive(index) { return !_streamCompleteFlags[index]; }


// ─── Message handler (streaming updates from service worker) ──────────────────
browser.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'initializeChunksPage') {
        initPage();
        return;
    }

    if (msg.action === 'updateStreamContent') {
        if (_terminated) return; // Once terminated, ignore all streaming updates
        const index = reprocessingState.isActive ? reprocessingState.targetIndex : streamingIndex;
        if (index < 0) return;

        if (msg.isInitial) {
            const el = document.getElementById(`chunk-content-${index}`);
            if (el) el.innerHTML = '<span class="spinner"></span>';
            setMicroBar(index, 'pulse');
        } else {
            renderChunk(index, msg.content, !msg.isComplete, msg.reasoning || '');
            // Save incrementally on every streaming update
            const text = msg.content || '';
            processedResults[index] = { content: { parts: [text], text }, rawContent: msg.rawContent || allChunks[index] };
            saveChunk(index, processedResults[index].content, processedResults[index].rawContent);
        }

        if (msg.isComplete) {
            _streamCompleteFlags[index] = true;
            const text = msg.content || '';
            if (text) {
                processedResults[index] = { content: { parts: [text], text }, rawContent: msg.rawContent || allChunks[index] };
                saveChunk(index, processedResults[index].content, processedResults[index].rawContent);
            }
            if (reprocessingState.isActive && reprocessingState.targetIndex === index) {
                reprocessingState.isActive = false;
                const existing = processedResults[index];
                const hasContent = existing?.content?.text;
                setChunkStatus(index, hasContent ? 'done' : 'error');
                setMicroBar(index, hasContent ? 'done' : 'reset');
                showToast(hasContent ? '✅ Reprocessed!' : '❌ Reprocess failed', hasContent ? 'success' : 'error');
            }
        }
    }
});

// ─── Storage helpers ──────────────────────────────────────────────────────────
async function saveChunk(index, content, rawContent) {
    const sessId = getSessionId();
    if (!sessId) return;
    const { processedChunks = {}, translationSessions = [] } = await browser.storage.local.get(['processedChunks', 'translationSessions']);
    const sessChunks = processedChunks[sessId] || [];
    sessChunks[index] = { content, rawContent };
    processedChunks[sessId] = sessChunks;
    const { maxSessions = 3 } = await browser.storage.local.get('maxSessions');
    const recentIds = translationSessions.sort((a, b) => b.timestamp - a.timestamp).slice(0, maxSessions).map(s => s.id);
    const filtered = {};
    recentIds.forEach(sid => { if (processedChunks[sid]) filtered[sid] = processedChunks[sid]; });
    await browser.storage.local.set({ processedChunks: filtered });
}

// ─── Copy / Download ──────────────────────────────────────────────────────────
function getAllProcessedText() {
    return processedResults.map(r => (r?.content?.text || '')).filter(Boolean);
}

async function copyChunk(index, type = 'processed') {
    const chunkEl = document.getElementById(`chunk-content-${index}`);
    const text = type === 'processed'
        ? (processedResults[index]?.content?.text || chunkEl?.innerText || '')
        : (processedResults[index]?.rawContent || allChunks[index] || '');
    try {
        await navigator.clipboard.writeText(text);
        showToast('📋 Copied!', 'success');
    } catch { showToast('❌ Copy failed', 'error'); }
}

async function copyChunkRaw(index) {
    const raw = processedResults[index]?.rawContent || allChunks[index] || '';
    const parts = [prefix, raw, suffix].filter(Boolean);
    let text = parts.join('\n');
    let hadExamples = false;
    // Mirror the web-automation injection: prepend the few-shot example block so
    // the copied prompt matches what the provider would actually receive.
    try {
        const { fewShotEnabled = false } = await browser.storage.local.get('fewShotEnabled');
        if (fewShotEnabled) {
            const examples = await selectForShot({ maxBudgetChars: 0, chunkText: text });
            const exampleBlock = buildExampleTextBlock(examples);
            if (exampleBlock) {
                text = `${exampleBlock}\n\n${text}`;
                hadExamples = true;
            }
        }
    } catch (err) {
        console.error('[fewshot] copyChunkRaw example lookup failed:', err);
    }
    try {
        await navigator.clipboard.writeText(text);
        showToast(hadExamples ? '📄 Copied raw (with examples + prefix/suffix)!' : '📄 Copied raw (with prefix/suffix)!', 'success');
    } catch { showToast('❌ Copy failed', 'error'); }
}

async function copyAll() {
    const parts = getAllProcessedText();
    if (!parts.length) { showToast('Nothing to copy yet.', 'error'); return; }
    await navigator.clipboard.writeText(parts.join('\n\n---\n\n'));
    showToast(`📋 Copied all ${parts.length} chunks!`, 'success');
}

function downloadAll() {
    const parts = getAllProcessedText();
    if (!parts.length) { showToast('Nothing to download yet.', 'error'); return; }
    const blob = new Blob([parts.join('\n\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `translation-${sessionId?.slice(0, 8) || 'result'}.txt`; a.click();
    URL.revokeObjectURL(url);
    showToast('⬇ Downloaded!', 'success');
}

// ─── Reprocess individual chunk ───────────────────────────────────────────────
async function reprocessOne(index) {
    if (reprocessingState.isActive) { showToast('Already reprocessing, please wait.', 'error'); return; }
    // Block reprocessing if ANY chunk is actively processing (even if it's this one)
    if (isProcessing) { showToast('Wait for current processing to finish first.', 'error'); return; }
    const sessId = getSessionId();

    let storedData;
    try {
        storedData = await browser.runtime.sendMessage({ action: 'getStoredData', sessionId: sessId });
    } catch (err) {
        showToast(`❌ Failed to load session data: ${err.message}`, 'error');
        return;
    }
    const pfx = storedData.prefix || prefix;
    const sfx = storedData.suffix || suffix;
    const rc = storedData.retryCount || retryCount;

    // Clear saved storage
    const { processedChunks = {} } = await browser.storage.local.get('processedChunks');
    const sessChunks = processedChunks[sessId] || [];
    if (sessChunks[index]) { delete sessChunks[index]; processedChunks[sessId] = sessChunks; await browser.storage.local.set({ processedChunks }); }

    // Clear in-memory result and UI immediately
    processedResults[index] = null;
    const contentEl = document.getElementById(`chunk-content-${index}`);
    if (contentEl) contentEl.innerHTML = '<em style="color:var(--text-muted)">Reprocessing…</em>';

    reprocessingState = { isActive: true, targetIndex: index };
    _streamCompleteFlags[index] = false;
    setChunkStatus(index, 'processing');
    setMicroBar(index, 'pulse');
    document.getElementById(`chunk-${index}`)?.classList.remove('collapsed');

    for (let attempt = 0; attempt < rc; attempt++) {
        _streamCompleteFlags[index] = false; // Reset per-chunk streaming state before each retry
        updateAttemptProgress(attempt + 1, rc);
        // Recompute checkpoint from current partial output each attempt (supports streaming resume)
        const currentContent = processedResults[index]?.content?.text || null;
        const checkpointPrefix = currentContent ? `${pfx}\n\nContinue from the following content:\n${currentContent}\n\n` : pfx;
        try {
            const result = await browser.runtime.sendMessage({ action: 'processChunk', chunk: allChunks[index], prefix: checkpointPrefix, suffix: sfx, sessionId: sessId });
            if (result.error) throw new Error(result.error);
            if (result.streaming) {
                const { timedOut } = await waitForStreamComplete(index);
                reprocessingState.isActive = false;
                // If safety timeout fired but we have a direct response, use it instead of retrying
                if (timedOut && result.result) {
                    processedResults[index] = { content: { parts: [result.result], text: result.result }, rawContent: allChunks[index] };
                    renderChunk(index, result.result, false);
                    await saveChunk(index, processedResults[index].content, allChunks[index]);
                    setChunkStatus(index, 'done'); setMicroBar(index, 'done');
                    showToast('✅ Reprocessed!', 'success');
                    return;
                }
                if (timedOut) { throw new Error('Streaming timed out after 5 minutes'); }
                return;
            }
            const parts = result.parts || [result.result];
            parts.length > 1 ? renderMultiPart(index, parts) : renderChunk(index, result.result, false);
            processedResults[index] = { content: { parts, text: result.result }, rawContent: allChunks[index] };
            await saveChunk(index, processedResults[index].content, allChunks[index]);
            setChunkStatus(index, 'done'); setMicroBar(index, 'done');
            showToast('✅ Reprocessed!', 'success');
            reprocessingState.isActive = false;
            return;
        } catch (err) {
            if (attempt === rc - 1) {
                showToast(`❌ Reprocess failed: ${err.message}`, 'error');
                setChunkStatus(index, 'error'); setMicroBar(index, 'reset');
                reprocessingState.isActive = false;
                return;
            }
            await new Promise(r => setTimeout(r, 7000));
        }
    }
}

// ─── Reprocess all ────────────────────────────────────────────────────────────
async function reprocessAll() {
    if (isProcessing) { showToast('Processing already in progress. Please wait or terminate first.', 'error'); return; }
    if (!confirm(`Reprocess all ${totalChunks} chunks? All saved results will be cleared.`)) return;
    const sessId = getSessionId();
    const { processedChunks = {} } = await browser.storage.local.get('processedChunks');
    delete processedChunks[sessId];
    await browser.storage.local.set({ processedChunks });
    processedResults = [];
    processedThinking = [];
    completedChunks = 0;
    _terminated = false;
    _streamCompleteFlags = {};
    buildChunkCards(allChunks);
    updateOverallProgress(0, totalChunks);
    await processAllChunks(false);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function initPage() {
    cleanupImageBlobCache(); // Clear any leftover Blob URLs from previous sessions
    sessionId = getSessionId();
    document.getElementById('sessionId').textContent = sessionId ? `Session: ${sessionId.slice(0, 12)}…` : 'No session';

    if (!sessionId) { showBanner('No session ID in URL.', 'error'); return; }

    // Load session data
    const { translationSessions = [] } = await browser.storage.local.get('translationSessions');
    const session = translationSessions.find(s => s.id === sessionId);

    let storedData;
    try {
        storedData = await browser.runtime.sendMessage({ action: 'getStoredData', sessionId });
    } catch (err) {
        showBanner(`Failed to load session data: ${err.message}`, 'error');
        return;
    }
    allChunks = session?.chunks || storedData.chunks || [];
    prefix = session?.prefix || storedData.prefix || '';
    suffix = session?.suffix || storedData.suffix || '';
    retryCount = session?.retryCount || storedData.retryCount || 3;
    totalChunks = allChunks.length;

    // ── Load collection defaults + collections list ─────────────────────────
    try {
        const [colls, defs] = await Promise.all([
            browser.runtime.sendMessage({ action: 'getCollections' }),
            browser.runtime.sendMessage({ action: 'getCollectionDefaults' }),
        ]);
        collectionsList = colls?.collections ?? {};
        collectionDefaults = defs?.defaults ?? { global: null, perSession: {} };
    } catch (err) {
        console.warn('[collections] failed to load defaults:', err);
    }
    renderCollectionSelector();

    if (!totalChunks) { showBanner('No chunks to process.', 'error'); return; }

    buildChunkCards(allChunks);
    updateOverallProgress(0, totalChunks);

    // Apply chunk text size and max width from settings
    const { chunkFontSize = 1, chunkMaxWidth = 0 } = await browser.storage.local.get(['chunkFontSize', 'chunkMaxWidth']);
    document.documentElement.style.setProperty('--chunk-font-size', `${chunkFontSize}rem`);
    document.documentElement.style.setProperty('--chunk-max-width', chunkMaxWidth > 0 ? `${chunkMaxWidth}px` : 'none');

    // Load saved chunks
    const { processedChunks = {} } = await browser.storage.local.get('processedChunks');
    const saved = processedChunks[sessionId] || [];
    processedResults = new Array(totalChunks).fill(null);
    processedThinking = new Array(totalChunks).fill(null);

    let hasPartial = false;
    saved.forEach((chunk, i) => {
        if (!chunk) return;
        processedResults[i] = chunk;
        const parts = chunk.content?.parts || [chunk.content?.text || ''];
        if (parts.length > 1) renderMultiPart(i, parts);
        else renderChunk(i, parts[0] || '', false);
        setChunkStatus(i, 'done'); setMicroBar(i, 'done');
        _streamCompleteFlags[i] = true;
        completedChunks++;
        document.getElementById(`chunk-${i}`)?.classList.add('collapsed');
        hasPartial = true;
    });

    updateOverallProgress(completedChunks, totalChunks);

    if (completedChunks === totalChunks) {
        showBanner(`✅ All ${totalChunks} chunks already translated. Use "Reprocess All" to redo.`, 'success');
        return;
    }

    if (hasPartial) showBanner(`⚠️ Resuming incomplete session — ${completedChunks} / ${totalChunks} chunks already done.`, '');

    await processAllChunks(true);
}

// ─── Wire up buttons ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // Clean up Blob URLs when page unloads
    window.addEventListener('beforeunload', cleanupImageBlobCache);

    document.getElementById('reprocessAllBtn')?.addEventListener('click', reprocessAll);
    document.getElementById('copyAllBtn')?.addEventListener('click', copyAll);
    document.getElementById('downloadAllBtn')?.addEventListener('click', downloadAll);
    document.getElementById('terminateBtn')?.addEventListener('click', async () => {
        const idx = streamingIndex; // Save before anything changes
        _terminated = true;
        if (idx >= 0) _streamCompleteFlags[idx] = true;

        try {
            await browser.runtime.sendMessage({ action: 'terminateRequest', sessionId: getSessionId() });
        } catch (e) {
            console.error('Failed to send terminateRequest:', e);
        }

        // Re-render from processedResults to guarantee content is visible
        if (idx >= 0 && processedResults[idx]?.content?.text) {
            renderChunk(idx, processedResults[idx].content.text, false);
            setChunkStatus(idx, 'done');
            setMicroBar(idx, 'done');
            saveChunk(idx, processedResults[idx].content, processedResults[idx].rawContent);
        }
        showToast('⏹ Terminated.', '');
    });

    // If not initialized via message, init directly
    setTimeout(() => {
        if (!allChunks.length) initPage();
    }, 500);
});
