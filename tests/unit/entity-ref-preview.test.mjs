// Hover-Vorschau der Entitäts-Referenz: Zielobjekt + Kataloge → Anzeigemodell.
//
// Warum getestet: die Vorschau setzt Daten aus mehreren Katalogen zusammen
// (Figuren einer Szene, Szenen einer Seite, Figuren eines Kapitels nach
// Häufigkeit dort). Ein falscher Join zeigt still die falschen Namen — in jeder
// Liste, in der eine Referenz steht.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEntityPreview } from '../../public/js/entity-ref-preview.js';
import { resolveEntityRef } from '../../public/js/entity-ref.js';

function fakeApp() {
  const figuren = [
    { id: 'fig_1', name: 'Anna Berger', kurzname: 'Anna', typ: 'hauptfigur', beruf: 'Ärztin',
      beschreibung: 'Kehrt nach Zürich zurück.', rolle: 'Erzählerin',
      kapitel: [{ chapter_id: 10, name: 'Ankunft', haeufigkeit: 2 }],
      eigenschaften: ['stur', 'klug', 'müde', 'laut', 'leise'] },
    { id: 'fig_2', name: 'Paul Meier', kurzname: '', typ: 'nebenfigur',
      kapitel: [{ chapter_id: 10, name: 'Ankunft', haeufigkeit: 5 }] },
    { id: 'fig_3', name: 'Alt', stale: true, kapitel: [{ chapter_id: 10, name: 'Ankunft', haeufigkeit: 9 }] },
  ];
  const szenen = [
    { id: 1, titel: 'Streit', kapitel: 'Ankunft', seite: 'Bahnhof', wertung: 'stark',
      kommentar: 'Gut gebaut.', chapter_id: 10, page_id: 1, fig_ids: ['fig_1', 'fig_2'], ort_ids: ['loc_1'] },
    { id: 2, titel: 'Abschied', chapter_id: 10, page_id: 2, fig_ids: ['fig_2'], ort_ids: [] },
    { id: 3, titel: 'Weg', chapter_id: 10, page_id: 1, stale: true, fig_ids: ['fig_3'] },
  ];
  const orte = [{ id: 'loc_1', name: 'Zürich HB', typ: 'Bahnhof', land: 'CH', stimmung: 'hektisch',
    figuren: ['fig_1'], kapitel: [{ chapter_id: 10, name: 'Ankunft' }] }];
  const tree = [
    { type: 'chapter', id: 9, name: 'Teil I', solo: false, pages: [] },
    { type: 'chapter', id: 10, name: 'Ankunft', parent_id: 9, solo: false,
      pages: [{ id: 1, name: 'Bahnhof' }, { id: 2, name: 'Hotel' }],
      stats: { words: 1200, chars: 3000 } },
  ];
  const pages = [
    { id: 1, name: 'Bahnhof', chapter_id: 10, chapterName: 'Ankunft', preview_text: '' },
    { id: 2, name: 'Hotel', chapter_id: 10, chapterName: 'Ankunft', preview_text: 'Das Zimmer war kalt.' },
  ];
  return {
    t: (k, p) => (p ? `${k}${JSON.stringify(p)}` : k),
    $store: { nav: { tree, pages }, catalog: { figuren, szenen, orte }, shell: { uiLocale: 'de' } },
    figurenById: new Map(figuren.map(f => [f.id, f])),
    orteById: new Map(orte.map(o => [o.id, o])),
    szenenById: new Map(szenen.map(s => [s.id, s])),
    tokEsts: { 1: { words: 400, chars: 1500 } },
    pageStatusTooltip: () => ['Noch kein Lektorat'],
    figurJahrLabel: () => '',
  };
}

const rowsOf = (m) => Object.fromEntries(m.rows.map(r => [r.label, r.value]));

test('Figur: voller Name, Typ/Beruf als Meta, Beschreibung, Eigenschaften gekürzt', () => {
  const app = fakeApp();
  const m = buildEntityPreview('figur', app.figurenById.get('fig_1'), app);
  assert.equal(m.title, 'Anna Berger');
  assert.deepEqual(m.meta, ['figuren.type.hauptfigur', 'Ärztin']);
  assert.equal(m.text, 'Kehrt nach Zürich zurück.');
  const r = rowsOf(m);
  assert.equal(r['entityRef.preview.role'], 'Erzählerin');
  assert.equal(r['entityRef.preview.chapters'], 'Ankunft');
  assert.equal(r['entityRef.preview.traits'], 'stur, klug, müde, laut entityRef.preview.more{"n":1}');
});

