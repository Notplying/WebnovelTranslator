// collections.js — collection domain: model rules + serialized mutations.
// Shared by the service worker (applies mutations), chunks page (default
// resolution) and options page (management UI). Loaded AFTER store.js — the
// mutations persist through store.mutate so concurrent edits from any context
// serialize on the 'collections' / 'collectionDefaults' keys.
//
// Why: the domain used to live in three places — mutations in the worker, the
// per-session-overrides-global rule in chunks.js, render/export in options.js —
// so the defaults rule was re-spelled in four spots and could drift (a failed
// default save restored '' over a global default). One module owns the shape.
//
// Top-level functions are browser globals; the module.exports block at the
// bottom enables Node testing (Node-only; inert in the browser).

// ─── Model rules (pure) ────────────────────────────────────────────────────────
// A session's default collection: its per-session override if present,
// otherwise the global default, otherwise null.
function resolveDefaultCollection(collectionDefaults, sessionId) {
    // Tolerate partial shapes (e.g. freshly-imported defaults missing
    // perSession) — treat a missing map as empty before the lookup.
    const per = collectionDefaults.perSession || {};
    if (Object.prototype.hasOwnProperty.call(per, sessionId)) return per[sessionId];
    return collectionDefaults.global ?? null;
}

// Default entry title convention, shared by every page that renders an entry
// (chunks add-to-collection, options list/export). Stored title wins; else the
// first non-empty line of the translation, falling back to the raw source;
// else the legacy "Chunk N" label for entries added before the convention.
function defaultEntryTitle(entry) {
    if (entry && entry.title) return entry.title;
    const firstLine = String(entry.content || '').split(/\r?\n/).find(line => line.trim())
        || String(entry.rawContent || '').split(/\r?\n/).find(line => line.trim())
        || '';
    const trimmed = firstLine.trim();
    // Cap the title length so a single long line doesn't break the UI.
    return trimmed ? (trimmed.length > 120 ? trimmed.slice(0, 120) + '…' : trimmed) : `Chunk ${(entry.chunkIndex ?? 0) + 1}`;
}

// ─── Serialized mutations ───────────────────────────────────────────────────────
// Wraps store.mutate for the collections key; mutators return the store's
// { changed, note } contract. The updatedAt stamp is part of the write policy,
// so it lives here, not at call sites.

async function mutateCollection(collectionId, mutator) {
    return mutate('collections', async (collections = {}) => {
        const c = collections[collectionId];
        if (!c) throw new Error('Collection not found.');
        const outcome = await mutator(c);
        // Outcome: { changed: false, note } (skip write) or { changed: true } (write).
        if (outcome && outcome.changed === true) {
            c.updatedAt = Date.now();
            return { changed: true, result: collections };
        }
        return { changed: false, note: outcome && outcome.note };
    });
}

async function storeHasCollection(id) {
    const { collections = {} } = await browser.storage.local.get('collections');
    return !!collections[id];
}

// ─── Collections CRUD ───────────────────────────────────────────────────────────

async function getCollections() {
    const { collections = {} } = await browser.storage.local.get('collections');
    return { collections };
}

async function createCollection(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) throw new Error('Collection name is required.');
    const now = Date.now();
    const collection = { id: crypto.randomUUID(), name: trimmed, createdAt: now, updatedAt: now, entries: [] };
    // Serialized so a concurrent addEntryToCollection or deleteCollection can't
    // read a stale snapshot and clobber this write.
    await mutate('collections', (collections = {}) => {
        collections[collection.id] = collection;
        return { changed: true, result: collections };
    });
    return { collection };
}

async function updateCollectionName(collectionId, name) {
    const trimmed = (name || '').trim();
    if (!collectionId || !trimmed) throw new Error('Invalid input.');
    await mutate('collections', (collections = {}) => {
        const c = collections[collectionId]; if (!c) throw new Error('Collection not found.');
        c.name = trimmed; c.updatedAt = Date.now();
        return { changed: true, result: collections };
    });
    return { success: true };
}

