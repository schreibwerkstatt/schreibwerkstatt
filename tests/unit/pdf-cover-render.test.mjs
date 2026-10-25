// Umschlag-PDF (Phase 4): Geometrie-Asserts auf den Bogen — Rückenbreite,
// MediaBox = Bleed + 2×Trim + Spine, TrimBox vorhanden, ein einzelner Bogen.
// Kein Pixel-Vergleich; Marker + Masse reichen.

import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { useTmpDb } from './_helpers/tmp-db.js';

useTmpDb('pdfx-cover');
await import('../../db/schema.js');
const { renderCoverBuffer, computeSpineMm } = await import('../../lib/pdf-cover-render.js');
const { defaultConfig } = await import('../../lib/pdf-export-defaults.js');
const { MM_TO_PT, _pageSize } = await import('../../lib/pdf-render/layout.js');

const book = { name: 'Test', created_by: { name: 'X' } };

function mediaBox(buf) {
  const m = buf.toString('binary').match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/);
  return m ? m.slice(1).map(Number) : null;
}
function pageCount(buf) {
  return (buf.toString('binary').match(/\/Type\s*\/Page(?!s)/g) || []).length;
}

test('computeSpineMm = paperBulkMmPer1000 × pageCount / 1000', () => {
  assert.equal(computeSpineMm({ pageCount: 200, paperBulkMmPer1000: 80 }), 16);
  assert.equal(computeSpineMm({ pageCount: 0, paperBulkMmPer1000: 80 }), 0);
  assert.equal(computeSpineMm({}), 0);
});

test('renderCoverBuffer: MediaBox = Bleed + 2×Trim + Spine, ein Bogen', async () => {
  const cfg = defaultConfig();
  cfg.print.bleedMm = 3;
  cfg.print.cropMarks = true;
  cfg.coverSpec.pageCount = 200;
  cfg.coverSpec.paperBulkMmPer1000 = 80;
  // Klappentext kommt buch-weit (book_publication → extras.description).
  cfg.extras.description = 'Klappentext über das Buch.';
  cfg.coverSpec.spineText = 'Test';

  const buf = await renderCoverBuffer({ book, profile: { config: cfg }, frontImageBuf: null, backImageBuf: null, lang: 'de' });
  assert.ok(buf.toString('binary').startsWith('%PDF'), 'kein PDF-Header');
  assert.equal(pageCount(buf), 1, 'Umschlag muss genau ein Bogen sein');

  const [trimW, trimH] = _pageSize(cfg.layout);
  const bleedPt = 3 * MM_TO_PT;
  const spinePt = 16 * MM_TO_PT;
  const box = mediaBox(buf);
  assert.ok(box, 'MediaBox fehlt');
  const expectedW = bleedPt + trimW + spinePt + trimW + bleedPt;
  const expectedH = bleedPt + trimH + bleedPt;
  assert.ok(Math.abs(box[2] - expectedW) < 1, `Bogenbreite ${box[2]} ≠ ${expectedW}`);
  assert.ok(Math.abs(box[3] - expectedH) < 1, `Bogenhöhe ${box[3]} ≠ ${expectedH}`);
  assert.match(buf.toString('binary'), /\/TrimBox/, 'TrimBox fehlt');
});

test('renderCoverBuffer: ohne Bleed kein TrimBox-Eintrag', async () => {
  const cfg = defaultConfig();
  cfg.print.bleedMm = 0;
  cfg.coverSpec.pageCount = 100;
  cfg.coverSpec.paperBulkMmPer1000 = 70;
  const buf = await renderCoverBuffer({ book, profile: { config: cfg }, frontImageBuf: null, backImageBuf: null, lang: 'de' });
  assert.equal(pageCount(buf), 1);
  assert.doesNotMatch(buf.toString('binary'), /\/TrimBox/);
});
