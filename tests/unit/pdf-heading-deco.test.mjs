// PDF: Kapitelnummer + Linie/Ornament (lib/pdf-render/heading-deco.js) — jede
// Linienart rendert ohne Fehler, und der verbrauchte Platz stimmt mit dem
// ueberein, was die Keep-with-next-Pruefung annimmt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import PDFDocument from 'pdfkit';
import { useTmpDb } from './_helpers/tmp-db.js';

useTmpDb('pdf-heading-deco');
await import('../../db/schema.js');
const { renderPdfBuffer } = await import('../../lib/pdf-render.js');
const { defaultConfig } = await import('../../lib/pdf-export-defaults.js');
const hs = (await import('../../lib/heading-style.js')).default;
const { drawRule, ruleHeight, _lighten } = (await import('../../lib/pdf-render/heading-deco.js')).default;

test('drawRule verbraucht genau ruleHeight — fuer jede Linienart und Lage', () => {
  const doc = new PDFDocument({ autoFirstPage: true, size: 'A5' });
  doc.registerFont('heading', 'Helvetica');
  for (const ruleStyle of hs.RULE_STYLES) {
    for (const where of ['below', 'above']) {
      for (const ruleWeight of hs.RULE_WEIGHTS) {
        const style = { ...hs.DEFAULTS, ruleStyle, ruleWeight };
        doc.y = 100;
        const x = doc.x;
        drawRule(doc, { style, align: 'center', color: '#1a1a1a', emSize: 11, where });
        assert.equal(Math.round((doc.y - 100) * 1000), Math.round(ruleHeight(style, 11, where) * 1000), `${ruleStyle}/${where}/${ruleWeight}`);
        assert.equal(doc.x, x, 'doc.x unveraendert');
      }
    }
  }
  doc.end();
});

test('_lighten mischt mit Weiss ohne Transparenz', () => {
  assert.equal(_lighten('#000000', 0.5), '#808080');
  assert.equal(_lighten('#ffffff', 0.5), '#ffffff');
  assert.equal(_lighten('kaputt', 0.5), '#999999');
});

const html = '<p>' + 'Es war einmal ein König. '.repeat(12) + '</p>';
const groups = [
  { chapter: { id: 1, name: 'Eins' }, pages: [
    { p: { id: 1, name: 'A' }, pd: { html } },
    { p: { id: 2, name: 'B' }, pd: { html } },
  ] },
  { chapter: { id: 2, name: 'Zwei', parent_chapter_id: 1 }, pages: [{ p: { id: 3, name: 'C' }, pd: { html } }] },
];
const book = { name: 'Test', created_by: { name: 'X' }, created_at: '2024-01-01' };

test('Renderer setzt jede Linienart mit Nummer, Praefix, Unterkapitel- und Abschnittslinie', async () => {
  for (const ruleStyle of hs.RULE_STYLES) {
    const cfg = defaultConfig();
    cfg.cover.enabled = false;
    Object.assign(cfg.chapter, {
      numbering: 'word', numberPrefix: 'chapter', numberCase: 'smallcaps',
      titleRule: true, subTitleRule: true, pageTitleRule: true,
      ruleStyle, rulePosition: 'both', subTitleAlign: 'center', pageTitleAlign: 'center',
      breakBeforeSubchapter: false,
    });
    const buf = await renderPdfBuffer({ book, groups, profile: { config: cfg }, coverBuf: null, token: null });
    assert.equal(buf.slice(0, 5).toString(), '%PDF-', ruleStyle);
  }
});
