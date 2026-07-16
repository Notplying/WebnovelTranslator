# Collections Feature — Design Spec
**Date:** 2026-07-16
**Status:** Draft

---

## 1. Overview

A **Collections** feature lets users curate translation results into named collections, set a default collection (global and per-session) so finished chunks auto-add, and export a collection as markdown, EPUB, or print-to-PDF HTML. A new **Collections** section in the Options page provides full CRUD over collections and their entries.

The feature lives entirely within the existing chunks/translation flow — no new operating mode. It is additive: when no default is set and no collection is chosen, behaviour is unchanged.

---

## 2. Core Concepts

### Collections
A collection is a named, ordered list of translation entries. It persists independently of translation sessions, so curated results survive session eviction.

### Entries
Each entry is a **snapshot** of one chunk's translation at the moment it was added:
- `content` (translated markdown) and `rawContent` (original text) are copied in.
- `sessionId` and `chunkIndex` are stored as metadata for labelling, re-processing, and re-importing.
- `title` defaults to `Chunk {N+1}` but is editable.

### Defaults
Two levels of default determine where auto-add sends a chunk:
1. **Per-session override** (`collectionDefaults.perSession[sessionId]`) — set on the chunks page.
2. **Global default** (`collectionDefaults.global`) — set in Options → Collections.

Resolution order: per-session override → global default → none. Either level can be explicitly "none" (null).

---

## 3. Data Model & Storage

Two new `browser.storage.local` keys, independent of `processedChunks` and `translationSessions`:

```js
collections: {
  "<uuid>": {
    id: "<uuid>",
    name: "<string>",
    createdAt: <epoch-ms>,
    updatedAt: <epoch-ms>,
    entries: [
      {
        id: "<uuid>",
        sessionId: "<string>",
        chunkIndex: <number>,
        title: "<string>",
        content: "<markdown>",
        rawContent: "<raw>",
        addedAt: <epoch-ms>,
      }
    ]
  }
}

collectionDefaults: {
  global: "<uuid>" | null,
  perSession: { "<sessionId>": "<uuid>" | null }
}
```

A new `browser.storage.sync` key `collectionIncludeInBackup` (boolean, default `false`) controls whether `collections` and `collectionDefaults` are included in the existing Settings backup/export.

**Storage key exclusions:** `collections` and `collectionDefaults` are added to `KEYS_TO_EXCLUDE_FROM_EXPORT` so they are excluded from the settings backup by default. When `collectionIncludeInBackup` is true, `exportSettings()` merges them in at export time.

**ID generation:** `crypto.randomUUID()` (Firefox 109+).

---

## 4. Chunks Page

### 4a. Per-Chunk "Add to Collection"

Each chunk card's action row gains a dropdown button **⊕ Add to ▾** listing all collections by name, plus **New collection…**.

- Clicking a collection appends the chunk's processed result (or raw content if not yet translated) to that collection, snapshotting title + content.
- If the chunk is already in the chosen collection (same `sessionId` + `chunkIndex`), the option shows a checkmark / "Already added" and is skipped.
- "New collection…" opens a prompt for a name, creates the collection via the service worker, then adds the entry.
- Toast confirmation: "Added to {name}".

### 4b. Session Default Selector

In the chunks page header (next to the existing Download/Copy buttons), a new control:

```
Collection: [None ▾]   [☐ Auto-add every finished chunk]
```

- Dropdown lists all collections + "None". Changing it writes `collectionDefaults.perSession[sessionId]`.
- The checkbox toggles whether the resolved default is active. When on, every chunk that finishes translating is automatically appended to the resolved collection in chunk order. When off (or None selected), nothing auto-adds.
- On session init, the page fetches `collectionDefaults` + the collections list, resolves the default, and renders the selector.

### 4c. Auto-Add Hook

In the translation loop, after a chunk succeeds (`processedResults[i] = { content, rawContent }`), if auto-add is on, dispatch `addEntryToCollection` to the service worker with the resolved collection. Non-blocking (fire-and-forget, errors to toast).

---

## 5. Options — Collections Section

A new **Collections** section (`<section id="section-collections">`, nav item with 📚 icon), placed before the Data section. Layout: **sidebar list** + **detail panel**.

### 5a. Sidebar — Collection List
- **➕ New collection** button at top (prompts for name, creates via service worker).
- Each row: name, entry count, last-updated. Hover reveals ✏️ (rename) and 🗑️ (delete) icons.
- Click a row to open its detail panel.
- Empty state: "No collections yet. Add chunks from the translation page, or create one here."

