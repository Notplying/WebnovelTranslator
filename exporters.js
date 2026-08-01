// exporters.js — pure file-format builders (STORE-zip + EPUB) for collection
// exports. Hoisted out of options.js so the bit-level logic is testable in
// Node; the options page keeps only the thin download/toast wrapper.
// Top-level functions are browser globals; the module.exports block at the
// bottom enables Node testing (Node-only; inert in the browser).

// ── Minimal STORE-compression ZIP builder for EPUB ───────────────────────────

function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

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

function zipCentralEntry(info, offset) {
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
  const cdEntries = locals.map(l => zipCentralEntry(l.info, l.offset));
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

// ─── EPUB builder ─────────────────────────────────────────────────────────────

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Builds the complete EPUB package (mimetype first, uncompressed) from a
// collection. Pure — returns { zip, baseName }; the page owns downloading.
function buildEpub(collection) {
  const safeName = escapeXml(collection.name || 'Collection');
  const now = new Date().toISOString().slice(0, 19) + 'Z';
  const uid = crypto.randomUUID();
  const entries = collection.entries || [];

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
  return { zip, baseName: (collection.name || 'collection').replace(/[^a-z0-9]/gi, '_') };
}

// ─── Node test seam (fewshot.js/settings.js pattern; inert in the browser) ─────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { crc32, zipLocalHeader, zipCentralEntry, buildStoreZip, escapeXml, buildEpub };
}
