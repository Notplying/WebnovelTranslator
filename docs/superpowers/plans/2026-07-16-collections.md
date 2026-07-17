# Collections Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Collections feature that lets users curate translation results into named collections, auto-add finished chunks via a global/per-session default, and export collections as markdown, EPUB, or print-to-PDF HTML — managed from a new Collections section in Options.

**Architecture:** Collections live in their own `storage.local` keys (`collections`, `collectionDefaults`), independent of session data. All CRUD flows through new service-worker `runtime.onMessage` handlers. The chunks page adds a per-chunk "Add to" dropdown and a session-default selector with an auto-add checkbox. The Options page adds a Collections section with a sidebar/detail layout for CRUD, entry management, and three export formats.

**Tech Stack:** Vanilla JS (Firefox MV3 extension), `browser.storage.local`/`browser.storage.sync`, `crypto.randomUUID()`, manual STORE-compression ZIP assembly for EPUB (no external library), marked.min.js already available for markdown→HTML rendering in the HTML export.

## Global Constraints

- No new files. Touch only: `options.html`, `options.js`, `chunks.html`, `chunks.js`, `service_worker.js`, `manifest.json`.
- `collections` and `collectionDefaults` are excluded from the settings backup by default (`KEYS_TO_EXCLUDE_FROM_EXPORT`).
- A new `browser.storage.sync` key `collectionIncludeInBackup` (boolean, default `false`) gates whether collections are merged into the settings backup at export time; on import, if those keys are present they are restored.
- ID generation uses `crypto.randomUUID()` (Firefox 109+).
- EPUB uses STORE compression only (no DEFLATE); `mimetype` must be the first entry, uncompressed.
- Follow existing design-system patterns: `.card`, `.card-title`, `.field`, `.btn`/`.btn-sm`/`.btn-primary`/`.btn-secondary`/`.btn-danger`, `.toggle-row`, `.switch`, `.action-row`, `.badge`, nav items with `.icon`.
- Toast feedback for all user-facing actions: `showToast(msg, 'success')` / `showToast(msg, 'error')`.
- All service-worker storage writes use read-modify-write on `storage.local`; errors surface as toasts on the calling page.

## File Structure

| File | Responsibility |
|---|---|
| `service_worker.js` | New `runtime.onMessage` handlers: `addEntryToCollection`, `removeEntryFromCollection`, `reorderEntries`, `createCollection`, `updateCollection`, `deleteCollection`, `getCollections`, `reprocessEntry`, `getCollectionDefaults`, `setCollectionDefaults`. |
| `chunks.html` | Session default selector + auto-add checkbox in the header toolbar; CSS for the dropdown and selector. |
| `chunks.js` | Module-level collection state; `resolveDefaultCollection()`; fetch collections/defaults on init; render the header selector; per-chunk "⊕ Add to ▾" dropdown in `buildChunkCards`; auto-add hook in `processAllChunks`. |
| `options.html` | New "Collections" nav item + `<section id="section-collections">` (sidebar/detail layout, global default selector, backup toggle), plus CSS. |
| `options.js` | `renderCollectionsSection()` (sidebar + detail), CRUD wiring through SW handlers, entry management (reorder/remove/reprocess/re-import), export functions (`exportCollectionMD`, `exportCollectionEPUB`, `exportCollectionHTML`), backup-toggle integration in `loadSettings`/`saveSettings`/`exportSettings`/`importFromJSON`, and `DEFAULTS`/`KEYS_TO_EXCLUDE_FROM_EXPORT` updates. |
| `manifest.json` | Version bump. |

---

### Task 1: Service Worker — Collection Message Handlers

**Files:**
- Modify: `service_worker.js:105-155` (the `runtime.onMessage` listener block, lines 105 through the end of the listener before `// ─── Session helpers`)

**Interfaces:**
- Consumes: existing `processChunk(message)` (reused by `reprocessEntry`).
- Produces: nine new message actions that Tasks 2–6 call via `browser.runtime.sendMessage(...)`. Each handler returns `{ success, data?, error? }`.

Add the following handlers inside the `runtime.onMessage` listener, after the existing `terminateRequest` block and before the closing `});`:

```js
    // ─── Collections ────────────────────────────────────────────────────────
    if (message.action === 'getCollections') {
        browser.storage.local.get('collections').then(({ collections = {} }) =>
            sendResponse({ collections })).catch(err => sendResponse({ error: err.message }));
        return true;
    }
    if (message.action === 'createCollection') {
        const name = (message.name || '').trim();
        if (!name) { sendResponse({ error: 'Collection name is required.' }); return true; }
        const now = Date.now();
        const collection = { id: crypto.randomUUID(), name, createdAt: now, updatedAt: now, entries: [] };
        browser.storage.local.get('collections').then(({ collections = {} }) => {
            collections[collection.id] = collection;
            return browser.storage.local.set({ collections });
        }).then(() => sendResponse({ collection })).catch(err => sendResponse({ error: err.message }));
        return true;
    }
    if (message.action === 'updateCollection') {
        const { collectionId, name } = message;
        if (!collectionId || !(name || '').trim()) { sendResponse({ error: 'Invalid input.' }); return true; }
        browser.storage.local.get('collections').then(({ collections = {} }) => {
            const c = collections[collectionId]; if (!c) throw new Error('Collection not found.');
            c.name = name.trim(); c.updatedAt = Date.now();
            return browser.storage.local.set({ collections });
        }).then(() => sendResponse({ success: true })).catch(err => sendResponse({ error: err.message }));
        return true;
    }
    if (message.action === 'deleteCollection') {
        const { collectionId } = message;
        browser.storage.local.get('collections').then(({ collections = {} }) => {
            delete collections[collectionId];
            return browser.storage.local.set({ collections });
        }).then(() => sendResponse({ success: true })).catch(err => sendResponse({ error: err.message }));
        return true;
    }
    if (message.action === 'addEntryToCollection') {
        const { collectionId, entry } = message;
        if (!collectionId || !entry) { sendResponse({ error: 'Invalid input.' }); return true; }
        browser.storage.local.get('collections').then(({ collections = {} }) => {
            const c = collections[collectionId]; if (!c) throw new Error('Collection not found.');
            // Prevent duplicate entries from the same chunk.
            const exists = c.entries.some(e => e.sessionId === entry.sessionId && e.chunkIndex === entry.chunkIndex);
            if (exists) return sendResponse({ success: true, alreadyPresent: true });
            c.entries.push({ ...entry, id: crypto.randomUUID(), addedAt: Date.now() });
            c.updatedAt = Date.now();
            return browser.storage.local.set({ collections }).then(() => sendResponse({ success: true }));
        }).catch(err => sendResponse({ error: err.message }));
        return true;
    }
    if (message.action === 'removeEntryFromCollection') {
        const { collectionId, entryId } = message;
        browser.storage.local.get('collections').then(({ collections = {} }) => {
            const c = collections[collectionId]; if (!c) throw new Error('Collection not found.');
            c.entries = c.entries.filter(e => e.id !== entryId);
            c.updatedAt = Date.now();
            return browser.storage.local.set({ collections });
        }).then(() => sendResponse({ success: true })).catch(err => sendResponse({ error: err.message }));
        return true;
    }
    if (message.action === 'reorderEntries') {
        const { collectionId, fromIndex, toIndex } = message;
        browser.storage.local.get('collections').then(({ collections = {} }) => {
            const c = collections[collectionId]; if (!c) throw new Error('Collection not found.');
            const [moved] = c.entries.splice(fromIndex, 1);
            c.entries.splice(toIndex, 0, moved);
            c.updatedAt = Date.now();
            return browser.storage.local.set({ collections });
        }).then(() => sendResponse({ success: true })).catch(err => sendResponse({ error: err.message }));
        return true;
    }
    if (message.action === 'getCollectionDefaults') {
        browser.storage.local.get('collectionDefaults').then(({ collectionDefaults }) =>
            sendResponse({ defaults: collectionDefaults ?? { global: null, perSession: {} } }))
            .catch(err => sendResponse({ error: err.message }));
        return true;
    }
    if (message.action === 'setCollectionDefaults') {
        const defaults = message.defaults ?? { global: null, perSession: {} };
        browser.storage.local.set({ collectionDefaults: defaults })
            .then(() => sendResponse({ success: true }))
            .catch(err => sendResponse({ error: err.message }));
        return true;
    }
    if (message.action === 'reprocessEntry') {
        // Re-translate an entry from its rawContent using current settings.
        const { sessionId, chunkIndex, prefix, suffix, retryCount } = message;
        if (!sessionId || chunkIndex == null || !prefix) {
            sendResponse({ error: 'Invalid input.' }); return true;
        }
        processChunk({ chunk: message.rawContent, prefix, suffix, sessionId, retryCount: retryCount || 3 })
            .then(result => sendResponse({ success: true, result }))
            .catch(err => sendResponse({ error: err.message }));
        return true;
    }
```

