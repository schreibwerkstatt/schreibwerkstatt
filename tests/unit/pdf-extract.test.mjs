// Unit-Test fuer lib/pdf-extract.js: Magic-Bytes-Gate + echte PDF-Text-Extraktion
// (PDF wird zur Laufzeit via pdfkit erzeugt, kein Fixture noetig) + Caps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractPdfText, isPdf } = require('../../lib/pdf-extract.js');
const PDFKit = require('pdfkit');

function makePdf(lines) {
  return new Promise((resolve) => {
    const doc = new PDFKit({ autoFirstPage: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    lines.forEach((line, i) => {
      if (i > 0) doc.addPage();
      doc.text(line);
    });
    doc.end();
  });
}

test('isPdf erkennt %PDF-Magic-Bytes', () => {
  assert.equal(isPdf(Buffer.from('%PDF-1.7\n...')), true);
  assert.equal(isPdf(Buffer.from('not a pdf')), false);
  assert.equal(isPdf(Buffer.from([0xff, 0xd8, 0xff])), false); // JPEG
  assert.equal(isPdf(Buffer.alloc(2)), false);
});

test('extractPdfText liefert Text + Seitenzahl', async () => {
  const buf = await makePdf(['Hallo Welt aus Seite eins.', 'Inhalt auf Seite zwei.']);
  const { text, pages } = await extractPdfText(buf);
  assert.equal(pages, 2);
  assert.match(text, /Hallo Welt aus Seite eins\./);
  assert.match(text, /Inhalt auf Seite zwei\./);
});

test('extractPdfText weist Nicht-PDF / leere / Nicht-Buffer ab', async () => {
  await assert.rejects(() => extractPdfText(Buffer.from('plain text, no pdf')), /unsupported-format/);
  await assert.rejects(() => extractPdfText(Buffer.alloc(0)), /empty/);
  await assert.rejects(() => extractPdfText('nope'), /not-buffer/);
});

test('capPageTexts: Seitentexte zusammen höchstens max Zeichen (mit Absatzfuge), Rest gekappt', () => {
  const { capPageTexts } = require('../../lib/pdf-extract.js');
  assert.deepEqual(capPageTexts(['aaa', 'bbb'], 100), { pages: ['aaa', 'bbb'], truncated: false });
  const r = capPageTexts(['aaaa', 'bbbb', 'cccc'], 8);
  assert.deepEqual(r, { pages: ['aaaa', 'bb'], truncated: true });
  assert.ok(r.pages.join('\n\n').length <= 8);
  assert.deepEqual(capPageTexts(['aaaa', 'bbbb'], 6), { pages: ['aaaa'], truncated: true });
});
