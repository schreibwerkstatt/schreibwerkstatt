// Ein Kapitel ist sein ganzer Teilbaum: ein Kapitel ohne eigenen Abschnitt
// («Teil I», Text erst in den Unterkapiteln) darf in keinem Ausgabeweg
// verschwinden, und die Tiefe der Unterkapitel folgt der vollen Elternkette.
// Deckt lib/load-contents.js (Ueberschriften-Gruppen, Kapitel-Scope),
// lib/snapshot-export.js, die PDF-Koaleszenz + Nummerierung und die
// Format-Builder (HTML/MD/DOCX/EPUB/PDF) ab.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import JSZip from 'jszip';

process.env.DB_PATH = path.join('/tmp', `chapter-subtree-${process.pid}-${Date.now()}.db`);
await import('../../db/schema.js');

const require_ = createRequire(import.meta.url);
const csKey = require_.resolve('../../lib/content-store');
const lcKey = require_.resolve('../../lib/load-contents.js');

// Buch: Vorrede (ohne Kapitel) · Teil I (kein eigener Abschnitt)
//   › Kapitel 1 (Abschnitt) › Szene 1.1 (Abschnitt) · Kapitel 2 (Abschnitt)
// · Teil II (eigener Abschnitt) · Leer (gar kein Text im Teilbaum).
const CHAPTERS = [
  { id: 1, book_id: 7, name: 'Teil I', position: 0, parent_chapter_id: null },
  { id: 2, book_id: 7, name: 'Kapitel 1', position: 1, parent_chapter_id: 1 },
  { id: 3, book_id: 7, name: 'Szene 1.1', position: 2, parent_chapter_id: 2 },
  { id: 4, book_id: 7, name: 'Kapitel 2', position: 3, parent_chapter_id: 1 },
  { id: 5, book_id: 7, name: 'Teil II', position: 4, parent_chapter_id: null },
  { id: 6, book_id: 7, name: 'Leer', position: 5, parent_chapter_id: null },
];
const PAGES = [
  { id: 100, chapter_id: null, name: 'Vorrede', position: 0 },
  { id: 101, chapter_id: 2, name: 'A', position: 0 },
  { id: 102, chapter_id: 3, name: 'B', position: 0 },
  { id: 103, chapter_id: 4, name: 'C', position: 0 },
  { id: 104, chapter_id: 5, name: 'D', position: 0 },
];

function installStore({ chapters = CHAPTERS, pages = PAGES } = {}) {
  const store = {
    loadBook: async (id) => ({ id, name: 'Buch', slug: 'buch' }),
    listChapters: async () => chapters,
    listPages: async () => pages,
    loadChapter: async (id) => chapters.find(c => c.id === id) || null,
    loadPage: async () => null,
    loadPagesBatch: async (metas) => metas.map(m => ({ ...m, html: `<p>Text ${m.name}</p>` })),
  };
  require_.cache[csKey] = { id: csKey, filename: csKey, loaded: true, exports: store };
  delete require_.cache[lcKey];
  return require_('../../lib/load-contents.js');
}

const shape = (groups) => groups.map(g => [g.chapter ? g.chapter.name : null, g.pages.map(x => x.p.name)]);

// ── load-contents ────────────────────────────────────────────────────────────
test('scope=book: Teil ohne eigenen Abschnitt bekommt eine Ueberschriften-Gruppe', async () => {
  const { loadContents } = installStore();
  const out = await loadContents({ scope: 'book', id: 7 }, {});
  assert.deepEqual(shape(out.groups), [
    [null, ['Vorrede']],
    ['Teil I', []],
    ['Kapitel 1', ['A']],
    ['Szene 1.1', ['B']],
    ['Kapitel 2', ['C']],
    ['Teil II', ['D']],
  ]);
});

