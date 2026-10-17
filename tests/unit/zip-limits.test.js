'use strict';
// lib/zip-limits.js: User-ZIPs werden waehrend des Entpackens gedeckelt — nicht
// nur ueber die (vom Absender gesetzte) deklarierte Groesse. Dazu die Parser,
// die ZIPs lesen (ODT selbst, DOCX vor mammoth), und die Upload-Ablage.

const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');

const { openCappedZip, assertZipWithinLimits, ZipLimitError } = require('../../lib/zip-limits');
const { parseOdt } = require('../../lib/import-parsers/odt');
const { parseDocx } = require('../../lib/import-parsers/docx');
const { ImportBufferStore, contentHash } = require('../../lib/import-buffers');

const KB = 1024;
const SMALL = { maxEntries: 10, maxEntryBytes: 64 * KB, maxTotalBytes: 96 * KB };

async function zipOf(files) {
  const z = new JSZip();
  for (const [name, content] of Object.entries(files)) z.file(name, content);
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Deklarierte (unkomprimierte) Groessen im Local Header UND im Central
 *  Directory auf `size` faelschen — so sieht eine luegende Zip-Bombe aus. */
function forgeDeclaredSize(buf, size, onlyName = null) {
  const out = Buffer.from(buf);
  const nameAt = (off, lenOff) => out.toString('utf8', off, off + out.readUInt16LE(lenOff));
  for (let i = 0; i < out.length - 4; i++) {
    const sig = out.readUInt32LE(i);
    if (sig === 0x04034b50 && (!onlyName || nameAt(i + 30, i + 26) === onlyName)) out.writeUInt32LE(size, i + 22);
    if (sig === 0x02014b50 && (!onlyName || nameAt(i + 46, i + 28) === onlyName)) out.writeUInt32LE(size, i + 24);
  }
  return out;
}

test('innerhalb der Deckel: Eintrag wird gelesen', async () => {
  const buf = await zipOf({ 'a.txt': 'hallo' });
  const zip = await openCappedZip(buf, SMALL);
  assert.equal(await zip.read('a.txt', 'string'), 'hallo');
  assert.equal(await zip.read('fehlt.txt', 'string'), null);
});

test('deklarierte Groesse ueber dem Deckel → frueher Abbruch', async () => {
  const buf = await zipOf({ 'bomb.txt': 'x'.repeat(200 * KB) });
  await assert.rejects(openCappedZip(buf, SMALL), (e) => e instanceof ZipLimitError && e.reason === 'entry');
});

test('luegende deklarierte Groesse: der Deckel greift beim Entpacken', async () => {
  // 2 MB Nullen komprimieren auf wenige KB; deklariert sind 10 Byte.
  const buf = forgeDeclaredSize(await zipOf({ 'bomb.txt': Buffer.alloc(2 * 1024 * KB) }), 10);
  const zip = await openCappedZip(buf, SMALL);
  await assert.rejects(zip.read('bomb.txt', 'string'), (e) => {
    assert.ok(e instanceof ZipLimitError);
    assert.equal(e.message, 'job.error.archiveTooLarge');
    assert.equal(e.code, 'ZIP_LIMIT');
    return true;
  });
});

test('Gesamtbudget ueber mehrere Eintraege', async () => {
  const files = { 'a.txt': 'a'.repeat(60 * KB), 'b.txt': 'b'.repeat(60 * KB) };
  // Ehrlich deklariert: schon beim Oeffnen abgewiesen.
  await assert.rejects(openCappedZip(await zipOf(files), SMALL), (e) => e.reason === 'total');
  // b.txt luegt: erst das Entpacken reisst das Restbudget.
  const zip = await openCappedZip(forgeDeclaredSize(await zipOf(files), 10, 'b.txt'), SMALL);
  await zip.read('a.txt');
  await assert.rejects(zip.read('b.txt'), (e) => e instanceof ZipLimitError && e.reason === 'total');
});

test('read(): maxBytes verschaerft den Deckel fuer einen Zugriff', async () => {
  const buf = forgeDeclaredSize(await zipOf({ 'a.txt': 'a'.repeat(20 * KB) }), 10);
  const zip = await openCappedZip(buf, SMALL);
  await assert.rejects(zip.read('a.txt', 'nodebuffer', { maxBytes: 10 * KB }), (e) => e.reason === 'entry');
});

test('zu viele Eintraege → Abbruch', async () => {
  const files = {};
  for (let i = 0; i < 11; i++) files[`f${i}.txt`] = 'x';
  await assert.rejects(openCappedZip(await zipOf(files), SMALL), ZipLimitError);
});

test('assertZipWithinLimits: Probe ueber alle Eintraege', async () => {
  const ok = await zipOf({ 'a.txt': 'abc' });
  assert.equal(await assertZipWithinLimits(ok, SMALL), 3);
  const bomb = forgeDeclaredSize(await zipOf({ 'a.xml': Buffer.alloc(1024 * KB) }), 10);
  await assert.rejects(assertZipWithinLimits(bomb, SMALL), ZipLimitError);
});

test('parseOdt: content.xml jenseits des Deckels → ZipLimitError', async () => {
  const xml = `<?xml version="1.0"?><office:document-content><office:body><office:text><text:p>${'a'.repeat(200 * KB)}</text:p></office:text></office:body></office:document-content>`;
  const buf = forgeDeclaredSize(await zipOf({ 'content.xml': xml }), 10);
  await assert.rejects(parseOdt(buf, { zipLimits: SMALL }), ZipLimitError);
});

test('parseDocx: Probe vor mammoth → ZipLimitError', async () => {
  const buf = forgeDeclaredSize(await zipOf({ 'word/document.xml': Buffer.alloc(1024 * KB) }), 10);
  await assert.rejects(parseDocx(buf, { zipLimits: SMALL }), ZipLimitError);
});

test('ImportBufferStore: ein offener Upload pro User, Summe gedeckelt', () => {
  const store = new ImportBufferStore({ ttlMs: 60000, maxPerUser: 1, maxTotalBytes: 100 });
  assert.equal(store.admissionError('a@x', 60), null);
  store.put('j1', { buffer: Buffer.alloc(60), userEmail: 'a@x' });
  assert.equal(store.admissionError('A@x', 10), 'IMPORT_PENDING');
  assert.equal(store.admissionError('b@x', 50), 'IMPORT_CAPACITY');
  assert.equal(store.admissionError('b@x', 40), null);
  store.delete('j1');
  assert.equal(store.admissionError('a@x', 60), null);
});

test('contentHash unterscheidet gleich grosse Dateien', () => {
  assert.notEqual(contentHash(Buffer.from('aaaa')), contentHash(Buffer.from('aaab')));
  assert.equal(contentHash(Buffer.from('aaaa')), contentHash(Buffer.from('aaaa')));
});