- [ ] **Step 1: Add the handlers.** Insert the block above into `service_worker.js` inside the `runtime.onMessage` listener, immediately after the `terminateRequest` handler block (after line 155's `return true;` / before the `});` that closes the listener) and before the `// ─── Session helpers` comment.

- [ ] **Step 2: Verify the service worker loads.** Reload the extension (`about:debugging#/runtime/this` → "Reload this Extension"). Open the service worker console. Send a test message from the browser console of any tab:

```js
browser.runtime.sendMessage({ action: 'getCollections' }).then(console.log).catch(console.error);
browser.runtime.sendMessage({ action: 'getCollectionDefaults' }).then(console.log).catch(console.error);
```

Expected: `{ collections: {} }` and `{ defaults: { global: null, perSession: {} } }` — no errors.

Then create a collection:

```js
browser.runtime.sendMessage({ action: 'createCollection', name: 'Test' }).then(console.log).catch(console.error);
```

Expected: `{ collection: { id: <uuid>, name: 'Test', createdAt, updatedAt, entries: [] } }`.

- [ ] **Step 3: Commit.**

```bash
git add service_worker.js
git commit -m "feat(collections): add service-worker CRUD + defaults message handlers"
```

---

### Task 2: Chunks Page — Session Default Selector, Auto-Add Hook, Per-Chunk Dropdown

**Files:**
- Modify: `chunks.html:818-826` (header toolbar, the `.header-actions` div)
- Modify: `chunks.html:88-96` (CSS — add styles after `.header-actions`)
- Modify: `chunks.js:111-118` (module-level state declarations, after `let processedResults`)
- Modify: `chunks.js:782-800` (inside `initPage`, after `retryCount = ...` and before `if (!totalChunks)`)
- Modify: `chunks.js:176-222` (`buildChunkCards`, the action-row template + event wiring)
- Modify: `chunks.js:513-518` (inside `processAllChunks`, after the non-streaming success branch: `await saveChunk(...); success = true; break;`)
- Modify: `chunks.js:498` area (streaming-timeout success branch, after `await saveChunk(...)`)

**Interfaces:**
- Consumes: SW handlers `getCollections`, `getCollectionDefaults`, `setCollectionDefaults`, `addEntryToCollection`, `createCollection` (from Task 1).
- Produces: module-level `collectionsList`, `collectionDefaults`, `autoAddEnabled`; helper `resolveDefaultCollection(sessionId)` used by the auto-add hook and the header selector.

**Step 2a — Module-level state.** In `chunks.js`, after the existing module-level declarations (line ~118, after `let processedResults = [];`):

```js
// ─── Collections state ──────────────────────────────────────────────────────
let collectionsList = {};     // collections map from storage
let collectionDefaults = { global: null, perSession: {} };
let autoAddEnabled = false;

function resolveDefaultCollection(sessionId) {
    const per = collectionDefaults.perSession;
    if (Object.prototype.hasOwnProperty.call(per, sessionId)) return per[sessionId];
    return collectionDefaults.global ?? null;
}
```

**Step 2b — CSS.** In `chunks.html`, after the `.header-actions` block (~line 92), add:

```css
        /* ── Collection selector ─────────────────────────────────── */
        .collection-selector {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 0.78rem;
            color: var(--text-muted);
        }
        .collection-selector select {
            background: var(--surface2);
            color: var(--text);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 4px 8px;
            font-size: 0.78rem;
            font-family: inherit;
            cursor: pointer;
        }
        .collection-selector label {
            font-size: 0.78rem;
            font-weight: 500;
            color: var(--text-muted);
            cursor: pointer;
            white-space: nowrap;
        }
        /* Add-to dropdown */
        .add-to-dropdown {
            position: relative;
            display: inline-flex;
        }
        .add-to-dropdown .dropdown-menu {
            display: none;
            position: absolute;
            top: 100%;
            right: 0;
            margin-top: 4px;
            min-width: 180px;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 8px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.4);
            z-index: 100;
            padding: 4px;
        }
        .add-to-dropdown.open .dropdown-menu { display: block; }
        .add-to-dropdown .dropdown-item {
            display: block;
            width: 100%;
            text-align: left;
            background: none;
            border: none;
            padding: 6px 10px;
            border-radius: 6px;
            font-size: 0.78rem;
            font-family: inherit;
            color: var(--text);
            cursor: pointer;
            white-space: nowrap;
        }
        .add-to-dropdown .dropdown-item:hover { background: var(--surface2); }
        .add-to-dropdown .dropdown-item.added { color: var(--success); cursor: default; }
        .add-to-dropdown .dropdown-sep {
            height: 1px;
            background: var(--border);
            margin: 4px 2px;
        }
```

**Step 2c — Header selector.** In `chunks.html`, inside `.header-actions` (~line 825, before the `terminateBtn`), add:

```html
            <div class="collection-selector">
                <label for="collectionDefaultSelect">Collection:</label>
                <select id="collectionDefaultSelect" aria-label="Default collection for this session">
                    <option value="">None</option>
                </select>
                <label><input type="checkbox" id="collectionAutoAdd"> Auto-add</label>
            </div>
```

**Step 2d — Init wiring.** In `chunks.js` `initPage()`, after `retryCount = session?.retryCount || storedData.retryCount || 3;` and before `if (!totalChunks)`, add:

```js
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
```

Add the `renderCollectionSelector` helper near `resolveDefaultCollection`:

```js
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
    collectionDefaults.perSession[sessionId] = val;
    try {
        await browser.runtime.sendMessage({ action: 'setCollectionDefaults', defaults: collectionDefaults });
    } catch (err) { console.error('[collections] setDefaults failed:', err); }
});

document.getElementById('collectionAutoAdd')?.addEventListener('change', (e) => {
    autoAddEnabled = e.target.checked;
});
```

**Step 2e — Auto-add hook.** In `processAllChunks`, in BOTH success branches (the streaming-timeout branch ~line 498-500 and the non-streaming branch ~line 513), after `await saveChunk(i, processedResults[i].content, allChunks[i]);`, add:

```js
                // Auto-add to the resolved default collection.
                if (autoAddEnabled) {
                    const collId = resolveDefaultCollection(sessId);
                    if (collId) {
                        const r = processedResults[i] || {};
                        try {
                            const res = await browser.runtime.sendMessage({
                                action: 'addEntryToCollection',
                                collectionId: collId,
                                entry: {
                                    sessionId: sessId,
                                    chunkIndex: i,
                                    title: `Chunk ${i + 1}`,
                                    content: r.content?.text || '',
                                    rawContent: r.rawContent || allChunks[i] || '',
                                },
                            });
                            if (res?.error) throw new Error(res.error);
                        } catch (err) {
                            showToast(`❌ Failed to add chunk ${i + 1} to collection: ${err.message}`, 'error');
                        }
                    }
                }
```

**Step 2f — Per-chunk "Add to" dropdown.** In `buildChunkCards` (~line 176), add the dropdown button to the `.chunk-actions` template, after the existing three buttons:

```html
          <div class="add-to-dropdown" id="chunk-addto-${i}">
            <button class="btn btn-secondary btn-sm" id="chunk-addto-btn-${i}">⊕ Add to ▾</button>
            <div class="dropdown-menu" id="chunk-addto-menu-${i}"></div>
          </div>
```

And wire up the toggle + populate. After the existing action-button wiring in `buildChunkCards` (after the `chunk-reprocess-${i}` listener), add:

```js
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
            // Close when clicking outside the card.
            document.addEventListener('click', function closeAddTo(e) {
                if (!addEl.contains(e.target)) {
                    addEl.classList.remove('open');
                    document.removeEventListener('click', closeAddTo);
                }
            });
        }
```

Add the `populateAddToMenu` helper (near `resolveDefaultCollection`):

```js
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
        document.querySelectorAll('[id^="chunk-addto-menu-"]').forEach(m => populateAddToMenu(index, m));
        await addChunkToCollection(index, collection.id);
    } catch (err) {
        showToast(`❌ Failed to create collection: ${err.message}`, 'error');
    }
}
```

- [ ] **Step 1: Apply steps 2a–2f** to `chunks.html` and `chunks.js` as described.

- [ ] **Step 2: Verify.** Reload the extension. Open a translation session (the chunks page). Confirm:
  - The header shows "Collection: [None ▾] Auto-add ☐".
  - After creating a collection via Options → Collections (Task 4) or via the "New collection…" menu, the dropdown lists it.
  - Clicking a collection in a chunk's "⊕ Add to ▾" menu shows a toast "✅ Added to …".
  - Clicking the same collection again shows "ℹ️ Already in this collection."
  - The "Auto-add" checkbox, when checked, causes finished chunks to be added (verify in Options → Collections that the entry appears).

- [ ] **Step 3: Commit.**

```bash
git add chunks.html chunks.js
git commit -m "feat(collections): add chunks-page selector, auto-add hook, per-chunk dropdown"
```

---

### Task 3: Options Page — Collections Section HTML, CSS, and Nav

**Files:**
- Modify: `options.html:683` (insert nav item before the `nav-label` "API Providers" line, i.e. after the fewshot nav-item block at line ~683)
- Modify: `options.html:857` (insert `<section id="section-collections">` before the `<section id="section-gemini">` block, i.e. before line 860)
- Modify: `options.html:653` area (CSS — add collection styles before `.badge` or in an appropriate place)

**Interfaces:**
- Consumes: existing `.card`, `.field`, `.btn`, `.toggle-row`, `.switch`, `.badge`, `.action-row`, nav-item patterns.
- Produces: DOM nodes that Task 4's `renderCollectionsSection()` populates: `#collectionGlobalDefault`, `#collectionIncludeInBackup`, `#collectionNewBtn`, `#collectionList`, `#collectionDetail`.

**Step 3a — Nav item.** In `options.html`, after the fewshot nav-item (`</button>` closing the fewshot nav, ~line 683) and before `<div class="nav-label">API Providers</div>`, insert:

```html
      <button class="nav-item" data-section="collections" id="nav-collections">
        <span class="icon">📚</span><span>Collections</span>
      </button>
```

**Step 3b — CSS.** In `options.html`, add the following styles. Place them after the `.badge` rules (~line 670) or anywhere within the `<style>` block:

```css
    /* ── Collections layout ─────────────────────────────────── */
    .collections-layout {
      display: grid;
      grid-template-columns: 260px 1fr;
      gap: 20px;
      align-items: start;
    }
    .collections-sidebar {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .collection-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 420px;
      overflow-y: auto;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 4px;
      background: var(--bg);
    }
    .collection-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 6px;
      cursor: pointer;
      transition: background var(--transition);
      border: none;
      background: none;
      width: 100%;
      text-align: left;
      font-family: inherit;
      color: var(--text);
      font-size: 0.82rem;
    }
    .collection-item:hover { background: var(--surface2); }
    .collection-item.active { background: var(--accent-glow); color: var(--accent); }
    .collection-item-info { flex: 1; min-width: 0; }
    .collection-item-name {
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .collection-item-meta {
      font-size: 0.72rem;
      color: var(--text-muted);
      margin-top: 2px;
    }
    .collection-item.active .collection-item-meta { color: var(--accent); opacity: 0.7; }
    .collection-item-actions {
      display: flex;
      gap: 2px;
      opacity: 0;
      transition: opacity var(--transition);
    }
    .collection-item:hover .collection-item-actions { opacity: 1; }
    .collection-item-action-btn {
      background: none;
      border: none;
      cursor: pointer;
      padding: 3px 5px;
      border-radius: 4px;
      font-size: 0.85rem;
      color: var(--text-muted);
      transition: background var(--transition), color var(--transition);
    }
    .collection-item-action-btn:hover { background: var(--surface); color: var(--text); }
    .collection-item-action-btn.delete:hover { color: var(--danger); background: rgba(248,113,113,0.15); }

    .collections-detail {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
      background: var(--surface);
      min-height: 300px;
    }
    .collection-empty {
      text-align: center;
      color: var(--text-muted);
      padding: 48px 16px;
      font-size: 0.85rem;
    }
    .collection-header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .collection-header-row h2 {
      font-size: 1rem;
      font-weight: 600;
      margin: 0;
    }
    .collection-entries {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 420px;
      overflow-y: auto;
    }
    .collection-entry {
      display: grid;
      grid-template-columns: 28px 1fr auto;
      gap: 8px;
      align-items: start;
      padding: 10px 12px;
      border-radius: 6px;
      background: var(--bg);
      border: 1px solid var(--border);
    }
    .collection-entry-title {
      font-weight: 600;
      font-size: 0.82rem;
      cursor: text;
    }
    .collection-entry-title[contenteditable="true"]:focus {
      outline: 2px solid var(--accent);
      border-radius: 4px;
      padding: 0 4px;
      margin: 0 -4px;
    }
    .collection-entry-meta {
      font-size: 0.72rem;
      color: var(--text-muted);
      margin-top: 2px;
    }
    .collection-entry-actions {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
    }
    @media (max-width: 700px) {
      .collections-layout { grid-template-columns: 1fr; }
      .collection-list { max-height: 200px; }
    }
```

**Step 3c — Section markup.** In `options.html`, before `<section class="section" id="section-gemini">` (~line 860), insert:

```html
    <!-- ── Collections ─────────────────────────────────-------- -->
    <section class="section" id="section-collections">
      <div class="page-header">
        <h1>Collections</h1>
        <p>Curate translation results into named collections and export them as markdown, EPUB, or print-to-PDF HTML.</p>
      </div>

      <div class="card">
        <div class="card-title">⚙️ Defaults</div>
        <div class="field">
          <label for="collectionGlobalDefault">Default collection</label>
          <select id="collectionGlobalDefault">
            <option value="">None</option>
          </select>
          <small>Applied to every session unless overridden on the chunks page.</small>
        </div>
        <div class="toggle-row">
          <div class="toggle-row-info">
            <label for="collectionIncludeInBackup">Include collections in Settings backup/export</label>
            <small>Collections will be merged into the settings backup when enabled.</small>
          </div>
          <label class="switch"><input type="checkbox" id="collectionIncludeInBackup" aria-labelledby="collectionIncludeInBackup-label"><span class="slider"></span></label>
        </div>
      </div>

      <div class="card">
        <div class="card-title">📚 Collections</div>
        <div class="collections-layout">
          <div class="collections-sidebar">
            <button class="btn btn-primary btn-sm" id="collectionNewBtn">➕ New collection</button>
            <div id="collectionList" class="collection-list">
              <div class="collection-empty" style="padding:24px 12px">No collections yet. Add chunks from the translation page, or create one here.</div>
            </div>
          </div>
          <div class="collections-detail" id="collectionDetail">
            <div class="collection-empty">Select a collection or create a new one.</div>
          </div>
        </div>
      </div>
    </section>
```

- [ ] **Step 1: Apply steps 3a–3c** to `options.html`.

- [ ] **Step 2: Verify.** Reload the extension. Open Options. Confirm:
  - A "Collections" nav item (📚) appears between Few-Shot Examples and API Providers.
  - Clicking it shows the Collections section with the Defaults card and the Collections card (sidebar + empty detail panel).
  - The "Default collection" dropdown shows only "None" (no collections exist yet).
  - The layout is responsive (single column under 700px).

- [ ] **Step 3: Commit.**

```bash
git add options.html
git commit -m "feat(collections): add Collections nav item, section markup, and CSS"
```

---

### Task 4: Options Page — renderCollectionsSection, CRUD, and Entry Management

**Files:**
- Modify: `options.js:33-36` (`DEFAULTS` — add `collectionIncludeInBackup`)
- Modify: `options.js:38` (`KEYS_TO_EXCLUDE_FROM_EXPORT` — add `collections`, `collectionDefaults`)
- Modify: `options.js:48-56` (`setupNav` — add collections nav activation)
- Modify: `options.js:82-96` (`loadSettings` — load `collectionIncludeInBackup`)
- Modify: `options.js:137-200` (`saveSettings` — save `collectionIncludeInBackup`)
- Modify: `options.js:280-300` (`exportSettings` — merge collections when toggle on)
- Modify: `options.js:308` (`ALLOWED_IMPORT_KEYS` — add `collections`, `collectionDefaults`, `collectionIncludeInBackup`)
- Modify: `options.js:315-335` (`importFromJSON` — restore collections keys when present)
- Modify: `options.js:402+` (`document.addEventListener('DOMContentLoaded', ...)` — wire export/import/clear buttons for collections; add `renderCollectionsSection` and helpers)

**Interfaces:**
- Consumes: SW handlers from Task 1; DOM from Task 3.
- Produces: `renderCollectionsSection()` (called by nav activation and after every mutation); `exportCollectionMD`, `exportCollectionEPUB`, `exportCollectionHTML` (Task 5); `collectionIncludeInBackup` persisted to sync storage.

**Step 4a — Defaults + exclusions.** In `options.js`:

In `DEFAULTS` (~line 33), add:
```js
  collectionIncludeInBackup: false,
```

In `KEYS_TO_EXCLUDE_FROM_EXPORT` (~line 38), change to:
```js
const KEYS_TO_EXCLUDE_FROM_EXPORT = ['processedChunks', 'translationSessions', 'fewShotExamples', 'collections', 'collectionDefaults'];
```

**Step 4b — Nav activation.** In `setupNav()` (~line 48), inside the click handler, extend the `if (btn.dataset.section === 'fewshot')` block to also handle collections:

```js
      if (btn.dataset.section === 'fewshot') {
        renderFewShotCustomList();
        renderFewShotAutoCount();
      }
      if (btn.dataset.section === 'collections') {
        renderCollectionsSection();
      }
```

**Step 4c — Load/Save the backup toggle.** In `loadSettings()` (~line 96, in the `.forEach` key list), add `'collectionIncludeInBackup'` to the list of keys. In `saveSettings()` (~line 197, in the `raw = { ... }` object), add `collectionIncludeInBackup: getField('collectionIncludeInBackup'),`.

**Step 4d — Export merge.** In `exportSettings()` (~line 280), after computing `filtered`, add:

```js
  // Optionally merge collections into the backup.
  try {
    const include = getField('collectionIncludeInBackup');
    if (include) {
      const { collections, collectionDefaults } = await browser.storage.local.get(['collections', 'collectionDefaults']);
      if (collections) filtered.collections = collections;
      if (collectionDefaults) filtered.collectionDefaults = collectionDefaults;
    }
  } catch (_) { /* best-effort */ }
```

**Step 4e — Import restore.** In `importFromJSON()`, after `await browser.storage.local.set(sanitizeNumericSettings(whitelisted));` and before `await loadSettings();`, add:

```js
    // Restore collections if present in the import.
    const collKeys = ['collections', 'collectionDefaults', 'collectionIncludeInBackup'];
    const collData = {};
    for (const k of collKeys) {
      if (Object.prototype.hasOwnProperty.call(data, k)) collData[k] = data[k];
    }
    if (Object.keys(collData).length) await browser.storage.local.set(collData);
```

Note: `ALLOWED_IMPORT_KEYS` is used to build the whitelist in `importFromJSON`. Since `importFromJSON` now reads `collections`/`collectionDefaults`/`collectionIncludeInBackup` directly from `data` (not via the whitelist loop), no change to `ALLOWED_IMPORT_KEYS` is strictly required. But to keep the whitelist honest, add them:

```js
const ALLOWED_IMPORT_KEYS = [...Object.keys(DEFAULTS), 'fewShotCustomExamples', 'collections', 'collectionDefaults', 'collectionIncludeInBackup'];
```

**Step 4f — renderCollectionsSection and helpers.** Add the following functions to `options.js` (place them after `clearFewShotCustom` / before `exportSettings`, ~line 278):

```js
// ─── Collections ─────────────────────────────────────────────────────────────
let _selectedCollectionId = null;

async function renderCollectionsSection() {
  let collectionsMap = {};
  let defaults = { global: null, perSession: {} };
  let includeInBackup = false;
  try {
    const [colls, defs, stored] = await Promise.all([
      browser.runtime.sendMessage({ action: 'getCollections' }),
      browser.runtime.sendMessage({ action: 'getCollectionDefaults' }),
      browser.storage.sync.get('collectionIncludeInBackup'),
    ]);
    collectionsMap = colls?.collections ?? {};
    defaults = defs?.defaults ?? { global: null, perSession: {} };
    includeInBackup = !!stored?.collectionIncludeInBackup;
  } catch (err) {
    console.error('[collections] load failed:', err);
    showToast('❌ Failed to load collections.', 'error');
  }

  // Global default selector.
  const globalSel = document.getElementById('collectionGlobalDefault');
  if (globalSel) {
    const cur = globalSel.value;
    globalSel.innerHTML = '<option value="">None</option>' +
      Object.values(collectionsMap).map(c =>
        `<option value="${escapeHtml(c.id)}"${c.id === defaults.global ? ' selected' : ''}>${escapeHtml(c.name)}</option>`
      ).join('');
    if (cur && collectionsMap[cur]) globalSel.value = cur;
    else if (defaults.global) globalSel.value = defaults.global;
    globalSel.onchange = null;
    globalSel.addEventListener('change', async (e) => {
      defaults.global = e.target.value || null;
      try {
        await browser.runtime.sendMessage({ action: 'setCollectionDefaults', defaults });
      } catch (err) { showToast('❌ Failed to save default.', 'error'); }
    }, { once: false });
  }

  // Backup toggle.
  const cb = document.getElementById('collectionIncludeInBackup');
  if (cb) { cb.checked = includeInBackup; }

  // Sidebar list.
  const list = document.getElementById('collectionList');
  if (list) {
    const colls = Object.values(collectionsMap);
    if (colls.length === 0) {
      list.innerHTML = '<div class="collection-empty" style="padding:24px 12px">No collections yet. Add chunks from the translation page, or create one here.</div>';
    } else {
      list.innerHTML = colls.map(c => {
        const count = (c.entries || []).length;
        const updated = c.updatedAt ? new Date(c.updatedAt).toLocaleDateString() : '';
        const active = c.id === _selectedCollectionId ? ' active' : '';
        return `<div class="collection-item${active}" data-id="${escapeHtml(c.id)}">
          <div class="collection-item-info">
            <div class="collection-item-name">${escapeHtml(c.name)}</div>
            <div class="collection-item-meta">${count} entr${count === 1 ? 'y' : 'ies'}${updated ? ' · ' + updated : ''}</div>
          </div>
          <div class="collection-item-actions">
            <button class="collection-item-action-btn" data-action="rename" data-id="${escapeHtml(c.id)}" aria-label="Rename" title="Rename">✏️</button>
            <button class="collection-item-action-btn delete" data-action="delete" data-id="${escapeHtml(c.id)}" aria-label="Delete" title="Delete">🗑</button>
          </div>
        </div>`;
      }).join('');
      // Click to select.
      list.querySelectorAll('.collection-item').forEach(item => {
        item.addEventListener('click', (e) => {
          if (e.target.closest('.collection-item-action-btn')) return;
          _selectedCollectionId = item.dataset.id;
          renderCollectionsSection();
        });
      });
      // Action buttons.
      list.querySelectorAll('.collection-item-action-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = btn.dataset.id;
          if (btn.dataset.action === 'rename') {
            const coll = collectionsMap[id];
            const name = prompt('Collection name:', coll?.name);
            if (!name || !name.trim()) return;
            await browser.runtime.sendMessage({ action: 'updateCollection', collectionId: id, name: name.trim() });
            showToast('✏️ Collection renamed.', 'success');
          } else if (btn.dataset.action === 'delete') {
            if (!confirm('Delete this collection? This cannot be undone.')) return;
            await browser.runtime.sendMessage({ action: 'deleteCollection', collectionId: id });
            if (_selectedCollectionId === id) _selectedCollectionId = null;
            showToast('🗑 Collection deleted.', 'success');
          }
          renderCollectionsSection();
        });
      });
    }
  }

  // Detail panel.
  renderCollectionDetail(collectionsMap);
}

function renderCollectionDetail(collectionsMap) {
  const detail = document.getElementById('collectionDetail');
  if (!detail) return;
  const coll = _selectedCollectionId ? collectionsMap[_selectedCollectionId] : null;
  if (!coll) {
    detail.innerHTML = '<div class="collection-empty">Select a collection or create a new one.</div>';
    return;
  }
  const entries = coll.entries || [];
  detail.innerHTML = `
    <div class="collection-header-row">
      <h2>${escapeHtml(coll.name)}</h2>
      <div class="action-row">
        <div class="add-to-dropdown" id="collectionExportDropdown">
          <button class="btn btn-secondary btn-sm" id="collectionExportBtn">Export ▾</button>
          <div class="dropdown-menu" style="min-width:160px">
            <button class="dropdown-item" data-format="md">📄 Export .md</button>
            <button class="dropdown-item" data-format="epub">📖 Export .epub</button>
            <button class="dropdown-item" data-format="html">🖨 Export .html (→ PDF)</button>
          </div>
        </div>
        <button class="btn btn-danger btn-sm" id="collectionDeleteBtn">🗑 Delete collection</button>
      </div>
    </div>
    <p style="font-size:0.78rem;color:var(--text-muted);margin-bottom:12px">${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}</p>
    <div class="action-row" style="margin-bottom:12px">
      <button class="btn btn-secondary btn-sm" id="collectionRemoveAllBtn">🗑 Remove all</button>
      <button class="btn btn-secondary btn-sm" id="collectionReprocessAllBtn">↩ Re-process all</button>
    </div>
    <div class="collection-entries" id="collectionEntries">${entries.length === 0 ? '<div class="collection-empty" style="padding:24px 12px">No entries yet.</div>' : ''}</div>`;

  if (entries.length > 0) {
    const entriesEl = document.getElementById('collectionEntries');
    entriesEl.innerHTML = entries.map((e, idx) => {
      const added = e.addedAt ? new Date(e.addedAt).toLocaleString() : '';
      const source = `Session ${((e.sessionId || '').slice(0, 8))} · Chunk ${e.chunkIndex + 1}`;
      return `<div class="collection-entry" data-index="${idx}">
        <div style="display:flex;flex-direction:column;gap:2px;align-items:center;padding-top:2px">
          <button class="collection-item-action-btn reorder-up" data-idx="${idx}" aria-label="Move up" title="Move up" ${idx === 0 ? 'disabled style="opacity:0.3;cursor:default"' : ''}>▲</button>
          <button class="collection-item-action-btn reorder-down" data-idx="${idx}" aria-label="Move down" title="Move down" ${idx === entries.length - 1 ? 'disabled style="opacity:0.3;cursor:default"' : ''}>▼</button>
        </div>
        <div>
          <div class="collection-entry-title" contenteditable="true" data-entry-id="${escapeHtml(e.id)}" title="Click to edit title">${escapeHtml(e.title || `Chunk ${e.chunkIndex + 1}`)}</div>
          <div class="collection-entry-meta">${escapeHtml(source)} · Added ${escapeHtml(added)}</div>
        </div>
        <div class="collection-entry-actions">
          <button class="btn btn-secondary btn-sm entry-reimport" data-entry-id="${escapeHtml(e.id)}" title="Re-import to session">↩ Re-import</button>
          <button class="btn btn-secondary btn-sm entry-reprocess" data-entry-id="${escapeHtml(e.id)}" title="Re-translate from raw">↩ Re-process</button>
          <button class="btn btn-danger btn-sm entry-remove" data-entry-id="${escapeHtml(e.id)}">🗑 Remove</button>
        </div>
      </div>`;
    }).join('');

    // Title edit (blur → save).
    entriesEl.querySelectorAll('[contenteditable="true"]').forEach(el => {
      el.addEventListener('blur', async () => {
        const entryId = el.dataset.entryId;
        const coll = collectionsMap[_selectedCollectionId];
        const entry = coll?.entries?.find(e => e.id === entryId);
        if (!entry) return;
        entry.title = el.textContent.trim() || `Chunk ${entry.chunkIndex + 1}`;
        el.textContent = entry.title;
        try {
          await browser.runtime.sendMessage({ action: 'updateCollection', collectionId: _selectedCollectionId, name: coll.name });
          // updateCollection only updates name; we need to persist entries too.
          // Use a dedicated path: write the whole collection back.
          await browser.storage.local.get('collections').then(({ collections = {} }) => {
            collections[_selectedCollectionId].entries = coll.entries;
            collections[_selectedCollectionId].updatedAt = Date.now();
            return browser.storage.local.set({ collections });
          });
        } catch (err) { showToast('❌ Failed to save title.', 'error'); }
      });
    });

    // Reorder.
    entriesEl.querySelectorAll('.reorder-up, .reorder-down').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.dataset.idx);
        const to = btn.classList.contains('reorder-up') ? idx - 1 : idx + 1;
        try {
          await browser.runtime.sendMessage({ action: 'reorderEntries', collectionId: _selectedCollectionId, fromIndex: idx, toIndex: to });
          renderCollectionsSection();
        } catch (err) { showToast('❌ Failed to reorder.', 'error'); }
      });
    });

    // Remove entry.
    entriesEl.querySelectorAll('.entry-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await browser.runtime.sendMessage({ action: 'removeEntryFromCollection', collectionId: _selectedCollectionId, entryId: btn.dataset.entryId });
          renderCollectionsSection();
          showToast('🗑 Entry removed.', 'success');
        } catch (err) { showToast('❌ Failed to remove entry.', 'error'); }
      });
    });

    // Re-import to session.
    entriesEl.querySelectorAll('.entry-reimport').forEach(btn => {
      btn.addEventListener('click', async () => {
        const entry = entries.find(e => e.id === btn.dataset.entryId);
        if (!entry) return;
        try {
          const { processedChunks = {} } = await browser.storage.local.get('processedChunks');
          const sess = processedChunks[entry.sessionId] || [];
          sess[entry.chunkIndex] = { content: { parts: [entry.content], text: entry.content }, rawContent: entry.rawContent };
          processedChunks[entry.sessionId] = sess;
          await browser.storage.local.set({ processedChunks });
          showToast('✅ Re-imported to session.', 'success');
        } catch (err) { showToast('❌ Re-import failed.', 'error'); }
      });
    });

    // Re-process entry (re-translate from raw).
    entriesEl.querySelectorAll('.entry-reprocess').forEach(btn => {
      btn.addEventListener('click', async () => {
        const entry = entries.find(e => e.id === btn.dataset.entryId);
        if (!entry) return;
        const btnEl = btn;
        btnEl.disabled = true;
        btnEl.textContent = '⏳ …';
        try {
          const { prefix, suffix, retryCount } = await browser.storage.local.get(['prefix', 'suffix', 'retryCount']);
          const res = await browser.runtime.sendMessage({
            action: 'reprocessEntry',
            sessionId: entry.sessionId,
            chunkIndex: entry.chunkIndex,
            prefix: prefix || '',
            suffix: suffix || '',
            retryCount: retryCount || 3,
            rawContent: entry.rawContent,
          });
          if (res?.error) throw new Error(res.error);
          const result = res.result;
          const parts = result.parts || [result.result];
          // Update the entry's content in the collection.
          const coll = collectionsMap[_selectedCollectionId];
          const e2 = coll?.entries?.find(e => e.id === entry.id);
          if (e2) {
            e2.content = Array.isArray(parts) ? parts.join('') : (result.result || '');
            await browser.storage.local.get('collections').then(({ collections = {} }) => {
              collections[_selectedCollectionId].entries = coll.entries;
              collections[_selectedCollectionId].updatedAt = Date.now();
              return browser.storage.local.set({ collections });
            });
          }
          showToast('✅ Re-processed.', 'success');
        } catch (err) { showToast('❌ Re-process failed: ' + err.message, 'error'); }
        btnEl.disabled = false;
        btnEl.textContent = '↩ Re-process';
        renderCollectionsSection();
      });
    });
  }

  // Export dropdown.
  const exportBtn = document.getElementById('collectionExportBtn');
  const exportDrop = document.getElementById('collectionExportDropdown');
  if (exportBtn && exportDrop) {
    exportBtn.addEventListener('click', (e) => { e.stopPropagation(); exportDrop.classList.toggle('open'); });
    document.addEventListener('click', function closeExport(e) {
      if (exportDrop && !exportDrop.contains(e.target)) { exportDrop.classList.remove('open'); document.removeEventListener('click', closeExport); }
    });
    exportDrop.querySelectorAll('.dropdown-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        exportDrop.classList.remove('open');
        const fmt = item.dataset.format;
        if (fmt === 'md') exportCollectionMD(coll);
        else if (fmt === 'epub') exportCollectionEPUB(coll);
        else if (fmt === 'html') exportCollectionHTML(coll);
      });
    });
  }

  // Delete collection.
  document.getElementById('collectionDeleteBtn')?.addEventListener('click', async () => {
    if (!confirm('Delete this collection? This cannot be undone.')) return;
    try {
      await browser.runtime.sendMessage({ action: 'deleteCollection', collectionId: _selectedCollectionId });
      _selectedCollectionId = null;
      renderCollectionsSection();
      showToast('🗑 Collection deleted.', 'success');
    } catch (err) { showToast('❌ Failed to delete collection.', 'error'); }
  });

  // Remove all.
  document.getElementById('collectionRemoveAllBtn')?.addEventListener('click', async () => {
    if (!confirm('Remove all entries from this collection?')) return;
    try {
      const { collections = {} } = await browser.storage.local.get('collections');
      if (collections[_selectedCollectionId]) {
        collections[_selectedCollectionId].entries = [];
        collections[_selectedCollectionId].updatedAt = Date.now();
        await browser.storage.local.set({ collections });
        renderCollectionsSection();
        showToast('🗑 All entries removed.', 'success');
      }
    } catch (err) { showToast('❌ Failed to remove entries.', 'error'); }
  });

  // Re-process all.
  document.getElementById('collectionReprocessAllBtn')?.addEventListener('click', async () => {
    if (!confirm('Re-translate all entries from raw content?')) return;
    const { prefix, suffix, retryCount } = await browser.storage.local.get(['prefix', 'suffix', 'retryCount']);
    const btnEl = document.getElementById('collectionReprocessAllBtn');
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = '⏳ Processing…'; }
    let ok = 0, fail = 0;
    for (const entry of entries) {
      try {
        const res = await browser.runtime.sendMessage({
          action: 'reprocessEntry',
          sessionId: entry.sessionId,
          chunkIndex: entry.chunkIndex,
          prefix: prefix || '',
          suffix: suffix || '',
          retryCount: retryCount || 3,
          rawContent: entry.rawContent,
        });
        if (res?.error) throw new Error(res.error);
        const parts = res.result.parts || [res.result.result];
        const coll = collectionsMap[_selectedCollectionId];
        const e2 = coll?.entries?.find(e => e.id === entry.id);
        if (e2) e2.content = Array.isArray(parts) ? parts.join('') : (res.result.result || '');
        await browser.storage.local.get('collections').then(({ collections = {} }) => {
          collections[_selectedCollectionId].entries = coll.entries;
          collections[_selectedCollectionId].updatedAt = Date.now();
          return browser.storage.local.set({ collections });
        });
        ok++;
      } catch (err) { fail++; console.error(err); }
    }
    renderCollectionsSection();
    showToast(`✅ Re-processed: ${ok} ok, ${fail} failed.`, fail ? 'error' : 'success');
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = '↩ Re-process all'; }
  });
}

// ─── New collection (sidebar button) ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('collectionNewBtn')?.addEventListener('click', async () => {
    const name = prompt('Collection name:');
    if (!name || !name.trim()) return;
    try {
      const { collection } = await browser.runtime.sendMessage({ action: 'createCollection', name: name.trim() });
      if (!collection) throw new Error('Failed to create collection.');
      showToast('✅ Collection created.', 'success');
      renderCollectionsSection();
    } catch (err) { showToast('❌ Failed to create collection.', 'error'); }
  });
});
```

Wait — the `DOMContentLoaded` block already exists at the bottom of options.js (~line 378). I must not create a second one. The `collectionNewBtn` listener should be added inside the existing `DOMContentLoaded` handler. Let me adjust: instead of a separate `document.addEventListener('DOMContentLoaded', ...)`, register the `collectionNewBtn` listener inside the existing handler. I'll note this in the step.

**Step 4g — Wire the New button into the existing DOMContentLoaded.** In the existing `document.addEventListener('DOMContentLoaded', ...)` handler (~line 378), add after the `exportButton`/`importButton` wiring:

```js
  // Collections — new collection button.
  document.getElementById('collectionNewBtn')?.addEventListener('click', async () => {
    const name = prompt('Collection name:');
    if (!name || !name.trim()) return;
    try {
      const { collection } = await browser.runtime.sendMessage({ action: 'createCollection', name: name.trim() });
      if (!collection) throw new Error('Failed to create collection.');
      showToast('✅ Collection created.', 'success');
      renderCollectionsSection();
    } catch (err) { showToast('❌ Failed to create collection.', 'error'); }
  });
```

- [ ] **Step 1: Apply steps 4a–4g** to `options.js`. Remember: the "New collection" listener goes inside the *existing* `DOMContentLoaded` handler, not a new one.

- [ ] **Step 2: Verify.** Reload the extension. Open Options → Collections. Confirm:
  - **Create:** "➕ New collection" prompts for a name and creates it; it appears in the sidebar.
  - **Select:** Clicking a collection opens its detail panel with header, export button, and entry list.
  - **Rename/Delete:** Hover reveals ✏️/🗑; rename prompts; delete confirms.
  - **Global default:** The dropdown in the Defaults card lists collections; selecting one persists.
  - **Backup toggle:** Checkbox state persists across reloads.
  - **Entries:** After adding a chunk from the chunks page (Task 2), the entry appears with title, source label, reorder arrows, re-import, re-process, remove.
  - **Reorder:** ▲/▼ move entries.
  - **Title edit:** Click title, edit, blur → saved.
  - **Bulk:** "Remove all" clears entries; "Re-process all" re-translates (requires an API key configured).

- [ ] **Step 3: Commit.**

```bash
git add options.js
git commit -m "feat(collections): wire CRUD, entry management, and backup-toggle integration"
```

---

### Task 5: Options Page — Export Functions (MD, EPUB, HTML)

**Files:**
- Modify: `options.js` — add `exportCollectionMD`, `exportCollectionEPUB`, `exportCollectionHTML` after `renderCollectionDetail` (end of Task 4's block).

**Interfaces:**
- Consumes: `collectionsMap` / `coll` passed as argument; `marked` (global from marked.min.js, available on the options page? Check — marked.min.js is loaded in chunks.html but NOT options.html). 

Note: `marked.min.js` is listed in `web_accessible_resources` and loaded in chunks.html, but **not** in options.html. The HTML export needs markdown→HTML rendering. Two options: (a) load `marked.min.js` in options.html, or (b) render the HTML export with plain text (no markdown processing). The spec says "styled HTML with print-friendly CSS (page breaks between entries, readable typography)." It does not require markdown rendering. To avoid adding a script dependency, the HTML export will render entry content as preformatted text (preserving markdown source), with a note. However, the EPUB export renders each entry as XHTML — also plain text wrapped in `<p>` tags.

To keep scope tight and avoid pulling in marked, both exports treat content as plain text (whitespace-preserved). This is acceptable: the markdown export is literal markdown; the HTML/EPUB exports preserve the markdown source as readable text.

**Step 5a — Add the three export functions.** Place them after `renderCollectionDetail` (end of Task 4's block), before the `// ─── New collection` comment:

```js
// ─── Collection exports ──────────────────────────────────────────────────────
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function exportCollectionMD(collection) {
  if (!collection || !(collection.entries || []).length) { showToast('Nothing to export.', 'error'); return; }
  const parts = collection.entries.map(e =>
    `# ${e.title || `Chunk ${e.chunkIndex + 1}`}\n\n${e.content || ''}`
  );
  const md = parts.join('\n\n---\n\n');
  downloadBlob(new Blob([md], { type: 'text/markdown;charset=utf-8' }),
    `${(collection.name || 'collection').replace(/[^a-z0-9]/gi, '_')}.md`);
  showToast('📄 Markdown exported!', 'success');
}

function exportCollectionHTML(collection) {
  if (!collection || !(collection.entries || []).length) { showToast('Nothing to export.', 'error'); return; }
  const safeName = (collection.name || 'collection').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const entriesHtml = collection.entries.map(e => {
    const title = (e.title || `Chunk ${e.chunkIndex + 1}`).replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const body = (e.content || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<article class="entry">
  <h1 class="entry-title">${title}</h1>
  <div class="entry-body">${body.replace(/\n/g, '<br>\n')}</div>
</article>`;
  }).join('\n\n<hr class="entry-sep">\n\n');
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${safeName}</title>
<style>
  @page { margin: 2cm; }
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 11pt; line-height: 1.6; max-width: 42em; margin: 0 auto; padding: 2em 1.5em; color: #1a1a1a; }
  h1 { font-size: 14pt; font-weight: 600; margin: 0 0 0.4em; page-break-after: avoid; }
  .entry-body { margin-top: 0.6em; }
  hr.entry-sep { border: none; border-top: 1px solid #ddd; margin: 2.5em 0; page-break-before: always; }
  .meta { font-size: 8pt; color: #888; margin-bottom: 1.5em; }
</style>
</head>
<body>
<h1 style="text-align:center;margin-bottom:1.5em;page-break-after:always">${safeName}</h1>

${entriesHtml}
</body></html>`;
  downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }),
    `${(collection.name || 'collection').replace(/[^a-z0-9]/gi, '_')}.html`);
  showToast('🖨 HTML exported — open and Print → Save as PDF.', 'success');
}

// ── Minimal STORE-compression ZIP builder for EPUB ───────────────────────────
function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function u16(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; }
function u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }

