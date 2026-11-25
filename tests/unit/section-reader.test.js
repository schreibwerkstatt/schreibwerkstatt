'use strict';
// Abschnitts-Leser (routes/jobs/shared/section-reader.js): ein Weg für Text +
// Struktur der Abschnitte — Absätze im Text, Buch-Scope über die Gliederung,
// Lesereihenfolge, optionale Vergleichsform.
const test = require('node:test');
const assert = require('node:assert/strict');
const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('section-reader');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';

require('../../db/migrations').runMigrations();
const { db } = require('../../db/connection');
const { readSections } = require('../../routes/jobs/shared/section-reader');

const NOW = '2026-01-01T00:00:00.000Z';
const BOOK = 94501, OTHER_BOOK = 94502;
const CH1 = 94511, CH1_SUB = 94512, CH2 = 94513;
const P1 = 945101, P_SUB = 945102, P2 = 945103, P_FOREIGN = 945199;

db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?,?,?,?)').run(BOOK, 'Buch', NOW, NOW);
db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?,?,?,?)').run(OTHER_BOOK, 'Fremd', NOW, NOW);
const ch = db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at, parent_chapter_id) VALUES (?,?,?,?,?,?)');
ch.run(CH1, BOOK, 'Erstes', 1, NOW, null);
ch.run(CH1_SUB, BOOK, 'Unter', 1, NOW, CH1);
ch.run(CH2, BOOK, 'Zweites', 2, NOW, null);
const pg = db.prepare('INSERT INTO pages (page_id, book_id, chapter_id, page_name, position, updated_at, body_html) VALUES (?,?,?,?,?,?,?)');
pg.run(P1, BOOK, CH1, 'Anfang', 1, NOW, '<p>»Komm«, sagte sie.</p><p>Er kam.</p>');
pg.run(P_SUB, BOOK, CH1_SUB, 'Mitte', 1, NOW, '<p>Unten.</p>');
pg.run(P2, BOOK, CH2, 'Ende', 1, NOW, '<p>Schluss.</p>');
pg.run(P_FOREIGN, OTHER_BOOK, null, 'Fremd', 1, NOW, '<p>Geheim.</p>');

test('pageIds: Text mit Absätzen, Struktur, Eingabe-Reihenfolge', async () => {
  const { sections, missing } = await readSections(BOOK, { pageIds: [P2, P1] });
  assert.deepEqual(missing, []);
  assert.deepEqual(sections.map(s => s.id), [P2, P1]);
  const p1 = sections[1];
  assert.equal(p1.text, '»Komm«, sagte sie.\n\nEr kam.');
  assert.equal(p1.title, 'Anfang');
  assert.equal(p1.chapterId, CH1);
  assert.equal(p1.chapterPath, 'Erstes');
  assert.equal(p1.compare, undefined);
  assert.equal(p1.html, undefined);
});

test('Buch-Scope: fremde oder unbekannte ID wird nie geladen', async () => {
  const { sections, missing } = await readSections(BOOK, { pageIds: [P_FOREIGN, 999999, P1] });
  assert.deepEqual(sections.map(s => s.id), [P1]);
  assert.deepEqual(missing.map(m => m.page_id), [P_FOREIGN, 999999]);
  assert.ok(!JSON.stringify(sections).includes('Geheim'));
});

test('chapterId: Lesereihenfolge inkl. Unterkapitel, Pfad des Unterkapitels', async () => {
  const withSub = await readSections(BOOK, { chapterId: CH1 });
  assert.deepEqual(withSub.sections.map(s => s.id), [P1, P_SUB]);
  assert.equal(withSub.sections[1].chapterPath, 'Erstes › Unter');
  assert.equal(withSub.sections[1].chapterName, 'Unter', 'direktes Kapitel, nicht der Pfad');
  assert.equal(withSub.sections[1].depth, 2);
  const noSub = await readSections(BOOK, { chapterId: CH1, includeSubchapters: false });
  assert.deepEqual(noSub.sections.map(s => s.id), [P1]);
});

test('all: ganzes Buch in Lesereihenfolge', async () => {
  const { sections } = await readSections(BOOK, { all: true });
  assert.deepEqual(sections.map(s => s.id), [P1, P_SUB, P2]);
});

test('withCompare/keepHtml: einzeilige Vergleichsform und HTML auf Wunsch', async () => {
  const { sections: [s] } = await readSections(BOOK, { pageIds: [P1], withCompare: true, keepHtml: true });
  assert.equal(s.compare, '»Komm«, sagte sie. Er kam.');
  assert.ok(s.html.startsWith('<p>'));
});

test('ohne Auswahl wirft', async () => {
  await assert.rejects(() => readSections(BOOK, {}), /pageIds, chapterId oder all/);
});
