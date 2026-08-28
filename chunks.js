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

// escapeHtml + decodeHtmlEntities live in utils.js (single convention for
// both pages; escapeHtml includes &quot; for attribute contexts).

// Sanitized markdown as a DOM fragment (RETURN_DOM) so callers can
// replaceChildren() instead of assigning innerHTML — satisfies web-ext lint.
function renderMarkdownFragment(text) {
    if (typeof marked === 'undefined') {
        const p = document.createElement('p');
        p.textContent = text || '';
        return p;
    }

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

    // Escape stray numeric list markers (e.g. "607." / "607) ") at block starts
    // so prose scores, years, etc. are not eaten as ordered lists — which
    // would also render as "1." via the CSS counter-reset. Only the stray
    // case (multi-digit, no intentional sequence) is escaped: small numbers
    // "1." .. "9." are left alone so intentional `1. First / 2. Second`
    // lists keep working.
    const NUM_SENTINEL = '\x00NP\x00';
    const parenMarkerTexts = [];
    processed = processed.replace(
        /^( {0,3})(\d+)\.(?=[ \t]|\n|$)/gm,
        (_m, indent, n) => (n.length >= 2 ? `${indent}${n}\\.` : _m),
    );
    processed = processed.replace(
        /^( {0,3})(\d+)\)(?=[ \t]|\n|$)/gm,
        (_m, indent, n) => {
            if (n.length < 2) return _m;
            const idx = parenMarkerTexts.length;
            parenMarkerTexts.push(`${n})`);
            return `${indent}${NUM_SENTINEL}${idx}${NUM_SENTINEL}`;
        },
    );

    const htmlRaw = marked.parse(processed);
    let html = htmlRaw;
    if (parenMarkerTexts.length) {
        // Restore the ")" markers after parsing so they appear as literal text.
        // The sentinel contains null bytes and is not HTML, so it is restored
        // before DOMPurify.sanitize — it must not be passed to the sanitizer.
        for (let i = 0; i < parenMarkerTexts.length; i++) {
            html = html.split(`${NUM_SENTINEL}${i}${NUM_SENTINEL}`).join(escapeHtml(parenMarkerTexts[i]));
        }
    }
    return DOMPurify.sanitize(html, {
        RETURN_DOM: true,
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
let chunkTitles = [];       // per-chunk titles (used by collection-view sessions)
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
// The defaults rule and the entry-title convention (defaultEntryTitle) live
// in collections.js; this local mirror feeds the shared resolveDefaultCollection().
let collectionsList = {};     // collections map from storage
let collectionDefaults = { global: null, perSession: {} };

// The one shape a collection entry takes everywhere this page sends it
// (add-to menus and auto-add). Title follows the domain's convention.
function makeCollectionEntry(sessId, index, content, rawContent) {
    return {
        sessionId: sessId,
        chunkIndex: index,
        title: defaultEntryTitle({ content, rawContent, chunkIndex: index }),
        content,
        rawContent,
    };
}

async function renderCollectionSelector() {
    const sel = document.getElementById('collectionDefaultSelect');
    if (!sel) return;
    const resolved = resolveDefaultCollection(collectionDefaults, sessionId);
    // Preserve user selection while rebuilding options.
    const existingValue = sel.value;
    const frag = document.createDocumentFragment();
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = 'None';
    frag.append(noneOpt);
    for (const c of Object.values(collectionsList)) {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        if (c.id === resolved) opt.selected = true;
        frag.append(opt);
    }
    sel.replaceChildren(frag);
    // If nothing was explicitly set for this session and a global default exists, reflect it.
    if (existingValue) sel.value = existingValue;
    else if (resolved) sel.value = resolved;
}

document.getElementById('collectionDefaultSelect')?.addEventListener('change', async (e) => {
    const val = e.target.value || null;
    // Capture the prior state before mutating local mirrors so we can roll back
    // on failure: the effective default (per-session override, else global) and
    // whether a per-session entry existed at all.
    const hadOverride = Object.prototype.hasOwnProperty.call(collectionDefaults.perSession, sessionId);
    const prior = resolveDefaultCollection(collectionDefaults, sessionId);
    collectionDefaults.perSession[sessionId] = val;
    try {
        const res = await browser.runtime.sendMessage({ action: 'setCollectionSessionDefault', sessionId, value: val });
        if (res?.error) throw new Error(res.error);
    } catch (err) {
        // Restore the previous state. When the effective default came from the
        // global (no per-session entry before), delete the optimistic override
        // instead of pinning a duplicate per-session entry that would shadow
        // the global. Set the DOM directly rather than calling
        // renderCollectionSelector() — that function reads sel.value from the
        // DOM, which still holds the failed selection and would re-apply it.
        if (hadOverride) collectionDefaults.perSession[sessionId] = prior;
        else delete collectionDefaults.perSession[sessionId];
        const sel = document.getElementById('collectionDefaultSelect');
        if (sel) sel.value = prior || '';
        showToast(`❌ Failed to save session default: ${err.message}`, 'error');
    }
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
        const frag = document.createDocumentFragment();
        for (const c of colls) {
            const added = (c.entries || []).some(e => e.sessionId === sessionId && e.chunkIndex === index);
            const btn = document.createElement('button');
            btn.className = 'dropdown-item' + (added ? ' added' : '');
            btn.dataset.action = 'add';
            btn.dataset.id = c.id;
            if (added) btn.disabled = true;
            btn.textContent = (added ? '✓ ' : '') + c.name;
            frag.append(btn);
        }
        const sep = document.createElement('div');
        sep.className = 'dropdown-sep';
        frag.append(sep);
        const newBtn = document.createElement('button');
        newBtn.className = 'dropdown-item';
        newBtn.dataset.action = 'new';
        newBtn.textContent = '✨ New collection…';
        frag.append(newBtn);
        menuEl.replaceChildren(frag);
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
            entry: makeCollectionEntry(sessionId, index, content, rawContent),
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
                    ...makeCollectionEntry(sessionId, index, content, rawContent),
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
    const collId = resolveDefaultCollection(collectionDefaults, sessId);
    if (!collId) return;
    const r = processedResults[index] || {};
    const content = r.content?.text || '';
    const rawContent = r.rawContent || allChunks[index] || '';
    if (!content && !rawContent) return;
    // Skip if the resolved collection has been deleted from the in-memory cache
    // (e.g. removed in the options page while this session is still open) —
    // avoids a pointless worker round-trip and a misleading error toast.
    if (!collectionsList[collId]) return;
    try {
        const res = await browser.runtime.sendMessage({
            action: 'addEntryToCollection',
            collectionId: collId,
            entry: makeCollectionEntry(sessId, index, content, rawContent),
        });
        if (res?.error) throw new Error(res.error);
        // Update the in-memory cache so the per-chunk dropdown sees the newly
        // added entry immediately without reloading collections.
        const coll = collectionsList[collId];
        if (!res?.alreadyPresent && coll) {
            const existing = coll.entries.some(e => e.sessionId === sessId && e.chunkIndex === index);
            if (!existing) {
                coll.entries.push({
                    id: crypto.randomUUID(),
                    ...makeCollectionEntry(sessId, index, content, rawContent),
                    addedAt: Date.now(),
                });
            }
        }
        populateAddToMenu(index, document.getElementById(`chunk-addto-menu-${index}`));
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
function buildChunkCards(chunks, titles) {
    const container = document.getElementById('chunksContainer');
    container.innerHTML = '';
    titles = titles || [];
    chunks.forEach((raw, i) => {
        const card = document.createElement('div');
        card.className = 'chunk-card';
        card.id = `chunk-${i}`;
        const title = titles[i] || `Chunk ${i + 1}`;
        const header = document.createElement('div');
        header.className = 'chunk-header';
        header.id = `chunk-header-${i}`;
        const num = document.createElement('div');
        num.className = 'chunk-num';
        num.textContent = i + 1;
        const headerInfo = document.createElement('div');
        headerInfo.className = 'chunk-header-info';
        const headerTitle = document.createElement('div');
        headerTitle.className = 'chunk-header-title';
        headerTitle.textContent = title;
        const preview = document.createElement('div');
        preview.className = 'chunk-header-preview';
        preview.id = `chunk-preview-${i}`;
        preview.textContent = raw.replace(/<[^>]*>/g, '').slice(0, 80) + '…';
        headerInfo.append(headerTitle, preview);
        const badge = document.createElement('span');
        badge.className = 'chunk-status-badge status-pending';
        badge.id = `chunk-badge-${i}`;
        badge.textContent = 'Pending';
        const chevron = document.createElement('span');
        chevron.className = 'chunk-chevron';
        chevron.textContent = '▾';
        header.append(num, headerInfo, badge, chevron);
        const body = document.createElement('div');
        body.className = 'chunk-body';
        const microBar = document.createElement('div');
        microBar.className = 'chunk-micro-bar';
        const microFill = document.createElement('div');
        microFill.className = 'chunk-micro-fill';
        microFill.id = `chunk-micro-${i}`;
        microBar.append(microFill);
        const tabs = document.createElement('div');
        tabs.className = 'part-tabs';
        tabs.id = `chunk-tabs-${i}`;
        const contents = document.createElement('div');
        contents.className = 'part-contents';
        contents.id = `chunk-contents-${i}`;
        const part = document.createElement('div');
        part.className = 'part-content active';
        part.dataset.part = '0';
        const contentArea = document.createElement('div');
        contentArea.className = 'chunk-content-area';
        contentArea.id = `chunk-content-${i}`;
        const waiting = document.createElement('em');
        waiting.style.color = 'var(--text-muted)';
        waiting.textContent = 'Waiting…';
        contentArea.append(waiting);
        part.append(contentArea);
        contents.append(part);
        const actions = document.createElement('div');
        actions.className = 'chunk-actions';
        actions.id = `chunk-actions-${i}`;
        for (const [btnId, label] of [['chunk-copy', '📋 Copy'], ['chunk-copy-raw', '📄 Copy Raw'], ['chunk-reprocess', '↩ Reprocess']]) {
            const btn = document.createElement('button');
            btn.className = 'btn btn-secondary btn-sm';
            btn.id = `${btnId}-${i}`;
            btn.textContent = label;
            actions.append(btn);
        }
        const addTo = document.createElement('div');
        addTo.className = 'add-to-dropdown';
        addTo.id = `chunk-addto-${i}`;
        const addToBtn = document.createElement('button');
        addToBtn.className = 'btn btn-secondary btn-sm';
        addToBtn.id = `chunk-addto-btn-${i}`;
        addToBtn.textContent = '⊕ Add to ▾';
        const addToMenu = document.createElement('div');
        addToMenu.className = 'dropdown-menu';
        addToMenu.id = `chunk-addto-menu-${i}`;
        addTo.append(addToBtn, addToMenu);
        actions.append(addTo);
        body.append(microBar, tabs, contents, actions);
        card.append(header, body);
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

// ── Hide-on-scroll: hide header when scrolling down, reveal on scroll up ─────
function initScrollHide(hideHeader, hideFooter) {
    if (!hideHeader && !hideFooter) return;

    // Anchor scroll position for the current hide/show decision. Only when the
    // cumulative scroll from this anchor exceeds the threshold do we flip state
    // and re-anchor — preventing flicker on small scroll movements.
    let anchorY = window.scrollY;
    let ticking = false;
    const SCROLL_THRESHOLD = 120;

    window.addEventListener('scroll', () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
            const y = window.scrollY;
            const delta = y - anchorY;
            // Only act once the user has scrolled past the header height, so the
            // initial page load never triggers an immediate hide.
            if (y > 80) {
                if (delta > SCROLL_THRESHOLD) {
                    // Scrolled down enough — hide.
                    if (hideHeader) document.body.classList.add('hide-header-scroll');
                    if (hideFooter) document.body.classList.add('hide-footer-scroll');
                    anchorY = y;
                } else if (delta < -SCROLL_THRESHOLD) {
                    // Scrolled up enough — reveal.
                    if (hideHeader) document.body.classList.remove('hide-header-scroll');
                    if (hideFooter) document.body.classList.remove('hide-footer-scroll');
                    anchorY = y;
                }
            }
            ticking = false;
        });
    }, { passive: true });
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
    contentEl.replaceChildren(renderMarkdownFragment(cleanText));
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
        area.replaceChildren(renderMarkdownFragment(removeThinking(part)));
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
    const headerEl = document.createElement('div');
    headerEl.className = 'thinking-header';
    headerEl.id = `thinking-header-${index}`;
    const toggle = document.createElement('span');
    toggle.className = 'thinking-toggle';
    toggle.textContent = '▸';
    const label = document.createElement('span');
    label.className = 'thinking-label';
    label.textContent = '🤔 Thinking';
    headerEl.append(toggle, label);
    const content = document.createElement('div');
    content.className = 'thinking-content';
    content.id = `thinking-content-${index}`;
    content.textContent = thinkingContent;
    thinkingSection.append(headerEl, content);

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
// The retry/checkpoint/timeout loop lives in chunks_pipeline.js
// (runChunkAttempts); this function keeps only the per-chunk UI ceremony and
// the auto-add-to-collection step.

// Shared deps for runChunkAttempts — identical for process-all and reprocess.
function requestChunkFor(sessId, chunk, checkpointPrefix, suffix) {
    return browser.runtime.sendMessage({ action: 'processChunk', chunk, prefix: checkpointPrefix, suffix, sessionId: sessId });
}

// Render + persist a completed (non-streamed) result — used by the
// non-streaming path and the safety-timeout fallback alike. The seam's result
// shape is uniform ({ result, parts, streaming } — ADR-0007), so parts is
// always present.
async function renderAndSaveChunk(index, result) {
    const parts = result.parts;
    if (parts.length > 1) renderMultiPart(index, parts);
    else renderChunk(index, result.result, false);
    processedResults[index] = { content: { parts, text: result.result }, rawContent: allChunks[index] };
    await saveChunk(index, processedResults[index].content, allChunks[index]);
}

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

        const out = await runChunkAttempts({
            index: i,
            chunk: allChunks[i],
            pfx: prefix, sfx: suffix,
            retryCount,
            getExistingContent: () => processedResults[i]?.content?.text || null,
            isTerminated: () => _terminated,
            onAttempt: (n) => updateAttemptProgress(n, retryCount),
            requestChunk: ({ chunk, checkpointPrefix, suffix }) => requestChunkFor(sessId, chunk, checkpointPrefix, suffix),
            waitStream: waitForStreamComplete,
            renderDirect: renderAndSaveChunk,
            onFailure: async (err) => {
                console.error(`Chunk ${i} failed after ${retryCount} attempts:`, err);
                const errEl = document.getElementById(`chunk-content-${i}`);
                if (errEl) {
                    const errBox = document.createElement('div');
                    errBox.className = 'chunk-error-box';
                    errBox.textContent = '❌ ' + err.message;
                    errEl.replaceChildren(errBox);
                }
                setChunkStatus(i, 'error');
                setMicroBar(i, 'reset');
                showBanner(`Chunk ${i + 1} failed: ${err.message}`, 'error');
            },
        });

        if (_terminated) {
            // Mark current chunk as done if it has content
            if (processedResults[i]?.content?.text) {
                setChunkStatus(i, 'done'); setMicroBar(i, 'done');
                completedChunks = i + 1; updateOverallProgress(completedChunks, totalChunks);
            }
            break;
        }
        if (out.success) {
            // Auto-add so every successfully processed chunk lands in its
            // resolved default collection (streaming, timeout-fallback and
            // non-streaming paths alike).
            await autoAddProcessedChunk(i, sessId);
            setChunkStatus(i, 'done'); setMicroBar(i, 'done');
            completedChunks = i + 1; updateOverallProgress(completedChunks, totalChunks);
            updateAttemptProgress(0, retryCount);
        }
    }

    isProcessing = false; streamingIndex = -1;
    document.getElementById('terminateBtn').style.display = 'none';
    updateAttemptProgress(0, retryCount);
    const allDone = processedResults.filter(r => r?.content).length;
    if (allDone === totalChunks) showBanner(`✅ All ${totalChunks} chunks processed!`, 'success');
}

// ─── Streaming wait ───────────────────────────────────────────────────────────
// Promise-based completion instead of the old 200 ms poll over a shared flag
// map. The worker still pushes updateStreamContent messages; the message
// listener resolves the pending wait (completeStreamWait) when it sees the
// isComplete message, and a safety timer mirrors the old 5-minute timeout.
let _streamWaits = {};
// Completion latch: the worker's isComplete message can beat the pipeline's
// waitStream call (message listener and sendMessage response are separate
// macrotasks). completeStreamWait records the completion here so the next
// waitForStreamComplete consumes it instead of hanging for the timeout.
let _streamCompletions = {};

function waitForStreamComplete(index) {
    // Consume a completion that arrived before this wait was registered.
    if (_streamCompletions[index]) { delete _streamCompletions[index]; return Promise.resolve({ timedOut: false }); }
    // Self-cleaning: drop any stale wait for this index (e.g. an abandoned
    // attempt that threw before the completion message could resolve it).
    const stale = _streamWaits[index];
    if (stale) { clearTimeout(stale.timer); delete _streamWaits[index]; stale.resolve({ timedOut: true }); }
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            delete _streamWaits[index];
            delete _streamCompletions[index];
            resolve({ timedOut: true });
        }, STREAM_TIMEOUT_MS);
        _streamWaits[index] = { resolve, timer };
    });
}

