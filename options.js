// options.js — Settings page logic for AI Webnovel Translator v3
// Uses browser polyfill (loaded before this script)

// DEFAULTS, SETTINGS, sanitizeNumericSettings and NON_SETTING_STORAGE_KEYS
// live in the shared settings.js module (loaded before this script).

// ─── Toast ────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'show' + (type ? ` ${type}` : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = ''; }, 2500);
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function setupNav() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    if (!btn.dataset.section || !document.getElementById('section-' + btn.dataset.section)) return;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(b => { b.classList.remove('active'); });
      document.querySelectorAll('.section').forEach(s => { s.classList.remove('active'); });
      btn.classList.add('active');
      const target = document.getElementById('section-' + btn.dataset.section);
      if (target) target.classList.add('active');
      if (btn.dataset.section === 'fewshot') {
        renderFewShotCustomList();
        renderFewShotAutoCount();
      }
      if (btn.dataset.section === 'collections') {
        renderCollectionsSection();
      }
    });
  });
}

// ─── Password visibility toggles ─────────────────────────────────────────────
function setupPasswordToggles() {
  document.querySelectorAll('.toggle-pw').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
      const isHidden = input.type === 'password';
      btn.textContent = isHidden ? '👁' : '🙈';
      btn.setAttribute('aria-label', isHidden ? 'Show password' : 'Hide password');
    });
  });
}

// ─── Load settings into form ──────────────────────────────────────────────────
function setField(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.type === 'checkbox') el.checked = value === true || value === 'true';
  else el.value = value != null ? value : '';
}

// ─── UI theme (Modern/Classic) ────────────────────────────────────────────────
// applyUiTheme + UI_THEME live in the shared ui-theme.js module. The theme is
// applied instantly on toggle (not via the Save button) and mirrored to
// localStorage so ui-boot.js can read it synchronously before first paint.

async function loadSettings() {
  let stored;
  try {
    stored = await browser.storage.local.get(null);
  } catch (err) {
    console.error('Failed to load settings:', err);
    showToast('❌ Failed to load settings from storage.', 'error');
    return;
  }
  const settings = { ...DEFAULTS, ...stored };

  // Local-storage settings loop over the schema; sync-area (collectionIncludeInBackup)
  // and instant-apply (uiTheme) keys are handled separately below.
  for (const [key, def] of Object.entries(SETTINGS)) {
    if (def.area === 'sync' || def.instant) continue;
    setField(def.elementId || key, settings[key]);
  }

  // collectionIncludeInBackup lives in browser.storage.sync — the single source of truth.
  // Read it from sync here so the general load path reflects the persisted toggle, not local.
  try {
    const { collectionIncludeInBackup } = await browser.storage.sync.get('collectionIncludeInBackup');
    setField('collectionIncludeInBackup', collectionIncludeInBackup !== undefined ? collectionIncludeInBackup : settings.collectionIncludeInBackup);
  } catch (err) {
    setField('collectionIncludeInBackup', settings.collectionIncludeInBackup);
  }

  // Reflect the stored theme in the toggle — without this it renders unchecked
  // (claiming Classic) while Modern is active, so the first click would be a
  // no-op write. Apply first, then derive the checkbox from the NORMALIZED
  // theme (matching the onChanged listener's ordering), so a value normalized
  // to Classic also synchronizes the toggle.
  const normalizedTheme = applyUiTheme(settings.uiTheme);
  setField('uiTheme', normalizedTheme === UI_THEME.MODERN);

  updatePromptPreview();
}

// ─── Numeric sanitizer ───────────────────────────────────────────────────────
// Lives in settings.js (table-driven, fallbacks = schema defaults).

// ─── Save settings from form ──────────────────────────────────────────────────
function getField(id) {
  const el = document.getElementById(id);
  if (!el) return undefined;
  // Return boolean for checkboxes, value for all other inputs
  return el.type === 'checkbox' ? el.checked : el.value;
}

async function saveSettings() {
  // Local-storage settings loop over the schema; sync-area and instant-apply
  // keys are written by their dedicated paths below.
  const raw = {};
  for (const [key, def] of Object.entries(SETTINGS)) {
    if (def.area === 'sync' || def.instant) continue;
    raw[key] = getField(def.elementId || key);
  }
  try {
    await browser.storage.local.set(sanitizeNumericSettings(raw));
    // collectionIncludeInBackup is the only setting stored in sync — keep it there as source of truth.
    await browser.storage.sync.set({ collectionIncludeInBackup: getField('collectionIncludeInBackup') });
  } catch (err) {
    showToast('❌ Failed to save settings: ' + err.message, 'error');
    return false;
  }
  showToast('✅ Settings saved!', 'success');
  return true;

}