### 5b. Detail Panel — Entries
- Header: editable name, total entries, **Export ▾** button, 🗑️ Delete collection.
- Entry list — each row shows:
  - Title (click to edit inline).
  - Source label: `Session … · Chunk N`.
  - Added date.
  - Actions: ↑↓ reorder, 🗑️ remove, ↩ re-process (re-translate from `rawContent` using current settings via `processChunk`).
- Bulk actions: **Remove all**, **Re-process all**.
- **Re-import to session:** per-entry button that writes the entry's `content` back into `processedChunks[sessionId][chunkIndex]`, so a curated collection can seed a fresh translation session.

### 5c. Export (per collection)
- **📄 Export .md** — single markdown file: `# {title}` per entry, content below, `---` separator.
- **📖 Export .epub** — proper `.epub` (ZIP: `mimetype`, `META-INF/container.xml`, `content.opf`, `toc.ncx`, one `chapter-N.xhtml` per entry). Each entry a chapter; auto-generated TOC.
- **🖨 Export .html (→ PDF)** — styled HTML with print-friendly CSS (page breaks between entries, readable typography). User opens and uses browser "Print → Save as PDF".

### 5d. Global Default & Backup Toggle
- **Default collection** selector at top of the section: `[None ▾]` — sets `collectionDefaults.global`. Note: "Applied to every session unless overridden on the chunks page."
- **☐ Include collections in Settings backup/export** — sets `collectionIncludeInBackup` (sync storage). Defaults to unchecked.

---

## 6. Service Worker

New `runtime.onMessage` handlers (all operate on `storage.local`):

| Action | Input | Behaviour |
|---|---|---|
| `addEntryToCollection` | `{ collectionId, entry }` | Pushes entry to `collections[collectionId].entries`, updates `updatedAt`. |
| `removeEntryFromCollection` | `{ collectionId, entryId }` | Removes entry by id. |
| `reorderEntries` | `{ collectionId, fromIndex, toIndex }` | Splices entries array. |
| `createCollection` | `{ name }` | Creates `{ id: uuid, name, createdAt, updatedAt, entries: [] }`. Returns it. |
| `updateCollection` | `{ collectionId, name }` | Updates name + `updatedAt`. |
| `deleteCollection` | `{ collectionId }` | Deletes key. |
| `getCollections` | — | Returns full collections map. |
| `reprocessEntry` | `{ sessionId, chunkIndex, prefix, suffix, retryCount }` | Re-runs translation (reuses existing `processChunk` logic). |
| `getCollectionDefaults` | — | Returns `collectionDefaults`. |
| `setCollectionDefaults` | `{ defaults }` | Writes `collectionDefaults`. |

---

## 7. Implementation Scope

**Files touched:** `options.html`, `options.js`, `chunks.html`, `chunks.js`, `service_worker.js`, `manifest.json` (version bump only). No new files.

**Options page (`options.js`):**
- `renderCollectionsSection()` — called when nav-collections is activated and after any mutation.
- Sidebar rendered from `getCollections`; detail panel from selected collection.
- All CRUD buttons route through service-worker message handlers.
- Export functions (`exportCollectionMD`, `exportCollectionEPUB`, `exportCollectionHTML`) run in the options page context — read from in-memory state, no service-worker round-trip needed.
- `collectionIncludeInBackup` honoured in `exportSettings()` / `importSettings()`.

**Chunks page (`chunks.js`):**
- On session init: fetch `collectionDefaults` + collections list; resolve default; render header selector.
- `buildChunkCards` gains the "⊕ Add to ▾" dropdown per card, populated from the fetched collections list.
- Helper `resolveDefaultCollection(sessionId)` — per-session override → global → none.

**EPUB assembly** runs in the options page: build the ZIP (mimetype, `META-INF/container.xml`, `content.opf`, `toc.ncx`, per-entry XHTML) using `TextEncoder` + manual DEFLATE/STORE, then download via blob URL. No external library.

---

## 8. Error Handling

- Service-worker handler failures surface as toasts on the calling page ("❌ Failed to add to collection", etc.).
- Export failures (e.g. ZIP assembly) toast and abort without partial download.
- Re-process failures mark the entry's row with an error state; the existing translation retry logic applies.