// Called by the message listener when the worker's completion message arrives.
function completeStreamWait(index) {
    const w = _streamWaits[index];
    if (w) {
        clearTimeout(w.timer);
        delete _streamWaits[index];
        w.resolve({ timedOut: false });
        return;
    }
    // No waiter yet — record the completion for the imminent waitStream call.
    _streamCompletions[index] = true;
}


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
            completeStreamWait(index);
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
// Serialized read-modify-write via store.js mutate (per-key queue on
// processedChunks), so concurrent saves from two streaming sessions can't
// interleave a get→set and drop a chunk.
async function saveChunk(index, content, rawContent) {
    const sessId = getSessionId();
    if (!sessId) return;
    await mutate('processedChunks', async (processedChunks = {}) => {
        const sessChunks = processedChunks[sessId] || [];
        sessChunks[index] = { content, rawContent };
        processedChunks[sessId] = sessChunks;
        // Evict sessions beyond maxSessions, keeping only recent ids — but never
        // the session being written: a fresh session (no translationSessions row
        // yet, or pushed out of maxSessions) must not have its chunks wiped.
        // Copy before sorting — the storage snapshot is shared, never mutate it.
        const { translationSessions = [], maxSessions = 3 } = await browser.storage.local.get(['translationSessions', 'maxSessions']);
        const recentIds = [...translationSessions].sort((a, b) => b.timestamp - a.timestamp).slice(0, maxSessions).map(s => s.id);
        const kept = new Set([sessId, ...recentIds]);
        const filtered = {};
        kept.forEach(sid => { if (processedChunks[sid]) filtered[sid] = processedChunks[sid]; });
        return { changed: true, result: filtered };
    });
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
    // A reprocess is fresh user intent — clear a stale terminate flag left by
    // a previous process-all stop, or runChunkAttempts would abort before the
    // first request and the chunk would sit at "Reprocessing…" forever.
    _terminated = false;
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

    // Clear saved storage (serialized)
    await mutate('processedChunks', (processedChunks = {}) => {
        const sessChunks = processedChunks[sessId] || [];
        if (sessChunks[index]) { delete sessChunks[index]; processedChunks[sessId] = sessChunks; }
        return { changed: true, result: processedChunks };
    });

    // Clear in-memory result and UI immediately
    processedResults[index] = null;
    const contentEl = document.getElementById(`chunk-content-${index}`);
    if (contentEl) contentEl.innerHTML = '<em style="color:var(--text-muted)">Reprocessing…</em>';

    reprocessingState = { isActive: true, targetIndex: index };
    setChunkStatus(index, 'processing');
    setMicroBar(index, 'pulse');
    document.getElementById(`chunk-${index}`)?.classList.remove('collapsed');
    // A reprocess is cancellable like a stream — surface the terminate button
    // (process-all shows/hides it; reprocess-one must do the same).
    document.getElementById('terminateBtn').style.display = '';

    const out = await runChunkAttempts({
        index,
        chunk: allChunks[index],
        pfx, sfx,
        retryCount: rc,
        getExistingContent: () => processedResults[index]?.content?.text || null,
        isTerminated: () => _terminated,
        onAttempt: (n) => updateAttemptProgress(n, rc),
        requestChunk: ({ chunk, checkpointPrefix, suffix }) => requestChunkFor(sessId, chunk, checkpointPrefix, suffix),
        waitStream: waitForStreamComplete,
        renderDirect: renderAndSaveChunk,
        onFailure: async (err) => {
            console.error(`Chunk ${index} reprocess failed after ${rc} attempts:`, err);
            showToast(`❌ Reprocess failed: ${err.message}`, 'error');
            setChunkStatus(index, 'error'); setMicroBar(index, 'reset');
        },
    });

    reprocessingState.isActive = false;
    document.getElementById('terminateBtn').style.display = 'none';
    if (out.success && !out.streamed) {
        // Non-streaming + timeout-fallback render via renderAndSaveChunk; the
        // streaming path's status/toast are handled by the message listener
        // when the completion message arrived, so skip the duplicate UI here.
        setChunkStatus(index, 'done'); setMicroBar(index, 'done');
        showToast('✅ Reprocessed!', 'success');
    } else if (out.terminated) {
        // Terminated mid-reprocess — mirror mid-stream termination: keep the
        // partial content marked done when it survived, and never leave the
        // "Reprocessing…" placeholder behind. No cancellation toast; the
        // terminate button already told the user it stopped.
        if (processedResults[index]?.content?.text) {
            setChunkStatus(index, 'done'); setMicroBar(index, 'done');
            showToast('✅ Reprocessed!', 'success');
        } else {
            const el = document.getElementById(`chunk-content-${index}`);
            if (el) el.innerHTML = '';
        }
    }
}