test('Figur ohne Analyse-Daten: keine leeren Zeilen', () => {
  const app = fakeApp();
  const m = buildEntityPreview('figur', { id: 'x', name: 'Neu' }, app);
  assert.deepEqual(m.rows, []);
  assert.deepEqual(m.meta, []);
  assert.equal(m.text, '');
});

test('Szene: Stelle + Wertung als Meta, Figuren und Orte aus den Katalogen', () => {
  const app = fakeApp();
  const m = buildEntityPreview('szene', app.szenenById.get(1), app);
  assert.deepEqual(m.meta, ['Ankunft › Bahnhof', 'szenen.rating.stark']);
  const r = rowsOf(m);
  assert.equal(r['entityRef.preview.figures'], 'Anna, Paul Meier');
  assert.equal(r['entityRef.preview.places'], 'Zürich HB');
});

test('Ort: Figuren-IDs werden zu Namen aufgelöst', () => {
  const app = fakeApp();
  const m = buildEntityPreview('ort', app.orteById.get('loc_1'), app);
  assert.deepEqual(m.meta, ['Bahnhof', 'CH']);
  assert.equal(rowsOf(m)['entityRef.preview.figures'], 'Anna');
  assert.equal(rowsOf(m)['entityRef.preview.mood'], 'hektisch');
});

test('Kapitel: Elternkapitel, Szenen ohne veraltete, Figuren nach Häufigkeit im Kapitel', () => {
  const app = fakeApp();
  const m = buildEntityPreview('kapitel', app.$store.nav.tree[1], app);
  assert.deepEqual(m.meta, ['entityRef.preview.inChapter{"name":"Teil I"}']);
  const r = rowsOf(m);
  assert.equal(r['entityRef.preview.figures'], 'Paul Meier, Anna');
  assert.equal(r['entityRef.preview.scenes'], '2 · Streit, Abschied');
  assert.equal(r['entityRef.preview.pages'], 'Bahnhof, Hotel');
  assert.match(r['entityRef.preview.size'], /pageCount\{"n":2\}/);
  // Auszug aus der ersten Seite MIT Text (Seite 1 ist leer).
  assert.equal(m.text, 'Das Zimmer war kalt.');
});

test('Seite: Umfang, Lektorat-Stand, Szenen und deren Figuren auf genau dieser Seite', () => {
  const app = fakeApp();
  const m = buildEntityPreview('seite', app.$store.nav.pages[0], app);
  const r = rowsOf(m);
  assert.equal(r['entityRef.preview.status'], 'Noch kein Lektorat');
  assert.equal(r['entityRef.preview.scenes'], '1 · Streit');
  assert.equal(r['entityRef.preview.figures'], 'Anna, Paul Meier');
  assert.match(r['entityRef.preview.size'], /"words":"400"/);
  assert.equal(buildEntityPreview('seite', app.$store.nav.pages[1], app).text, 'Das Zimmer war kalt.');
});

test('Referenz-Modell: Vorschau nur bei Katalog-Typ mit aufgelöstem Ziel, abschaltbar', () => {
  const app = fakeApp();
  assert.equal(typeof resolveEntityRef({ type: 'figur', id: 'fig_1' }, app).preview, 'function');
  assert.equal(resolveEntityRef({ type: 'figur', id: 'fehlt' }, app).preview, null);
  assert.equal(resolveEntityRef({ type: 'motiv', id: 3, label: 'Wasser' }, app).preview, null);
  assert.equal(resolveEntityRef({ type: 'figur', id: 'fig_1', preview: false }, app).preview, null);
  assert.equal(resolveEntityRef({ type: 'figur', id: 'fig_1' }, app).preview().title, 'Anna Berger');
});

test('Geometrie: align start verankert links am Trigger, end (Default) rechts', async () => {
  globalThis.window = { innerWidth: 1000, innerHeight: 800 };
  const { computePopoverPos } = await import('../../public/js/popover-anchor.js');
  const r = { left: 300, right: 400, top: 100, bottom: 120 };
  assert.equal(computePopoverPos(r, 250, 100, { align: 'start' }).left, 300);
  assert.equal(computePopoverPos(r, 250, 100).left, 150);
  // Rechter Rand: auch linksbündig nie aus dem Viewport.
  assert.equal(computePopoverPos({ ...r, left: 900, right: 990 }, 250, 100, { align: 'start' }).left, 742);
});
