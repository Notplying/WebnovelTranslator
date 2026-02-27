// chunks.js — Chunks page logic for AI Webnovel Translator v3
// Uses browser-polyfill, marked.js, DOMPurify

// ─── Marked config ────────────────────────────────────────────────────────────
if (typeof marked !== 'undefined') {
    marked.use({ breaks: true, gfm: true });
    // Disable strikethrough
    const origLexer = marked.Lexer;
    marked.setOptions({ pedantic: false, mangle: false, headerIds: false });
    // Disable hyperlinks — render as plaintext [text](url)
    marked.use({
        useNewRenderer: true,
        renderer: {
            link(token) { return token.raw; }
        }
    });
}

function renderMarkdown(text) {
    if (typeof marked === 'undefined') return `<p>${escapeHtml(text)}</p>`;
    const html = marked.parse(text || '');
    return DOMPurify.sanitize(html, {
        ADD_ATTR: ['target', 'data-original-src', 'style'],
        FORBID_TAGS: ['style', 'script']
    });
}

function escapeHtml(t) {
    return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
let streamingIndex = -1;
let reprocessingState = { isActive: false, targetIndex: -1 };
let _terminated = false;

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

function renderChunk(index, text, isStreaming = false) {
    const contentEl = document.getElementById(`chunk-content-${index}`);
    if (!contentEl) return;
    contentEl.classList.toggle('streaming', isStreaming);
    contentEl.innerHTML = renderMarkdown(text);
    handleImages(contentEl);
}

function renderMultiPart(index, parts) {
    const tabsEl = document.getElementById(`chunk-tabs-${index}`);
    const contentsEl = document.getElementById(`chunk-contents-${index}`);
    if (!tabsEl || !contentsEl) return;
    tabsEl.innerHTML = '';
    contentsEl.innerHTML = '';
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
        area.innerHTML = renderMarkdown(part);
        handleImages(area);
        content.appendChild(area);
        contentsEl.appendChild(content);
    });
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

        if (src.match(/\.file(\?.*)?$/i)) {
            img.dataset.originalSrc = src;

            if (imageBlobCache.has(src)) {
                img.src = imageBlobCache.get(src);
            } else {
                const loadingSvg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='50'%3E%3Ctext x='50' y='25' dominant-baseline='middle' text-anchor='middle' font-family='sans-serif' font-size='12' fill='%23888'%3ELoading...%3C/text%3E%3C/svg%3E";
                img.src = loadingSvg;
                imageBlobCache.set(src, loadingSvg);

                fetch(src)
                    .then(res => {
                        if (!res.ok) throw new Error(`HTTP ${res.status}`);
                        return res.blob();
                    })
                    .then(blob => {
                        const pngBlob = new Blob([blob], { type: 'image/png' });
                        const objUrl = URL.createObjectURL(pngBlob);
                        imageBlobCache.set(src, objUrl);
                        document.querySelectorAll(`img[data-original-src="${src.replace(/"/g, '\\"')}"]`).forEach(targetImg => {
                            targetImg.src = objUrl;
                        });
                    })
                    .catch(err => {
                        console.error('Failed to convert .file image:', err);
                        imageBlobCache.delete(src);
                        document.querySelectorAll(`img[data-original-src="${src.replace(/"/g, '\\"')}"]`).forEach(targetImg => {
                            targetImg.src = src;
                        });
                    });
            }
        } else if (src) {
            img.src = src;
        }

        img.addEventListener('click', () => {
            const openSrc = img.dataset.originalSrc || img.src;
            if (openSrc && !openSrc.startsWith('data:image/svg+xml')) {
                window.open(openSrc, '_blank');
            }
        });

        img.addEventListener('error', () => {
            if (img.src && img.src.startsWith('data:image/svg+xml')) return;
            const fallback = document.createElement('div');
            fallback.style.cssText = 'background:rgba(255,255,255,0.05);border:1px dashed rgba(255,255,255,0.1);border-radius:6px;padding:12px;font-size:0.75rem;color:var(--text-muted);text-align:center';
            fallback.textContent = '📷 Image failed to load';
            img.replaceWith(fallback);
        });
    });
}