// ─── Reprocess all ────────────────────────────────────────────────────────────
async function reprocessAll() {
    if (isProcessing) { showToast('Processing already in progress. Please wait or terminate first.', 'error'); return; }
    if (!confirm(`Reprocess all ${totalChunks} chunks? All saved results will be cleared.`)) return;
    const sessId = getSessionId();
    await mutate('processedChunks', (processedChunks = {}) => {
        delete processedChunks[sessId];
        return { changed: true, result: processedChunks };
    });
    processedResults = [];
    processedThinking = [];
    completedChunks = 0;
    _terminated = false;
    // Cancel every pending safety timer before dropping the map, so no
    // orphaned timeout fires into the void after the re-render.
    for (const w of Object.values(_streamWaits)) clearTimeout(w.timer);
    _streamWaits = {};
    _streamCompletions = {};
    buildChunkCards(allChunks, chunkTitles);
    updateOverallProgress(0, totalChunks);
    await processAllChunks(false);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
let _initStarted = false;
async function initPage() {
    // Idempotence guard: the worker's initializeChunksPage message and the
    // 500 ms fallback timer can both fire — without this, buildChunkCards and
    // processAllChunks would run twice and double-translate.
    if (_initStarted) return;
    _initStarted = true;
    cleanupImageBlobCache(); // Clear any leftover Blob URLs from previous sessions
    sessionId = getSessionId();
    document.getElementById('sessionId').textContent = sessionId ? `Session: ${sessionId.slice(0, 12)}…` : 'No session';

    if (!sessionId) { showBanner('No session ID in URL.', 'error'); return; }

    // Reconcile the theme with storage.local: ui-boot.js read the localStorage
    // mirror before first paint, but a stale or missing mirror (e.g. cleared
    // while this tab was closed) must be healed so the page matches the
    // persisted theme — applyUiTheme re-mirrors as a side effect.
    try {
        const { uiTheme } = await browser.storage.local.get('uiTheme');
        applyUiTheme(uiTheme);
    } catch (err) {
        console.warn('Failed to load UI theme:', err);
    }

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
    // Optional per-chunk titles (used by collection-view sessions to show entry titles).
    chunkTitles = Array.isArray(session?.titles) ? session.titles : [];
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

    buildChunkCards(allChunks, chunkTitles);
    updateOverallProgress(0, totalChunks);

    // Apply chunk text size and max width from settings
    const { chunkFontSize = 1, chunkMaxWidth = 0, hideHeaderOnScroll = true, hideChunkFooterOnScroll = true } = await browser.storage.local.get(['chunkFontSize', 'chunkMaxWidth', 'hideHeaderOnScroll', 'hideChunkFooterOnScroll']);
    document.documentElement.style.setProperty('--chunk-font-size', `${chunkFontSize}rem`);
    document.documentElement.style.setProperty('--chunk-max-width', chunkMaxWidth > 0 ? `${chunkMaxWidth}px` : 'none');
    initScrollHide(hideHeaderOnScroll, hideChunkFooterOnScroll);

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
        // During a reprocess, streamingIndex is -1 — the active wait belongs
        // to reprocessingState.targetIndex. Same resolution the message
        // listener uses.
        const idx = reprocessingState.isActive ? reprocessingState.targetIndex : streamingIndex; // Save before anything changes
        _terminated = true;
        if (idx >= 0) completeStreamWait(idx); // unblock the streaming wait; the loop breaks on _terminated

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

    // Live-sync: theme changed in the options page while this tab is open.
    browser.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.uiTheme) {
            applyUiTheme(changes.uiTheme.newValue);
        }
    });
});