async function deleteCollection(collectionId) {
    if (!collectionId) throw new Error('Invalid input.');
    // Delete the collection, then clean up defaults referencing it. Two
    // serialized writes; the defaults cleanup is idempotent, so the small
    // window between them is safe against a concurrent create.
    await Promise.all([
        mutate('collections', (collections = {}) => {
            delete collections[collectionId];
            return { changed: true, result: collections };
        }),
        mutate('collectionDefaults', (collectionDefaults = { global: null, perSession: {} }) => {
            // Clear any default that referenced the deleted collection so we don't point at nothing.
            if (collectionDefaults.global === collectionId) collectionDefaults.global = null;
            for (const sid of Object.keys(collectionDefaults.perSession)) {
                if (collectionDefaults.perSession[sid] === collectionId) delete collectionDefaults.perSession[sid];
            }
            return { changed: true, result: collectionDefaults };
        })
    ]);
    return { success: true };
}

// ─── Entry mutations ────────────────────────────────────────────────────────────

async function addEntryToCollection(collectionId, entry) {
    if (!collectionId || !entry) throw new Error('Invalid input.');
    // Validate the entry before persisting: require a non-empty sessionId and a non-negative integer chunkIndex.
    if (!entry.sessionId || !Number.isInteger(entry.chunkIndex) || entry.chunkIndex < 0) throw new Error('Invalid input.');
    const { note } = await mutateCollection(collectionId, c => {
        // Prevent duplicate entries from the same chunk.
        const exists = c.entries.some(e => e.sessionId === entry.sessionId && e.chunkIndex === entry.chunkIndex);
        if (exists) return { changed: false, note: 'alreadyPresent' };
        c.entries.push({ ...entry, id: crypto.randomUUID(), addedAt: Date.now() });
        return { changed: true };
    });
    return { success: true, alreadyPresent: note === 'alreadyPresent' };
}

async function removeEntryFromCollection(collectionId, entryId) {
    if (!collectionId || !entryId) throw new Error('Invalid input.');
    await mutateCollection(collectionId, c => {
        const idx = c.entries.findIndex(e => e.id === entryId);
        if (idx === -1) throw new Error('Entry not found.');
        c.entries.splice(idx, 1);
        return { changed: true };
    });
    return { success: true };
}

// Bulk remove: one serialized write for a list of entry ids, so the deletion is
// atomic and stamps a single updatedAt. Lenient on unknown ids (the UI sends a
// rendered snapshot) — only the listed ids that exist are removed.
async function removeEntriesFromCollection(collectionId, entryIds) {
    if (!collectionId || !Array.isArray(entryIds) || entryIds.some(id => typeof id !== 'string' || !id)) throw new Error('Invalid input.');
    // Nothing selected — run the mutator only to validate the collection
    // exists (changed: false skips the write, so no updatedAt stamp), so a
    // ghost collection errors the same whether or not anything is selected.
    if (entryIds.length === 0) {
        await mutateCollection(collectionId, () => ({ changed: false, note: 'empty' }));
        return { success: true, removed: 0 };
    }
    const ids = new Set(entryIds); // dedupe before the filter
    let removed = 0;
    await mutateCollection(collectionId, c => {
        const before = c.entries.length;
        c.entries = c.entries.filter(e => !ids.has(e.id));
        removed = before - c.entries.length;
        return removed > 0 ? { changed: true } : { changed: false, note: 'notFound' };
    });
    return { success: true, removed };
}

// Update a single entry's title — routed through the serialized mutation path.
async function updateEntryTitle(collectionId, entryId, title) {
    if (!collectionId || !entryId || title == null) throw new Error('Invalid input.');
    await mutateCollection(collectionId, c => {
        const entry = c.entries.find(e => e.id === entryId);
        if (!entry) throw new Error('Entry not found.');
        entry.title = title;
        return { changed: true };
    });
    return { success: true };
}