function zipLocalHeader(name, data) {
  const nameBytes = new TextEncoder().encode(name);
  const crc = crc32(data);
  const h = new Uint8Array(30 + nameBytes.length);
  const v = new DataView(h.buffer);
  v.setUint32(0, 0x04034b50, true);   // local file header signature
  v.setUint16(4, 10, true);            // version needed
  v.setUint16(6, 0, true);             // gp flag
  v.setUint16(8, 0, true);             // compression: STORE
  v.setUint16(10, 0, true);            // mod time
  v.setUint16(12, 0, true);            // mod date
  v.setUint32(14, crc, true);          // crc32
  v.setUint32(18, data.length, true);  // compressed size
  v.setUint32(22, data.length, true);  // uncompressed size
  v.setUint16(26, nameBytes.length, true);
  v.setUint16(28, 0, true);            // extra length
  h.set(nameBytes, 30);
  return { header: h, data, nameBytes, crc, size: data.length };
}

function zipCentralEntry(name, info, offset) {
  const h = new Uint8Array(46 + info.nameBytes.length);
  const v = new DataView(h.buffer);
  v.setUint32(0, 0x02014b50, true);    // central dir signature
  v.setUint16(4, 20, true);            // version made by
  v.setUint16(6, 10, true);            // version needed
  v.setUint16(8, 0, true);             // gp flag
  v.setUint16(10, 0, true);            // compression STORE
  v.setUint16(12, 0, true); v.setUint16(14, 0, true);
  v.setUint32(16, info.crc, true);
  v.setUint32(20, info.size, true);
  v.setUint32(24, info.size, true);
  v.setUint16(28, info.nameBytes.length, true);
  v.setUint16(30, 0, true);            // extra len
  v.setUint16(32, 0, true);            // comment len
  v.setUint16(34, 0, true);            // disk start
  v.setUint16(36, 0, true);            // internal attr
  v.setUint32(38, 0, true);            // external attr
  v.setUint32(42, offset, true);       // local header offset
  h.set(info.nameBytes, 46);
  return h;
}