// ─── Prompt preview ───────────────────────────────────────────────────────────
function updatePromptPreview() {
  const prefix = document.getElementById('prefix')?.value || '';
  const suffix = document.getElementById('suffix')?.value || '';
  const sample = '[Sample chunk text would appear here...]';
  const preview = document.getElementById('promptPreview');
  if (!preview) return;
  const full = prefix + '\n' + sample + '\n' + suffix;
  preview.replaceChildren();
  const enabled = document.getElementById('fewShotEnabled')?.checked;
  if (enabled) {
    const count = parseInt(document.getElementById('fewShotCount')?.value, 10) || 0;
    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.textContent = `${count} example(s) will be prepended`;
    preview.append(badge, document.createTextNode('\n'));
  }
  // Render as text nodes (textContent escapes), wrapping every occurrence of
  // the sample marker in <em> — the old string-replace semantics, unescaped.
  const parts = full.split('[Sample chunk text would appear here...]');
  parts.forEach((part, i) => {
    if (part) preview.append(document.createTextNode(part));
    if (i < parts.length - 1) {
      const em = document.createElement('em');
      em.textContent = '[Sample chunk text would appear here...]';
      preview.append(em);
    }
  });
}

// ─── Few-Shot management ──────────────────────────────────────────────────────
// escapeHtml lives in utils.js (single convention for both pages, includes
// &quot; for attribute contexts); entry title resolution lives in
// collections.js (defaultEntryTitle).

// Render markdown text to sanitized HTML, mirroring the chunks page renderer.
function renderMarkdown(text) {
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
    return '<p>' + escapeHtml(text || '') + '</p>';
  }
  const NUL = String.fromCharCode(0);
  const imgTags = [];
  let processed = decodeHtmlEntities(text);
  // Strip reasoning/thinking blocks before escaping so the tags are still
  // recognizable and only the translation content renders.
  try { processed = processed.replace(new RegExp('<think[\\s\\S]*?<\\/think>', 'gi'), ''); } catch (_) {}
  // Extract <img> tags before escaping so they survive sanitization.
  processed = processed.replace(/<img[^>]*>/gi, match => {
    imgTags.push(match);
    return NUL + 'IMG' + (imgTags.length - 1) + NUL;
  });
  processed = escapeHtml(processed);
  imgTags.forEach((tag, i) => { processed = processed.replace(NUL + 'IMG' + i + NUL, tag); });
  const html = marked.parse(processed);
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'data-original-src', 'style'], FORBID_TAGS: ['style', 'script'] });
}

async function renderFewShotCustomList() {
  const list = document.getElementById('fewShotCustomList');
  if (!list) return;
  const items = await getCustomExamples();
  const countEl = document.getElementById('fewShotCustomCount');
  if (countEl) countEl.textContent = `${items.length} saved`;
  if (items.length === 0) {
    list.innerHTML = '<div class="fewshot-empty">No custom examples yet — add an original excerpt and its translation above.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const ex of items) {
    const row = document.createElement('div');
    row.className = 'example-row';
    const pair = document.createElement('div');
    pair.className = 'example-pair';
    for (const [cellClass, eyebrow, value] of [
      ['example-cell example-cell--raw', 'Raw', ex.raw],
      ['example-cell example-cell--trans', 'Translation', ex.translation],
    ]) {
      const cell = document.createElement('div');
      cell.className = cellClass;
      const label = document.createElement('span');
      label.className = 'example-eyebrow';
      label.textContent = eyebrow;
      const text = document.createElement('p');
      text.className = 'example-text';
      text.textContent = value.length > 160 ? value.slice(0, 160) + '…' : value;
      cell.append(label, text);
      pair.append(cell);
    }
    row.append(pair);
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn-danger fewshot-remove';
    removeBtn.dataset.id = ex.id;
    removeBtn.setAttribute('aria-label', 'Remove custom example');
    removeBtn.title = 'Remove custom example';
    removeBtn.textContent = '🗑';
    row.append(removeBtn);
    frag.append(row);
  }
  list.replaceChildren(frag);
  list.querySelectorAll('.fewshot-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      await removeCustomExample(btn.dataset.id);
      await renderFewShotCustomList();
      updatePromptPreview();
      showToast('🗑 Custom example removed', 'success');
    });
  });
}

async function renderFewShotAutoCount() {
  const el = document.getElementById('fewShotAutoCount');
  if (!el) return;
  const items = await getExamples();
  el.textContent = String(items.length);
}

async function addFewShotCustomFromForm() {
  const raw = document.getElementById('fewShotCustomRaw')?.value?.trim();
  const translation = document.getElementById('fewShotCustomTranslation')?.value?.trim();
  if (!raw || !translation) { showToast('⚠️ Both raw text and translation are required.', 'error'); return; }
  await addCustomExample({ raw, translation, timestamp: Date.now() });
  document.getElementById('fewShotCustomRaw').value = '';
  document.getElementById('fewShotCustomTranslation').value = '';
  await renderFewShotCustomList();
  updatePromptPreview();
  showToast('➕ Custom example added', 'success');
}

async function clearFewShotAuto() {
  if (!confirm('Clear ALL recent translations from the auto pool? Custom examples are kept.')) return;
  await clearExamples();
  await renderFewShotAutoCount();
  updatePromptPreview();
  showToast('🗑 Recent pool cleared', 'success');
}

async function clearFewShotCustom() {
  if (!confirm('Clear ALL custom examples?')) return;
  await clearCustomExamples();
  await renderFewShotCustomList();
  updatePromptPreview();
  showToast('🗑 Custom examples cleared', 'success');
}

// ─── Collections ─────────────────────────────────────────────────────────────
let _selectedCollectionId = null;

