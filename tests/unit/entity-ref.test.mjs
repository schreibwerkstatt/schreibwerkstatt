// Entitäts-Referenz: Auflösung Spec → Darstellungs-Modell.
//
// Warum getestet: die Komponente ist die einzige Stelle, die Label, Typ-Präfix
// und Sprungziel einer Referenz festlegt. Ein Fehler hier zeigt sich in jeder
// Liste gleichzeitig — oder, schlimmer, als Klick, der still nichts tut.

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveEntityRef, canonicalType, TYPES } from '../../public/js/entity-ref.js';

function fakeApp() {
  const calls = [];
  const tree = [
    { type: 'chapter', id: 10, name: 'Ankunft', solo: false, pages: [{ id: 1 }, { id: 2 }] },
    { type: 'chapter', id: 11, name: 'Solo', solo: true, pages: [{ id: 3 }] },
  ];
  const pages = [
    { id: 1, name: 'Bahnhof', chapter_id: 10 },
    { id: 2, name: 'Hotel', chapter_id: 10 },
    { id: 3, name: 'Solo', chapter_id: 11 },
  ];
  return {
    calls,
    t: (k) => `T:${k}`,
    $store: { nav: { tree, pages } },
    figurenById: new Map([[5, { id: 5, name: 'Anna Berger', kurzname: 'Anna' }]]),
    orteById: new Map([[7, { id: 7, name: 'Zürich' }]]),
    szenenById: new Map([[9, { id: 9, titel: 'Streit' }]]),
    _resolvePage: (k, s) => pages.find(p => p.name === s) || null,
    openChapterById: (id) => calls.push(['chapter', id]),
    selectPage: (p) => calls.push(['page', p.id]),
    openFigurById: (id) => calls.push(['figur', id]),
    openOrtById: (id) => calls.push(['ort', id]),
    openSzeneById: (id) => calls.push(['szene', id]),
    openWerkstattDraftById: (id) => calls.push(['werkstatt', id]),
    openMotifById: (id) => calls.push(['motiv', id]),
    openEreignisById: (id) => calls.push(['ereignis', id]),
  };
}

test('Figur: Kurzname als Label, voller Name als Tooltip, Klick öffnet die Figur', () => {
  const app = fakeApp();
  const m = resolveEntityRef({ type: 'figur', id: 5 }, app);
  assert.equal(m.type, 'figur');
  assert.equal(m.kind, 'T:entityRef.kind.figur');
  assert.equal(m.label, 'Anna');
  assert.equal(m.title, 'Anna Berger');
  m.open();
  assert.deepEqual(app.calls, [['figur', 5]]);
});

test('Kapitel per Name führt zur Kapitel-Navigation mit aufgelöster ID', () => {
  const app = fakeApp();
  const m = resolveEntityRef({ type: 'kapitel', name: 'ankunft' }, app);
  assert.equal(m.label, 'Ankunft');
  m.open();
  assert.deepEqual(app.calls, [['chapter', 10]]);
});

test('unauflösbarer Name: Rohtext, nicht klickbar', () => {
  const m = resolveEntityRef({ type: 'kapitel', name: 'Gibt es nicht' }, fakeApp());
  assert.equal(m.label, 'Gibt es nicht');
  assert.equal(m.resolved, false);
  assert.equal(m.clickable, false);
  assert.equal(m.open, null);
});

test('Seite: Tooltip „Kapitel › Seite", Solo-Kapitel ohne Präfix', () => {
  const app = fakeApp();
  assert.equal(resolveEntityRef({ type: 'seite', id: 2 }, app).title, 'Ankunft › Hotel');
  assert.equal(resolveEntityRef({ type: 'seite', id: 3 }, app).title, null);
  const m = resolveEntityRef({ type: 'seite', name: 'Bahnhof', kapitel: 'Ankunft' }, app);
  m.open();
  assert.deepEqual(app.calls, [['page', 1]]);
});

test('englische Verknüpfungs-Kinds werden auf kanonische Typen abgebildet', () => {
  assert.equal(canonicalType('figure'), 'figur');
  assert.equal(canonicalType('chapter'), 'kapitel');
  assert.equal(canonicalType('location'), 'ort');
  assert.equal(canonicalType('thread'), 'strang');
  assert.equal(canonicalType('gibtsnicht'), null);
  const app = fakeApp();
  const m = resolveEntityRef({ type: 'location', id: 7 }, app);
  assert.equal(m.type, 'ort');
  assert.equal(m.label, 'Zürich');
});

test('static: Label ja, Klick nein', () => {
  const m = resolveEntityRef({ type: 'figur', id: 5, static: true }, fakeApp());
  assert.equal(m.label, 'Anna');
  assert.equal(m.clickable, false);
});

test('onOpen ersetzt die Navigation; count ab 2', () => {
  const app = fakeApp();
  let hit = 0;
  const m = resolveEntityRef({ type: 'kapitel', name: 'Ankunft', count: 3, onOpen: () => { hit++; } }, app);
  m.open();
  assert.equal(hit, 1);
  assert.equal(app.calls.length, 0);
  assert.equal(m.count, 3);
  assert.equal(resolveEntityRef({ type: 'kapitel', name: 'Ankunft', count: 1 }, app).count, null);
});

test('Typen ohne Frontend-Katalog: Label aus dem Aufrufer, sonst #id', () => {
  const app = fakeApp();
  assert.equal(resolveEntityRef({ type: 'werkstatt', id: 4, label: 'Entwurf A' }, app).label, 'Entwurf A');
  assert.equal(resolveEntityRef({ type: 'motiv', id: 8 }, app).label, '#8');
  assert.equal(resolveEntityRef({ type: 'motiv' }, app).clickable, false);
});

test('jeder Typ hat eine Sprung-Aktion', () => {
  for (const [k, def] of Object.entries(TYPES)) {
    assert.equal(typeof def.open, 'function', k);
  }
});

test('Katalog-Lookup: öffentliche String-Kennung und Zahl als String', () => {
  const app = fakeApp();
  app.figurenById = new Map([['fig_1', { id: 'fig_1', name: 'Gregor' }], [5, { id: 5, name: 'Anna' }]]);
  assert.equal(resolveEntityRef({ type: 'figur', id: 'fig_1' }, app).label, 'Gregor');
  assert.equal(resolveEntityRef({ type: 'figur', id: '5' }, app).label, 'Anna');
  assert.equal(resolveEntityRef({ type: 'figur', id: 'fig_9' }, app).resolved, false);
});