test('scope=chapter: Teil exportiert seinen Teilbaum (Default), ohne Vorfahren darueber', async () => {
  const { loadContents } = installStore();
  const out = await loadContents({ scope: 'chapter', id: 1 }, {});
  assert.deepEqual(shape(out.groups), [
    ['Teil I', []], ['Kapitel 1', ['A']], ['Szene 1.1', ['B']], ['Kapitel 2', ['C']],
  ]);
  const sub = await loadContents({ scope: 'chapter', id: 2 }, {});
  assert.deepEqual(shape(sub.groups), [['Kapitel 1', ['A']], ['Szene 1.1', ['B']]]);
});

test('scope=chapter ohne Unterkapitel: Teil ohne eigenen Abschnitt → CHAPTER_EMPTY', async () => {
  const { loadContents } = installStore();
  await assert.rejects(() => loadContents({ scope: 'chapter', id: 1, includeSubchapters: false }, {}), /CHAPTER_EMPTY/);
});

test('chapterScopeIds: Teilbaum ohne ausgeschlossene Unterkapitel, Wurzel bleibt', () => {
  const { chapterScopeIds } = installStore();
  const chapters = CHAPTERS.map(c => (c.id === 2 ? { ...c, excluded: true } : c));
  assert.deepEqual([...chapterScopeIds(1, chapters)].sort(), [1, 4]);
  assert.deepEqual([...chapterScopeIds(2, chapters)].sort(), [2, 3]);
  assert.deepEqual([...chapterScopeIds(1, chapters, { includeSubchapters: false })], [1]);
});

// ── Fassungs-Export ──────────────────────────────────────────────────────────
test('snapshotToBundle: Teil ohne eigenen Abschnitt → Ueberschriften-Gruppe; spaete eigene Abschnitte nach vorn', () => {
  const { snapshotToBundle } = require_('../../lib/snapshot-export.js');
  const b = snapshotToBundle({ tree: [
    { type: 'chapter', name: 'Teil I', children: [
      { type: 'chapter', name: 'Kapitel 1', children: [{ type: 'page', name: 'A', html: '<p>a</p>' }] },
    ] },
    { type: 'chapter', name: 'Teil II', children: [
      { type: 'chapter', name: 'Kapitel 3', children: [{ type: 'page', name: 'C', html: '<p>c</p>' }] },
      { type: 'page', name: 'Nachwort', html: '<p>n</p>' },
    ] },
    { type: 'chapter', name: 'Leer', children: [] },
  ] });
  assert.deepEqual(shape(b.groups), [
    ['Teil I', []], ['Kapitel 1', ['A']], ['Teil II', ['Nachwort']], ['Kapitel 3', ['C']],
  ]);
});

// ── PDF-Koaleszenz + Nummerierung ────────────────────────────────────────────
test('PDF: Teil als Kapitelblock ohne Items, Unterkapitel Tiefe 2/3, Nummern 1 · 1.1 · 1.1.1', async () => {
  const { loadContents } = installStore();
  const { groups } = await loadContents({ scope: 'book', id: 7 }, {});
  const { _coalesceGroups } = require_('../../lib/pdf-render/coalesce.js');
  const { computeChapterLabels } = require_('../../lib/pdf-render/numbering.js');
  const { defaultConfig } = require_('../../lib/pdf-export-defaults.js');
  const cfg = defaultConfig();
  cfg.chapter.numbering = 'arabic';
  cfg.chapter.numberingMode = 'nested';
  const blocks = _coalesceGroups(groups, 'nested', true, [1], []);
  const teil = blocks.find(b => b.title === 'Teil I');
  assert.deepEqual(teil.items, []);
  assert.deepEqual(blocks.filter(b => b.isChapter).map(b => [b.title, b.depth, b.unnumbered]), [
    ['Teil I', 1, true], ['Kapitel 1', 2, true], ['Szene 1.1', 3, true], ['Kapitel 2', 2, true], ['Teil II', 1, false],
  ]);
  const numbered = _coalesceGroups(groups, 'nested', true, [], []);
  const labels = computeChapterLabels(numbered, cfg, 'de');
  assert.deepEqual(numbered.map((b, i) => [b.title, labels[i].label]).filter(([, l]) => l), [
    ['Teil I', '1'], ['Kapitel 1', '1.1'], ['Szene 1.1', '1.1.1'], ['Kapitel 2', '1.2'], ['Teil II', '2'],
  ]);
});