// ─── Process all chunks sequentially ─────────────────────────────────────────
async function processAllChunks(resume = false) {
    const sessId = getSessionId();
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
            updateAttemptProgress(attempt + 1, retryCount);
            try {
                const result = await browser.runtime.sendMessage({
                    action: 'processChunk',
                    chunk: allChunks[i],
                    prefix, suffix,
                    sessionId: sessId
                });

                if (_terminated) break;
                if (result.error) throw new Error(result.error);

                if (result.streaming) {
                    // Streaming updates come via message listener; wait for them
                    await waitForStreamComplete(i);
                    if (_terminated) { success = !!processedResults[i]?.content?.text; break; }
                    success = true; break;
                }

                // Non-streaming
                const parts = result.parts || [result.result];
                if (parts.length > 1) renderMultiPart(i, parts);
                else renderChunk(i, result.result, false);

                processedResults[i] = { content: { parts, text: result.result }, rawContent: allChunks[i] };
                await saveChunk(i, processedResults[i].content, allChunks[i]);
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
            if (!isStreamingActive(index)) { clearInterval(check); resolve(); }
        }, 200);
        // Safety timeout 5 min
        setTimeout(() => { clearInterval(check); resolve(); }, 300000);
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
            renderChunk(index, msg.content, !msg.isComplete);
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
    const text = parts.join('\n');
    try {
        await navigator.clipboard.writeText(text);
        showToast('📄 Copied raw (with prefix/suffix)!', 'success');
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
    if (isProcessing && streamingIndex !== index) { showToast('Wait for current chunk to finish.', 'error'); return; }
    const sessId = getSessionId();
    const storedData = await browser.runtime.sendMessage({ action: 'getStoredData' });
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
        updateAttemptProgress(attempt + 1, rc);
        try {
            const result = await browser.runtime.sendMessage({ action: 'processChunk', chunk: allChunks[index], prefix: pfx, suffix: sfx, sessionId: sessId });
            if (result.error) throw new Error(result.error);
            if (result.streaming) { await waitForStreamComplete(index); return; }
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
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

// ─── Reprocess all ────────────────────────────────────────────────────────────
async function reprocessAll() {
    if (!confirm(`Reprocess all ${totalChunks} chunks? All saved results will be cleared.`)) return;
    const sessId = getSessionId();
    const { processedChunks = {} } = await browser.storage.local.get('processedChunks');
    delete processedChunks[sessId];
    await browser.storage.local.set({ processedChunks });
    processedResults = [];
    completedChunks = 0;
    _terminated = false;
    _streamCompleteFlags = {};
    buildChunkCards(allChunks);
    updateOverallProgress(0, totalChunks);
    await processAllChunks(false);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function initPage() {
    sessionId = getSessionId();
    document.getElementById('sessionId').textContent = sessionId ? `Session: ${sessionId.slice(0, 12)}…` : 'No session';

    if (!sessionId) { showBanner('No session ID in URL.', 'error'); return; }

    // Load session data
    const { translationSessions = [] } = await browser.storage.local.get('translationSessions');
    const session = translationSessions.find(s => s.id === sessionId);

    let storedData = await browser.runtime.sendMessage({ action: 'getStoredData' });
    allChunks = session?.chunks || storedData.chunks || [];
    prefix = session?.prefix || storedData.prefix || '';
    suffix = session?.suffix || storedData.suffix || '';
    retryCount = session?.retryCount || storedData.retryCount || 3;
    totalChunks = allChunks.length;

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
    document.getElementById('reprocessAllBtn')?.addEventListener('click', reprocessAll);
    document.getElementById('copyAllBtn')?.addEventListener('click', copyAll);
    document.getElementById('downloadAllBtn')?.addEventListener('click', downloadAll);
    document.getElementById('terminateBtn')?.addEventListener('click', async () => {
        const idx = streamingIndex; // Save before anything changes
        _terminated = true;
        if (idx >= 0) _streamCompleteFlags[idx] = true;

        try { await browser.runtime.sendMessage({ action: 'terminateRequest', sessionId: getSessionId() }); } catch (e) { }

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