// Outside-click handler for the collection export dropdown — installed only while
// the dropdown is open and removed on close or re-render to avoid accumulation.
function closeExportDropdown(e) {
  const exportDrop = document.getElementById('collectionExportDropdown');
  if (exportDrop && !exportDrop.contains(e.target)) {
    exportDrop.classList.remove('open');
    document.removeEventListener('click', closeExportDropdown);
  }
}

// Open a synthetic chunks-page session containing the given items, then open
// chunks.html in a new tab pointed at it. Each item becomes one chunk: its
// `raw` is the source text and its `content` is the translated result shown as
// an already-processed chunk (no auto-processing runs). `viewSessionId` is a
// stable id so re-opening overwrites the same synthetic session.
async function openCollectionViewAsChunks(viewSessionId, sessionName, items) {
  // items: [{ raw, content, title }]
  if (!items || !items.length) { showToast('Nothing to view.', 'error'); return; }
  const chunks = items.map(it => it.raw || it.content || '');
  const titles = items.map(it => it.title || '');
  const contents = items.map(it => it.content || '');
  const processed = chunks.map((raw, i) => ({
    content: { parts: [contents[i]], text: contents[i] },
    rawContent: raw,
  }));
  await mutate('translationSessions', (translationSessions = []) => {
    const prior = translationSessions.findIndex(s => s.id === viewSessionId);
    const session = {
      id: viewSessionId,
      name: sessionName,
      chunks, titles,
      prefix: '', suffix: '', retryCount: 3,
      createdAt: Date.now(),
    };
    if (prior >= 0) translationSessions[prior] = session;
    else translationSessions.push(session);
    return { changed: true, result: translationSessions };
  });
  // Persist the processed results so every chunk renders as already done.
  await mutate('processedChunks', (processedChunks = {}) => {
    processedChunks[viewSessionId] = processed;
    return { changed: true, result: processedChunks };
  });
  // Open the chunks page in a new tab (user-triggered, so popup blockers allow it).
  const url = browser.runtime.getURL('chunks.html') + '?session=' + encodeURIComponent(viewSessionId);
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  showToast(`✅ Opened ${items.length} chunk${items.length === 1 ? '' : 's'} in a new tab.`, 'success');
}

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
    if (colls?.error || defs?.error) throw new Error(colls?.error || defs?.error);
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
    const frag = document.createDocumentFragment();
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = 'None';
    frag.append(noneOpt);
    for (const c of Object.values(collectionsMap)) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      if (c.id === defaults.global) opt.selected = true;
      frag.append(opt);
    }
    globalSel.replaceChildren(frag);
    if (cur && collectionsMap[cur]) globalSel.value = cur;
    else if (defaults.global) globalSel.value = defaults.global;
    // Assigned handler (not addEventListener) so re-rendering replaces rather than accumulates.
    globalSel.onchange = async (e) => {
      const value = e.target.value || null;
      // Retain the prior value so we can roll back both local state and the UI on failure.
      const prior = defaults.global;
      defaults.global = value;
      try {
        const res = await browser.runtime.sendMessage({ action: 'setCollectionGlobalDefault', value });
        if (res?.error) throw new Error(res.error);
      } catch (err) {
        defaults.global = prior;
        globalSel.value = prior || '';
        showToast('❌ Failed to save default.', 'error');
      }
    };
  }

  // Backup toggle.
  const cb = document.getElementById('collectionIncludeInBackup');
  if (cb) {
    cb.checked = includeInBackup;
    // Assigned handler so re-rendering replaces rather than accumulates listeners.
    cb.onchange = async (e) => {
      try {
        await browser.storage.sync.set({ collectionIncludeInBackup: e.target.checked });
      } catch (err) { console.error('[collections] sync toggle failed:', err); }
    };
  }

  // Sidebar list.
  const list = document.getElementById('collectionList');
  if (list) {
    const colls = Object.values(collectionsMap);
    if (colls.length === 0) {
      list.innerHTML = '<div class="collection-empty" style="padding:24px 12px">No collections yet. Add chunks from the translation page, or create one here.</div>';
    } else {
      const frag = document.createDocumentFragment();
      for (const c of colls) {
        const count = (c.entries || []).length;
        const updated = c.updatedAt ? new Date(c.updatedAt).toLocaleDateString() : '';
        const selected = c.id === _selectedCollectionId;
        const item = document.createElement('div');
        item.className = 'collection-item' + (selected ? ' active' : '');
        item.dataset.id = c.id;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(selected));
        item.tabIndex = 0;
        item.setAttribute('aria-label', c.name);
        const info = document.createElement('div');
        info.className = 'collection-item-info';
        const name = document.createElement('div');
        name.className = 'collection-item-name';
        name.textContent = c.name;
        const meta = document.createElement('div');
        meta.className = 'collection-item-meta';
        meta.textContent = `${count} entr${count === 1 ? 'y' : 'ies'}${updated ? ' · ' + updated : ''}`;
        info.append(name, meta);
        const actions = document.createElement('div');
        actions.className = 'collection-item-actions';
        const renameBtn = document.createElement('button');
        renameBtn.className = 'collection-item-action-btn';
        renameBtn.dataset.action = 'rename';
        renameBtn.dataset.id = c.id;
        renameBtn.setAttribute('aria-label', 'Rename');
        renameBtn.title = 'Rename';
        renameBtn.textContent = '✏️';
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'collection-item-action-btn delete';
        deleteBtn.dataset.action = 'delete';
        deleteBtn.dataset.id = c.id;
        deleteBtn.setAttribute('aria-label', 'Delete');
        deleteBtn.title = 'Delete';
        deleteBtn.textContent = '🗑';
        actions.append(renameBtn, deleteBtn);
        item.append(info, actions);
        frag.append(item);
      }
      list.replaceChildren(frag);
      // Click or keyboard (Enter/Space) to select. Action buttons are excluded.
      list.querySelectorAll('.collection-item').forEach(item => {
        const select = () => {
          _selectedCollectionId = item.dataset.id;
          renderCollectionsSection();
        };
        item.addEventListener('click', (e) => {
          if (e.target.closest('.collection-item-action-btn')) return;
          select();
        });
        item.addEventListener('keydown', (e) => {
          if (e.target.closest('.collection-item-action-btn')) return;
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); }
        });
      });
      // Action buttons.
      list.querySelectorAll('.collection-item-action-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = btn.dataset.id;
          try {
            if (btn.dataset.action === 'rename') {
              const coll = collectionsMap[id];
              const name = prompt('Collection name:', coll?.name);
              if (!name || !name.trim()) return;
              const res = await browser.runtime.sendMessage({ action: 'updateCollection', collectionId: id, name: name.trim() });
              if (res?.error) throw new Error(res.error);
              showToast('✏️ Collection renamed.', 'success');
            } else if (btn.dataset.action === 'delete') {
              if (!confirm('Delete this collection? This cannot be undone.')) return;
              const res = await browser.runtime.sendMessage({ action: 'deleteCollection', collectionId: id });
              if (res?.error) throw new Error(res.error);
              if (_selectedCollectionId === id) _selectedCollectionId = null;
              showToast('🗑 Collection deleted.', 'success');
            }
          } catch (err) {
            showToast(`❌ ${btn.dataset.action === 'rename' ? 'Rename' : 'Delete'} failed: ${err.message}`, 'error');
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
  detail.replaceChildren();
  const headerRow = document.createElement('div');
  headerRow.className = 'collection-header-row';
  const h2 = document.createElement('h2');
  h2.textContent = coll.name;
  const topActions = document.createElement('div');
  topActions.className = 'action-row';
  const exportDropdown = document.createElement('div');
  exportDropdown.className = 'add-to-dropdown';
  exportDropdown.id = 'collectionExportDropdown';
  const exportBtnEl = document.createElement('button');
  exportBtnEl.className = 'btn btn-secondary btn-sm';
  exportBtnEl.id = 'collectionExportBtn';
  exportBtnEl.textContent = 'Export ▾';
  const exportMenu = document.createElement('div');
  exportMenu.className = 'dropdown-menu';
  exportMenu.style.minWidth = '160px';
  for (const [fmt, label] of [['md', '📄 Export .md'], ['epub', '📖 Export .epub'], ['html', '🖨 Export .html (→ PDF)']]) {
    const item = document.createElement('button');
    item.className = 'dropdown-item';
    item.dataset.format = fmt;
    item.textContent = label;
    exportMenu.append(item);
  }
  exportDropdown.append(exportBtnEl, exportMenu);
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn-danger btn-sm';
  deleteBtn.id = 'collectionDeleteBtn';
  deleteBtn.textContent = '🗑 Delete collection';
  topActions.append(exportDropdown, deleteBtn);
  headerRow.append(h2, topActions);
  const meta = document.createElement('p');
  meta.style.fontSize = '0.78rem';
  meta.style.color = 'var(--text-muted)';
  meta.style.marginBottom = '12px';
  meta.textContent = `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`;
  const row2 = document.createElement('div');
  row2.className = 'action-row';
  row2.style.marginBottom = '12px';
  for (const [btnId, label] of [['collectionRemoveAllBtn', '🗑 Remove all'], ['collectionReprocessAllBtn', '↩ Re-process all'], ['collectionViewAllBtn', '👁 View collection']]) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary btn-sm';
    btn.id = btnId;
    btn.textContent = label;
    row2.append(btn);
  }
  const entriesWrap = document.createElement('div');
  entriesWrap.className = 'collection-entries';
  entriesWrap.id = 'collectionEntries';
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'collection-empty';
    empty.style.padding = '24px 12px';
    empty.textContent = 'No entries yet.';
    entriesWrap.append(empty);
  }
  detail.append(headerRow, meta, row2, entriesWrap);

  if (entries.length > 0) {
    const entriesEl = document.getElementById('collectionEntries');
    const frag = document.createDocumentFragment();
    entries.forEach((e, idx) => {
      const added = e.addedAt ? new Date(e.addedAt).toLocaleString() : '';
      const source = `Session ${((e.sessionId || '').slice(0, 8))} · Chunk ${e.chunkIndex + 1}`;
      const entryEl = document.createElement('div');
      entryEl.className = 'collection-entry';
      entryEl.dataset.index = idx;
      const reorderCol = document.createElement('div');
      reorderCol.style.display = 'flex';
      reorderCol.style.flexDirection = 'column';
      reorderCol.style.gap = '2px';
      reorderCol.style.alignItems = 'center';
      reorderCol.style.paddingTop = '2px';
      const upBtn = document.createElement('button');
      upBtn.className = 'collection-item-action-btn reorder-up';
      upBtn.dataset.idx = idx;
      upBtn.setAttribute('aria-label', 'Move up');
      upBtn.title = 'Move up';
      upBtn.textContent = '▲';
      if (idx === 0) { upBtn.disabled = true; upBtn.style.opacity = '0.3'; upBtn.style.cursor = 'default'; }
      const downBtn = document.createElement('button');
      downBtn.className = 'collection-item-action-btn reorder-down';
      downBtn.dataset.idx = idx;
      downBtn.setAttribute('aria-label', 'Move down');
      downBtn.title = 'Move down';
      downBtn.textContent = '▼';
      if (idx === entries.length - 1) { downBtn.disabled = true; downBtn.style.opacity = '0.3'; downBtn.style.cursor = 'default'; }
      reorderCol.append(upBtn, downBtn);
      const mid = document.createElement('div');
      const titleEl = document.createElement('div');
      titleEl.className = 'collection-entry-title';
      titleEl.setAttribute('contenteditable', 'true');
      titleEl.dataset.entryId = e.id;
      titleEl.title = 'Click to edit title';
      titleEl.textContent = defaultEntryTitle(e);
      const metaEl = document.createElement('div');
      metaEl.className = 'collection-entry-meta';
      metaEl.textContent = `${source} · Added ${added}`;
      mid.append(titleEl, metaEl);
      const actionsEl = document.createElement('div');
      actionsEl.className = 'collection-entry-actions';
      for (const [btnClass, btnTitle, label] of [
        ['entry-view', 'View in chunks page', '👁 View'],
        ['entry-reimport', 'Re-import to session', '↩ Re-import'],
        ['entry-reprocess', 'Re-translate from raw', '↩ Re-process'],
        ['entry-remove', null, '🗑 Remove'],
      ]) {
        const btn = document.createElement('button');
        btn.className = 'btn ' + (btnClass === 'entry-remove' ? 'btn-danger' : 'btn-secondary') + ' btn-sm ' + btnClass;
        btn.dataset.entryId = e.id;
        if (btnTitle) btn.title = btnTitle;
        btn.textContent = label;
        actionsEl.append(btn);
      }
      entryEl.append(reorderCol, mid, actionsEl);
      frag.append(entryEl);
    });
    entriesEl.replaceChildren(frag);

    // Title edit (blur → save).
    entriesEl.querySelectorAll('[contenteditable="true"]').forEach(el => {
      el.addEventListener('blur', async () => {
        const entryId = el.dataset.entryId;
        const coll = collectionsMap[_selectedCollectionId];
        const entry = coll?.entries?.find(e => e.id === entryId);
        if (!entry) return;
        const previousTitle = defaultEntryTitle(entry);
        const title = el.textContent.trim() || defaultEntryTitle(entry);
        el.textContent = title;
        try {
          // Route through the serialized worker mutation instead of writing collections directly.
          const res = await browser.runtime.sendMessage({ action: 'updateEntryTitle', collectionId: _selectedCollectionId, entryId, title });
          if (res?.error) throw new Error(res.error);
        } catch (err) {
          showToast('❌ Failed to save title.', 'error');
          el.textContent = previousTitle;
        }
      });
    });

    // Reorder.
    entriesEl.querySelectorAll('.reorder-up, .reorder-down').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.dataset.idx);
        const to = btn.classList.contains('reorder-up') ? idx - 1 : idx + 1;
        try {
          const res = await browser.runtime.sendMessage({ action: 'reorderEntries', collectionId: _selectedCollectionId, fromIndex: idx, toIndex: to });
          if (res?.error) throw new Error(res.error);
          renderCollectionsSection();
        } catch (err) { showToast('❌ Failed to reorder.', 'error'); }
      });
    });

    // View entry — open a new chunks page containing just this single entry.
    entriesEl.querySelectorAll('.entry-view').forEach(btn => {
      btn.addEventListener('click', async () => {
        const entry = entries.find(e => e.id === btn.dataset.entryId);
        if (!entry) return;
        try {
          await openCollectionViewAsChunks(
            _selectedCollectionId + '_entry_' + entry.id,
            coll.name + ' · ' + defaultEntryTitle(entry),
            [{ raw: entry.rawContent, content: entry.content, title: defaultEntryTitle(entry) }]
          );
        } catch (err) { showToast('❌ Failed to open: ' + err.message, 'error'); }
      });
    });

    // Remove entry.
    entriesEl.querySelectorAll('.entry-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          const res = await browser.runtime.sendMessage({ action: 'removeEntryFromCollection', collectionId: _selectedCollectionId, entryId: btn.dataset.entryId });
          if (res?.error) throw new Error(res.error);
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
          await mutate('processedChunks', (processedChunks = {}) => {
            const sess = processedChunks[entry.sessionId] || [];
            sess[entry.chunkIndex] = { content: { parts: [entry.content], text: entry.content }, rawContent: entry.rawContent };
            processedChunks[entry.sessionId] = sess;
            return { changed: true, result: processedChunks };
          });
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
            retryCount: retryCount ?? 3,
            rawContent: entry.rawContent,
          });
          if (res?.error) throw new Error(res.error);
          if (!Array.isArray(res.result?.parts)) throw new Error('Malformed translation result.');
          const content = res.result.parts.join('');
          // Persist the updated content through the serialized worker mutation.
          const upRes = await browser.runtime.sendMessage({ action: 'updateEntryContent', collectionId: _selectedCollectionId, entryId: entry.id, content });
          if (upRes?.error) throw new Error(upRes.error);
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
    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = exportDrop.classList.toggle('open');
      // Install the outside-click close handler only while the dropdown is open,
      // removing any prior instance first so re-renders don't accumulate listeners.
      document.removeEventListener('click', closeExportDropdown);
      if (open) requestAnimationFrame(() => document.addEventListener('click', closeExportDropdown));
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
      const res = await browser.runtime.sendMessage({ action: 'deleteCollection', collectionId: _selectedCollectionId });
      if (res?.error) throw new Error(res.error);
      _selectedCollectionId = null;
      renderCollectionsSection();
      showToast('🗑 Collection deleted.', 'success');
    } catch (err) { showToast('❌ Failed to delete collection.', 'error'); }
  });

  // View collection — open a new chunks page populated with every entry in the
  // collection, rendered as already-translated chunks with their entry titles.
  document.getElementById('collectionViewAllBtn')?.addEventListener('click', async () => {
    if (!entries.length) { showToast('Nothing to view — collection is empty.', 'error'); return; }
    try {
      await openCollectionViewAsChunks(
        'collection_' + _selectedCollectionId,
        'Collection: ' + coll.name,
        entries.map(e => ({ raw: e.rawContent, content: e.content, title: defaultEntryTitle(e) }))
      );
    } catch (err) { showToast('❌ Failed to open collection: ' + err.message, 'error'); }
  });

  // Remove all.
  document.getElementById('collectionRemoveAllBtn')?.addEventListener('click', async () => {
    if (!confirm('Remove all entries from this collection?')) return;
    try {
      const res = await browser.runtime.sendMessage({ action: 'clearCollectionEntries', collectionId: _selectedCollectionId });
      if (res?.error) throw new Error(res.error);
      renderCollectionsSection();
      showToast('🗑 All entries removed.', 'success');
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
          retryCount: retryCount ?? 3,
          rawContent: entry.rawContent,
        });
        if (res?.error) throw new Error(res.error);
        if (!Array.isArray(res.result?.parts)) throw new Error('Malformed translation result.');
        const content = res.result.parts.join('');
        // Persist the updated content through the serialized worker mutation, not a full-collection write.
        const upRes = await browser.runtime.sendMessage({ action: 'updateEntryContent', collectionId: _selectedCollectionId, entryId: entry.id, content });
        if (upRes?.error) throw new Error(upRes.error);
        ok++;
      } catch (err) { fail++; console.error(err); }
    }
    renderCollectionsSection();
    showToast(`✅ Re-processed: ${ok} ok, ${fail} failed.`, fail ? 'error' : 'success');
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = '↩ Re-process all'; }
  });
}

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
  const safeName = escapeHtml(collection.name || 'collection');
  const entriesHtml = collection.entries.map(e => {
    const title = escapeHtml(e.title || `Chunk ${e.chunkIndex + 1}`);
    const body = escapeHtml(e.content || '');
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

// ── EPUB export ──────────────────────────────────────────────────────────────
// The bit-level STORE-zip + EPUB package builder lives in exporters.js
// (buildEpub), so it is Node-testable; this wrapper owns only the browser
// bits — the download and the toast.

function exportCollectionEPUB(collection) {
  if (!collection || !(collection.entries || []).length) { showToast('Nothing to export.', 'error'); return; }
  try {
    const { zip, baseName } = buildEpub(collection);
    downloadBlob(new Blob([zip], { type: 'application/epub+zip' }), `${baseName}.epub`);
    showToast('📖 EPUB exported!', 'success');
  } catch (err) {
    console.error('EPUB export failed:', err);
    showToast('❌ EPUB export failed: ' + err.message, 'error');
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────
async function exportSettings() {
  let all;
  try {
    all = await browser.storage.local.get(null);
  } catch (err) {
    showToast('❌ Failed to export settings: ' + err.message, 'error');
    return;
  }
  const filtered = Object.fromEntries(
    Object.entries(all).filter(([k]) => !NON_SETTING_STORAGE_KEYS.includes(k))
  );

  // Optionally merge collections into the backup.
  try {
    const include = getField('collectionIncludeInBackup');
    if (include) {
      const { collections, collectionDefaults } = await browser.storage.local.get(['collections', 'collectionDefaults']);
      if (collections) filtered.collections = collections;
      if (collectionDefaults) filtered.collectionDefaults = collectionDefaults;
    }
  } catch (_) { /* best-effort */ }

  const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'webnovel-translator-settings.json'; a.click();
  URL.revokeObjectURL(url);
  showToast('📥 Settings exported!', 'success');
}

// ─── Import ───────────────────────────────────────────────────────────────────
// Only these keys may be written from an imported file (all schema settings plus
// the user-authored data keys from settings.js). Any extra keys in the JSON are
// silently dropped.
// Setting portion derived from the schema keys (DEFAULTS) minus the
// non-setting storage keys, so the allowlist exactly matches what export
// writes — plus the user-authored data keys from settings.js.
const ALLOWED_IMPORT_KEYS = [
  ...Object.keys(DEFAULTS).filter(k => !NON_SETTING_STORAGE_KEYS.includes(k)),
  ...IMPORTABLE_DATA_KEYS,
];
const VALID_API_TYPES = ['gemini', 'openRouter', 'openai', 'chatgptWeb', 'geminiWeb'];

async function importFromJSON(json) {
  try {
    const data = JSON.parse(json);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new TypeError('Expected a JSON object');
    }
    const whitelisted = {};
    for (const key of ALLOWED_IMPORT_KEYS) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        whitelisted[key] = data[key];
      }
    }
    // Validate apiType if present
    if (whitelisted.apiType && !VALID_API_TYPES.includes(whitelisted.apiType)) {
      throw new TypeError(`Invalid apiType "${whitelisted.apiType}". Must be one of: ${VALID_API_TYPES.join(', ')}`);
    }
    // collectionIncludeInBackup lives in sync — drop it from the local import so sync is the single source of truth.
    delete whitelisted.collectionIncludeInBackup;
    await browser.storage.local.set(sanitizeNumericSettings(whitelisted));

    // Validate imported collections, defaults, and backup toggle before persisting.
    // Only validated values are written; invalid collection data and the toggle are
    // omitted rather than writing untrusted JSON verbatim.
    const validCollections = {};
    if (data.collections && typeof data.collections === 'object' && !Array.isArray(data.collections)) {
      for (const [id, c] of Object.entries(data.collections)) {
        if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
        if (typeof c.name !== 'string' || !Array.isArray(c.entries)) continue;
        const entries = c.entries.filter(e =>
          e && typeof e === 'object' && !Array.isArray(e) &&
          typeof e.id === 'string' && typeof e.sessionId === 'string' &&
          Number.isInteger(e.chunkIndex) && e.chunkIndex >= 0
        );
        validCollections[id] = { ...c, entries };
      }
    }

    let validDefaults = null;
    if (data.collectionDefaults && typeof data.collectionDefaults === 'object' && !Array.isArray(data.collectionDefaults)) {
      const d = data.collectionDefaults;
      const global = (d.global === null || d.global === undefined || d.global === '') ? null : (typeof d.global === 'string' ? d.global : null);
      const perSession = {};
      if (d.perSession && typeof d.perSession === 'object' && !Array.isArray(d.perSession)) {
        for (const [sid, val] of Object.entries(d.perSession)) {
          if (typeof val === 'string' && val !== '') perSession[sid] = val;
        }
      }
      validDefaults = { global, perSession };
    }

    // Restore collection data (collections + defaults) to local storage only, omitting invalid entries.
    const collData = {};
    if (Object.keys(validCollections).length) collData.collections = validCollections;
    if (validDefaults) collData.collectionDefaults = validDefaults;
    if (Object.keys(collData).length) await browser.storage.local.set(collData);

    // Restore only the backup toggle to sync — its single source of truth. Must be boolean.
    if (typeof data.collectionIncludeInBackup === 'boolean') {
      await browser.storage.sync.set({ collectionIncludeInBackup: data.collectionIncludeInBackup });
    }

    await loadSettings();
    showToast('✅ Settings imported!', 'success');
  } catch (e) {
    showToast('❌ Import failed: ' + e.message, 'error');
  }
}

// ─── Reset ────────────────────────────────────────────────────────────────────
async function resetSettings() {
  if (!confirm('Reset ALL settings to defaults? This cannot be undone.')) return;
  try {
    // Preserve session data; the get→clear→set sequence runs under the
    // store's '*' barrier (resetLocal), so an in-flight mutation from another
    // context lands before the wipe instead of being lost.
    await resetLocal(['processedChunks', 'translationSessions'], DEFAULTS);
  } catch (err) {
    showToast('❌ Reset failed: ' + err.message, 'error');
    return;
  }
  await loadSettings();
  showToast('♻️ Settings reset to defaults.', 'success');
}



// ─── Web permission helper ────────────────────────────────────────────────────
async function ensureWebPermissionsForApiType(apiType) {
  if (apiType !== 'chatgptWeb' && apiType !== 'geminiWeb') return true;
  const { origins, permissions } = WEB_PERMISSIONS[apiType] ?? {};
  try {
    const granted = await browser.permissions.request({ origins: origins ?? [], permissions: permissions ?? [] });
    const { webPermissions = {} } = await browser.storage.local.get('webPermissions');
    webPermissions[apiType] = granted;
    await browser.storage.local.set({ webPermissions });
    if (granted) {
      showToast(`✅ ${apiType === 'chatgptWeb' ? 'ChatGPT' : 'Gemini'} Web access granted!`, 'success');
    } else {
      showToast(`⚠️ Permission denied. ${apiType === 'chatgptWeb' ? 'ChatGPT' : 'Gemini'} Web will not function.`, 'error');
    }
    return granted;
  } catch (e) {
    console.error('Permission request failed:', e);
    showToast('❌ Permission request failed: ' + e.message, 'error');
    return false;
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const versionEl = document.getElementById('appVersion');
  if (versionEl) {
    versionEl.textContent = `v${browser.runtime.getManifest().version}`;
  }

  // Clean up toast timer on page unload
  window.addEventListener('beforeunload', () => clearTimeout(toastTimer));

  setupNav();
  setupPasswordToggles();
  await loadSettings();

  // UI theme toggle — instant apply, no Save button involvement.
  document.getElementById('uiTheme')?.addEventListener('change', async () => {
    const prevTheme = document.documentElement.hasAttribute('data-ui') ? UI_THEME.MODERN : UI_THEME.CLASSIC;
    const theme = document.getElementById('uiTheme').checked ? UI_THEME.MODERN : UI_THEME.CLASSIC;
    applyUiTheme(theme);
    try {
      await setRaw('uiTheme', theme);
    } catch (err) {
      // Persistence failed — roll back DOM + mirror to the previously applied
      // theme so the page stays synchronized with committed storage state.
      applyUiTheme(prevTheme);
      setField('uiTheme', prevTheme === UI_THEME.MODERN);
      console.error('Failed to save UI theme:', err);
      showToast('❌ Failed to save UI theme.', 'error');
    }
  });
  // Live-sync: another options/chunks tab changed the theme.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.uiTheme) {
      const theme = applyUiTheme(changes.uiTheme.newValue);
      setField('uiTheme', theme === UI_THEME.MODERN);
    }
  });

  // Save
  document.getElementById('saveButton')?.addEventListener('click', async () => {
    const apiType = getField('apiType');

    // browser.permissions.request must run in the call stack of the user gesture,
    // so we chain the entire flow inside the click handler without pre-awaiting.
    if (!(await ensureWebPermissionsForApiType(apiType))) return;
    if (!(await saveSettings())) return;
  });

  // Prompt preview live update
  document.getElementById('prefix')?.addEventListener('input', updatePromptPreview);
  document.getElementById('suffix')?.addEventListener('input', updatePromptPreview);

  // Export
  document.getElementById('exportButton')?.addEventListener('click', exportSettings);

  // Show selected filename next to the file picker
  document.getElementById('importFile')?.addEventListener('change', e => {
    const nameEl = document.getElementById('importFileName');
    if (nameEl) nameEl.textContent = e.target.files?.[0]?.name || 'No file chosen';
  });

  // Import from file
  document.getElementById('importButton')?.addEventListener('click', () => {
    const file = document.getElementById('importFile')?.files?.[0];
    if (!file) { showToast('Select a JSON file first.', 'error'); return; }
    const reader = new FileReader();
    reader.onload = e => importFromJSON(e.target.result);
    reader.onerror = e => {
      const err = e?.target?.error;
      const msg = err?.message || err?.name || 'unknown error';
      showToast('Failed to read file: ' + msg, 'error');
      console.error('FileReader error in importFromJSON flow', e);
    };
    reader.readAsText(file);
  });

  // Import from textarea
  document.getElementById('importFromTextButton')?.addEventListener('click', () => {
    const text = document.getElementById('importTextarea')?.value;
    if (!text?.trim()) { showToast('Paste JSON first.', 'error'); return; }
    importFromJSON(text);
  });

  // Reset
  document.getElementById('resetButton')?.addEventListener('click', resetSettings);

  // Clear results — routed through the store's removeKeys so the delete waits
  // for any in-flight per-key chain (a raw remove() could erase a just-written
  // processedChunks/session write from the chunks page mid-translation).
  document.getElementById('clearResultsButton')?.addEventListener('click', async () => {
    if (!confirm('Delete all saved translation results and session history?')) return;
    try {
      await removeKeys(['processedChunks', 'translationSessions']);
      showToast('🗑️ All results cleared.', 'success');
    } catch (err) {
      console.error('Failed to clear results:', err);
      showToast('❌ Failed to clear results: ' + err.message, 'error');
    }
  });

  // Few-Shot management
  document.getElementById('fewShotAddCustom')?.addEventListener('click', addFewShotCustomFromForm);
  document.getElementById('fewShotClearCustom')?.addEventListener('click', clearFewShotCustom);
  document.getElementById('fewShotClearAuto')?.addEventListener('click', clearFewShotAuto);
  document.getElementById('fewShotCount')?.addEventListener('input', updatePromptPreview);
  document.getElementById('fewShotEnabled')?.addEventListener('change', updatePromptPreview);

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


  // Web automation quick-select
  document.getElementById('applyWebApiType')?.addEventListener('click', async () => {
    const val = document.getElementById('webApiTypeProxy')?.value;
    if (!val) return;
    document.getElementById('apiType').value = val;

    if (!(await ensureWebPermissionsForApiType(val))) return;
    if (!(await saveSettings())) return;
    showToast(`✅ API type set to ${val}`, 'success');
  });
});