function buildStoreZip(files) {
  // files: [{name: string, data: Uint8Array}]. mimetype MUST be first.
  const locals = [];
  let offset = 0;
  for (const f of files) {
    const info = zipLocalHeader(f.name, f.data);
    locals.push({ offset, info });
    offset += 30 + info.nameBytes.length + info.data.length;
  }
  const cdEntries = locals.map(l => zipCentralEntry(l.info.nameBytes, l.info, l.offset));
  const cdSize = cdEntries.reduce((s, e) => s + e.length, 0);
  const cdOffset = locals.length ? locals[locals.length - 1].offset + 30 + locals[locals.length - 1].info.nameBytes.length + locals[locals.length - 1].info.data.length : 0;

  const parts = [];
  for (const l of locals) parts.push(l.info.header, l.info.data);
  for (const e of cdEntries) parts.push(e);
  // EOCD
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, locals.length, true);
  ev.setUint16(10, locals.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);
  ev.setUint16(20, 0, true);
  parts.push(eocd);

  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function exportCollectionEPUB(collection) {
  if (!collection || !(collection.entries || []).length) { showToast('Nothing to export.', 'error'); return; }
  const safeName = escapeXml(collection.name || 'Collection');
  const now = new Date().toISOString().slice(0, 19) + 'Z';
  const uid = crypto.randomUUID();
  const entries = collection.entries;

  // Files (mimetype MUST be first, uncompressed).
  const files = [];
  files.push({ name: 'mimetype', data: new TextEncoder().encode('application/epub+zip') });

  const chapterNames = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const title = escapeXml(e.title || `Chunk ${e.chunkIndex + 1}`);
    const body = escapeXml(e.content || '');
    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${title}</title></head>
<body><h1>${title}</h1>
<div>${body.replace(/\n/g, '<br/>\n')}</div>
</body></html>`;
    const fname = `chapter-${i + 1}.xhtml`;
    chapterNames.push(fname);
    files.push({ name: fname, data: new TextEncoder().encode(xhtml) });
  }

  // content.opf
  const manifestItems = chapterNames.map((fn, i) =>
    `    <item id="chapter${i + 1}" href="${fn}" media-type="application/xhtml+xml"/>\n`).join('');
  const spineItems = chapterNames.map((_, i) =>
    `    <itemref idref="chapter${i + 1}"/>\n`).join('');
  const navItem = `    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n`;
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:${uid}</dc:identifier>
    <dc:title>${safeName}</dc:title>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${now}</meta>
  </metadata>
  <manifest>
${manifestItems}    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine>
${spineItems}  </spine>
</package>`;
  files.push({ name: 'content.opf', data: new TextEncoder().encode(opf) });

  // toc.ncx
  const ncxNavPoints = entries.map((e, i) => `    <navPoint id="navPoint-${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${escapeXml(e.title || `Chunk ${e.chunkIndex + 1}`)}</text></navLabel>
      <content src="${chapterNames[i]}"/>
    </navPoint>`).join('\n');
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:${uid}"/></head>
  <docTitle><text>${safeName}</text></docTitle>
  <navMap>
${ncxNavPoints}
  </navMap>
</ncx>`;
  files.push({ name: 'META-INF/container.xml', data: new TextEncoder().encode(`<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n  <rootfiles>\n    <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>\n  </rootfiles>\n</container>`) });
  files.push({ name: 'toc.ncx', data: new TextEncoder().encode(ncx) });

  // Simple navigation document (EPUB3 requires it).
  const navHtmlItems = entries.map((e, i) =>
    `      <li><a href="${chapterNames[i]}">${escapeXml(e.title || `Chunk ${e.chunkIndex + 1}`)}</a></li>`).join('\n');
  const navXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${safeName}</title></head>
<body>
<nav epub:type="toc">
  <h1>Table of Contents</h1>
  <ol>
${navHtmlItems}
  </ol>
</nav>
</body></html>`;
  files.push({ name: 'nav.xhtml', data: new TextEncoder().encode(navXhtml) });

  const zip = buildStoreZip(files);
  downloadBlob(new Blob([zip], { type: 'application/epub+zip' }),
    `${(collection.name || 'collection').replace(/[^a-z0-9]/gi, '_')}.epub`);
  showToast('📖 EPUB exported!', 'success');
}
```

- [ ] **Step 1: Apply step 5a** to `options.js`.

- [ ] **Step 2: Verify.** In Options → Collections, with a collection that has entries:
  - **Export .md:** Downloads a `.md` file. Open it — each entry is `# Title` followed by content, separated by `---`.
  - **Export .epub:** Downloads a `.epub`. Verify it opens (e.g. in a browser or EPUB reader) and has a TOC with one chapter per entry. Also verify the ZIP is valid: `unzip -l file.epub` should list `mimetype` first (uncompressed) plus `META-INF/container.xml`, `content.opf`, `toc.ncx`, `nav.xhtml`, `chapter-N.xhtml`.
  - **Export .html:** Downloads an `.html`. Open in browser — entries render with page breaks; "Print → Save as PDF" produces a PDF.
  - Empty collection: clicking any export shows "Nothing to export." toast.