// Update a single entry's translated content (e.g. after re-processing) — serialized.
async function updateEntryContent(collectionId, entryId, content) {
    if (!collectionId || !entryId || content == null) throw new Error('Invalid input.');
    await mutateCollection(collectionId, c => {
        const entry = c.entries.find(e => e.id === entryId);
        if (!entry) throw new Error('Entry not found.');
        entry.content = content;
        return { changed: true };
    });
    return { success: true };
}

// Clear all entries in a collection — serialized.
async function clearCollectionEntries(collectionId) {
    if (!collectionId) throw new Error('Invalid input.');
    await mutateCollection(collectionId, c => { c.entries = []; return { changed: true }; });
    return { success: true };
}

async function reorderEntries(collectionId, fromIndex, toIndex) {
    if (!collectionId || fromIndex == null || toIndex == null) throw new Error('Invalid input.');
    await mutateCollection(collectionId, c => {
        // Validate the original indices are already integers within bounds before mutating.
        if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex < 0 || fromIndex >= c.entries.length || toIndex < 0 || toIndex >= c.entries.length) {
            throw new Error('Invalid fromIndex or toIndex.');
        }
        const [moved] = c.entries.splice(fromIndex, 1);
        c.entries.splice(toIndex, 0, moved);
        return { changed: true };
    });
    return { success: true };
}

// ─── Defaults ───────────────────────────────────────────────────────────────────

async function getCollectionDefaults() {
    const { collectionDefaults } = await browser.storage.local.get('collectionDefaults');
    // Normalize partial persisted shapes: preserve existing values while
    // supplying null / {} fallbacks for the missing halves.
    const d = collectionDefaults ?? {};
    return { defaults: { global: d.global ?? null, perSession: d.perSession ?? {} } };
}

// Merge-based: updates only the global default, preserving per-session overrides.
async function setCollectionGlobalDefault(value) {
    const v = value ?? null;
    await mutate('collectionDefaults', async (collectionDefaults = { global: null, perSession: {} }) => {
        // Null/empty clears the default; any referenced collection must actually
        // exist. Read the collections key inside the same serialized mutation so
        // a concurrent deleteCollection cannot slip between the check and the
        // write (deleteCollection's defaults cleanup runs on this same key chain).
        if (v !== null && v !== undefined && v !== '') {
            const { collections = {} } = await browser.storage.local.get('collections');
            if (!collections[v]) throw new Error('Invalid collection reference.');
        }
        collectionDefaults.global = v;
        return { changed: true, result: collectionDefaults };
    });
    return { success: true };
}

// Merge-based: updates only one session's override, preserving global + other sessions.
async function setCollectionSessionDefault(sessionId, value) {
    if (!sessionId) throw new Error('sessionId is required.');
    await mutate('collectionDefaults', async (collectionDefaults = { global: null, perSession: {} }) => {
        // Null/empty clears the override; any referenced collection must actually
        // exist — validated inside the serialized mutation (see above).
        if (value !== null && value !== undefined && value !== '') {
            const { collections = {} } = await browser.storage.local.get('collections');
            if (!collections[value]) throw new Error('Invalid collection reference.');
        }
        if (value === null || value === undefined || value === '') delete collectionDefaults.perSession[sessionId];
        else collectionDefaults.perSession[sessionId] = value;
        return { changed: true, result: collectionDefaults };
    });
    return { success: true };
}

// ─── Node test seam (fewshot.js/settings.js pattern; inert in the browser) ─────
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        defaultEntryTitle,
        resolveDefaultCollection,
        getCollections,
        createCollection,
        updateCollectionName,
        deleteCollection,
        addEntryToCollection,
        removeEntryFromCollection,
        removeEntriesFromCollection,
        updateEntryTitle,
        updateEntryContent,
        clearCollectionEntries,
        reorderEntries,
        getCollectionDefaults,
        setCollectionGlobalDefault,
        setCollectionSessionDefault
    };
}