test('PDF-Probeseiten (Kapitel): Ueberschriften der Vorfahren + erstes Kapitel mit Text', () => {
  const { sampleGroups } = require_('../../routes/jobs/pdf-export.js');
  const groups = [
    { chapterId: 1, chapter: CHAPTERS[0], pages: [] },
    { chapterId: 2, chapter: CHAPTERS[1], pages: [{ p: { id: 101 }, pd: { html: '<p>a</p>' } }] },
    { chapterId: 4, chapter: CHAPTERS[3], pages: [{ p: { id: 103 }, pd: { html: '<p>c</p>' } }] },
  ];
  assert.deepEqual(sampleGroups(groups, 'chapter').map(g => g.chapterId), [1, 2]);
});

// ── Format-Builder ───────────────────────────────────────────────────────────
async function bookBundle() {
  const { loadContents } = installStore();
  return loadContents({ scope: 'book', id: 7 }, {});
}

test('HTML/MD: Teil-Ueberschrift vorhanden, Unterkapitel eine Stufe tiefer', async () => {
  const bundle = await bookBundle();
  const { buildHtml } = require_('../../lib/export-builders/html.js');
  const { buildMd } = require_('../../lib/export-builders/md.js');
  const html = (await buildHtml(bundle)).toString('utf8');
  assert.match(html, /<h2>Teil I<\/h2>\s*<h3>Kapitel 1<\/h3>/);
  assert.match(html, /<h4>Szene 1\.1<\/h4>/);
  const md = (await buildMd(bundle)).toString('utf8');
  assert.match(md, /^## Teil I$/m);
  assert.match(md, /^### Kapitel 1$/m);
  assert.match(md, /^#### Szene 1\.1$/m);
});

test('DOCX: Teil als Heading 1, Unterkapitel als Heading 2/3', async () => {
  const bundle = await bookBundle();
  const { buildDocx } = require_('../../lib/export-builders/docx.js');
  const zip = await JSZip.loadAsync(await buildDocx(bundle));
  const xml = await zip.file('word/document.xml').async('string');
  const styleOf = (text) => {
    const para = xml.split('</w:p>').find(p => p.includes(`>${text}<`));
    return para && (para.match(/<w:pStyle w:val="([^"]+)"/) || [])[1];
  };
  assert.equal(styleOf('Teil I'), 'Heading1');
  assert.equal(styleOf('Kapitel 1'), 'Heading2');
  assert.equal(styleOf('Szene 1.1'), 'Heading3');
});

test('EPUB: Teil als eigener Eintrag mit Unterkapiteln als Ast', async () => {
  const bundle = await bookBundle();
  const { buildEpub } = require_('../../lib/export-builders/epub.js');
  const zip = await JSZip.loadAsync(await buildEpub(bundle));
  const ncxName = Object.keys(zip.files).find(n => n.endsWith('.ncx'));
  const ncx = await zip.file(ncxName).async('string');
  const teil = ncx.indexOf('Teil I');
  const kap = ncx.indexOf('Kapitel 1');
  assert.ok(teil > 0 && kap > teil, 'Teil I steht vor Kapitel 1');
  // Kapitel 1 haengt im Ast von Teil I: zwischen beiden schliesst kein navPoint.
  assert.ok(!ncx.slice(teil, kap).includes('</navPoint>'));
});

test('PDF: Buch mit Teil ohne eigenen Abschnitt rendert', async () => {
  const bundle = await bookBundle();
  const { buildPdf } = require_('../../lib/export-builders/pdf.js');
  const buf = await buildPdf(bundle, {});
  assert.equal(buf.slice(0, 4).toString('latin1'), '%PDF');
});
