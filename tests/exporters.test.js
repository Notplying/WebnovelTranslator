// Pure file-format builders: crc32, STORE-zip structure, EPUB package.
// Run: node --test tests/exporters.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { crc32, buildStoreZip, buildEpub } = require('../exporters.js');

const enc = (s) => new TextEncoder().encode(s);
// DataView over the u8's own window (byteOffset + byteLength) so reads stay
// inside the view — correct even for subarray inputs.
const dv = (u8, off = 0) => new DataView(u8.buffer, u8.byteOffset + off, u8.byteLength - off);

// ─── crc32 ─────────────────────────────────────────────────────────────────────

test('crc32 matches the standard check value for "123456789"', () => {
  // The canonical CRC-32 test vector: crc32("123456789") === 0xCBF43926.
  assert.equal(crc32(enc('123456789')), 0xCBF43926);
});

test('crc32 of empty input is 0', () => {
  assert.equal(crc32(new Uint8Array(0)), 0);
});

// ─── buildStoreZip structure ───────────────────────────────────────────────────

// Minimal zip reader: parses EOCD, walks the central directory, and returns
// { name, offset, crc, size } per entry — enough to verify structure without
// depending on an external unzip tool.
function readZip(u8) {
  const view = dv(u8);
  // EOCD: last 22 bytes.
  const eocdOff = u8.length - 22;
  assert.equal(view.getUint32(eocdOff, true), 0x06054b50, 'EOCD signature');
  const count = view.getUint16(eocdOff + 10, true);
  const cdSize = view.getUint32(eocdOff + 12, true);
  const cdOffset = view.getUint32(eocdOff + 16, true);

  const entries = [];
  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;
  while (p < cdEnd) {
    assert.equal(view.getUint32(p, true), 0x02014b50, 'central dir signature');
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    entries.push({
      name,
      crc: view.getUint32(p + 16, true),
      size: view.getUint32(p + 20, true),
      offset: view.getUint32(p + 42, true),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  assert.equal(entries.length, count, 'EOCD count matches central dir');

  // Each entry's local header must agree with the central directory record.
  for (const e of entries) {
    assert.equal(view.getUint32(e.offset, true), 0x04034b50, `local header sig for ${e.name}`);
    const lNameLen = view.getUint16(e.offset + 26, true);
    const lExtraLen = view.getUint16(e.offset + 28, true);
    const lName = new TextDecoder().decode(u8.subarray(e.offset + 30, e.offset + 30 + lNameLen));
    assert.equal(lName, e.name, 'local name matches central name');
    assert.equal(view.getUint32(e.offset + 14, true), e.crc, `crc for ${e.name}`);
    assert.equal(view.getUint32(e.offset + 18, true), e.size, `size for ${e.name}`);
    // STORE: compressed size == uncompressed size.
    assert.equal(view.getUint32(e.offset + 18, true), view.getUint32(e.offset + 22, true));
    // Data starts right after the local header.
    const dataStart = e.offset + 30 + lNameLen + lExtraLen;
    const data = u8.subarray(dataStart, dataStart + e.size);
    assert.equal(crc32(data), e.crc, `data crc matches for ${e.name}`);
  }
  return entries;
}

test('buildStoreZip emits a structurally valid zip with matching names/data', () => {
  const zip = buildStoreZip([
    { name: 'a.txt', data: enc('hello') },
    { name: 'b.txt', data: enc('world world') },
    { name: 'dir/c.txt', data: enc('nested') },
  ]);
  const entries = readZip(zip);
  assert.deepEqual(entries.map(e => e.name), ['a.txt', 'b.txt', 'dir/c.txt']);
});

test('buildStoreZip handles an empty file list (EOCD only)', () => {
  const zip = buildStoreZip([]);
  const view = dv(zip);
  assert.equal(zip.length, 22);
  assert.equal(view.getUint32(0, true), 0x06054b50);
  assert.equal(view.getUint16(10, true), 0);
});

// ─── buildEpub ─────────────────────────────────────────────────────────────────

test('buildEpub produces a valid zip with mimetype first and all EPUB files', () => {
  const coll = {
    name: 'My Book',
    entries: [
      { chunkIndex: 0, title: 'Chapter One', content: 'Hello <world>.\nSecond line.' },
      { chunkIndex: 1, title: '', content: '', rawContent: 'Raw line' },
    ],
  };
  const { zip, baseName } = buildEpub(coll);
  assert.equal(baseName, 'My_Book');

  const entries = readZip(zip);
  assert.equal(entries[0].name, 'mimetype', 'mimetype must be first');
  const names = entries.map(e => e.name);
  // EPUB 3: nav.xhtml is the sole TOC (no EPUB 2-style toc.ncx).
  for (const want of ['mimetype', 'chapter-1.xhtml', 'chapter-2.xhtml', 'content.opf', 'META-INF/container.xml', 'nav.xhtml']) {
    assert.ok(names.includes(want), `missing ${want}`);
  }

  // mimetype content is exact.
  const mime = entries.find(e => e.name === 'mimetype');
  const mimeNameLen = dv(zip).getUint16(mime.offset + 26, true);
  const bytes = zip.subarray(mime.offset + 30 + mimeNameLen, mime.offset + 30 + mimeNameLen + mime.size);
  assert.equal(new TextDecoder().decode(bytes), 'application/epub+zip');
});

test('buildEpub escapes XML in titles and content', () => {
  const coll = {
    name: 'A & B',
    entries: [{ chunkIndex: 0, title: 'He said "hi" <now>', content: 'a & b < c' }],
  };
  const { zip } = buildEpub(coll);
  const chapter = readZip(zip).find(e => e.name === 'chapter-1.xhtml');
  const nameLen = dv(zip).getUint16(chapter.offset + 26, true);
  const bytes = zip.subarray(chapter.offset + 30 + nameLen, chapter.offset + 30 + nameLen + chapter.size);
  const xml = new TextDecoder().decode(bytes);
  assert.ok(xml.includes('He said &quot;hi&quot; &lt;now&gt;'));
  assert.ok(xml.includes('a &amp; b &lt; c'));
});