- [ ] **Step 3: Commit.**

```bash
git add options.js
git commit -m "feat(collections): add MD, EPUB, and HTML export functions"
```

---

### Task 6: manifest.json Version Bump

**Files:**
- Modify: `manifest.json:4` (`"version"`)

Bump the version to reflect the new feature.

- [ ] **Step 1:** In `manifest.json`, change `"version": "3.0.14"` to `"version": "3.0.15"`.

- [ ] **Step 2: Verify.** `cat manifest.json | grep version` → `"version": "3.0.15"`. Reload the extension in `about:debugging` and confirm the version shown in Options matches.

- [ ] **Step 3: Commit.**

```bash
git add manifest.json
git commit -m "chore: bump version to 3.0.15 (Collections feature)"
```

---

## Self-Review

**Spec coverage check:**
- §3 Data model (`collections`, `collectionDefaults`, `collectionIncludeInBackup` sync key, key exclusions, `crypto.randomUUID()`) — Task 1 (SW handlers), Task 4 (defaults + exclusions + toggle). ✓
- §4a Per-chunk "Add to Collection" dropdown + "New collection…" + duplicate skip + toast — Task 2 (steps 2f, `populateAddToMenu`, `addChunkToCollection`, `newCollectionAndAdd`). ✓
- §4b Session default selector + auto-add checkbox + per-session write — Task 2 (steps 2c, 2d, `renderCollectionSelector`). ✓
- §4c Auto-add hook in translation loop (awaited, toast on failure) — Task 2 (step 2e, both success branches). ✓
- §5a Sidebar collection list (new, rename, delete, hover actions, empty state) — Task 4 (`renderCollectionsSection` sidebar). ✓
- §5b Detail panel (editable name, entry list with title edit/source/added, reorder/remove/reprocess, re-import, bulk remove all/reprocess all) — Task 4 (`renderCollectionDetail`). ✓
- §5c Exports (MD with `# title` + `---`, EPUB STORE ZIP with mimetype-first + TOC, HTML print-to-PDF) — Task 5. ✓
- §5d Global default selector + backup toggle — Task 3 (HTML) + Task 4 (render + persist). ✓
- §6 SW handlers (all 10 actions) — Task 1. ✓
- §7 Implementation scope (no new files; options.js render/export; chunks.js init/selector/dropdown; EPUB in options page) — all tasks. ✓
- §8 Error handling (toasts on SW failure, export abort, reprocess error state) — Tasks 1, 2, 4, 5. ✓

**Placeholder scan:** No TBD/TODO/"implement later"/"add appropriate error handling" patterns remain. All steps include actual code.

**Type consistency:** Function names (`renderCollectionsSection`, `renderCollectionDetail`, `resolveDefaultCollection`, `populateAddToMenu`, `addChunkToCollection`, `newCollectionAndAdd`, `exportCollectionMD`, `exportCollectionEPUB`, `exportCollectionHTML`, `downloadBlob`, `buildStoreZip`, `crc32`) are consistent across tasks. SW action names match between Task 1 handlers and Task 2/4 callers. The `reprocessEntry` handler in Task 1 accepts `rawContent` (passed by Tasks 4/5 callers); `processChunk` receives `{ chunk: message.rawContent, ... }`. ✓

No gaps found.
