// Renderer-Tests (String-Assertions, kein DOM). Sichert v.a. die Escaping-
// Invariante: Namen escaped, html verbatim (data-bid bleibt).

import test from 'node:test';
import assert from 'node:assert/strict';

const { renderStreamHtml } = await import('../../public/js/manuscript-render.js');
const { fromGroups } = await import('../../public/js/manuscript-stream.js');

const BOOK = [
  { kind: 'chapter', name: 'K1', depth: 0, key: 'c0', chapterId: 10 },
  { kind: 'page', name: 'Seite A', html: '<p data-bid="abc123">Text</p>', depth: 0, key: 'p1', id: 1, chapterId: 10 },
  { kind: 'page', name: 'Seite B', html: '<p>b</p>', depth: 0, key: 'p3', id: 3, chapterId: 10 },
  { kind: 'page', name: 'Solo', html: '<p>x</p>', depth: 0, key: 'p2', id: 2, chapterId: null },
];

test('Anchor-Nummerierung sec1..N über Kapitel + Seiten', () => {
  const { html, toc } = renderStreamHtml(BOOK);
  assert.equal(toc.map(t => t.anchor).join(','), 'sec1,sec2,sec3,sec4');
  assert.match(html, /id="sec1"/);
  assert.match(html, /id="sec2"/);
  assert.match(html, /id="sec4"/);
});

test('TOC-Level: Kapitel=1, Seite-mit-chapterId=2, Solo-Seite=1', () => {
  const { toc } = renderStreamHtml(BOOK);
  assert.deepEqual(toc.map(t => t.level), [1, 2, 2, 1]);
  assert.deepEqual(toc.map(t => t.label), ['K1', 'Seite A', 'Seite B', 'Solo']);
});

test('Body verbatim: data-bid + Markup bleiben unangetastet (kein Doppel-Escape)', () => {
  const { html } = renderStreamHtml(BOOK);
  assert.ok(html.includes('<p data-bid="abc123">Text</p>'), 'page html muss roh durchgereicht werden');
  assert.ok(!html.includes('&lt;p data-bid'), 'html darf nicht escaped sein');
});

test('Namen escaped: < im Kapitel-/Seitennamen wird &lt;', () => {
  const { html } = renderStreamHtml([
    { kind: 'chapter', name: '<script>', depth: 0, key: 'c0', chapterId: 5 },
    { kind: 'page', name: 'a & b "c"', html: '<p>ok</p>', depth: 0, key: 'p1', id: 1, chapterId: 5 },
    { kind: 'page', name: 'zwei', html: '<p>ok</p>', depth: 0, key: 'p2', id: 2, chapterId: 5 },
  ]);
  assert.ok(html.includes('&lt;script&gt;'), 'Kapitelname muss escaped sein');
  assert.ok(!html.includes('<script>'), 'roher script-Name verboten');
  assert.ok(html.includes('a &amp; b &quot;c&quot;'), 'Seitenname escaped');
});

test('Default-Klassen + Tags (Buch-Share): chapter h2, page h3, neutrale ms-* Klassen', () => {
  const { html } = renderStreamHtml(BOOK);
  assert.match(html, /<h2 id="sec1" class="ms-chapter">K1<\/h2>/);
  assert.match(html, /<section class="ms-page">/);
  assert.match(html, /<h3 id="sec2" class="ms-page__title">Seite A<\/h3>/);
  assert.match(html, /<div class="ms-page__body"><p data-bid="abc123">Text<\/p><\/div>/);
});

test('omitChapterId (Kapitel-Share): kein Heading fuer das Wurzel-Kapitel, Seiten h2 + Level 1', () => {
  const { html, toc } = renderStreamHtml(BOOK, { pageTag: 'h2', omitChapterId: 10 });
  assert.ok(!html.includes('ms-chapter'), 'kein Kapitel-Heading');
  assert.match(html, /<h2 id="sec1" class="ms-page__title">Seite A<\/h2>/);
  assert.deepEqual(toc.map(t => t.level), [1, 1, 1]);
  assert.deepEqual(toc.map(t => t.anchor), ['sec1', 'sec2', 'sec3']);  // Kapitel verbraucht keinen Anchor
});

test('opts-Klassen-Swap: Konsument kann eigene Klassen erzwingen', () => {
  const { html } = renderStreamHtml(BOOK, {
    chapterClass: 'x-chap', pageSectionClass: 'x-page', pageTitleClass: 'x-title', pageBodyClass: 'x-body',
  });
  assert.match(html, /class="x-chap"/);
  assert.match(html, /<section class="x-page">/);
  assert.match(html, /class="x-title"/);
  assert.match(html, /class="x-body"/);
});

test('Integration mit fromGroups: groups → Modell → HTML', () => {
  const groups = [
    { chapterId: 10, chapter: { id: 10, name: 'Kap' }, pages: [
      { pd: { id: 1, name: 'P', html: '<p>hi</p>' } }, { pd: { id: 2, name: 'Q', html: '<p>du</p>' } },
    ] },
  ];
  const { html, toc } = renderStreamHtml(fromGroups(groups));
  assert.match(html, /Kap<\/h2>/);
  assert.match(html, /<p>hi<\/p>/);
  assert.deepEqual(toc.map(t => t.level), [1, 2, 2]);
});

test('leeres Input → leeres html + leere toc', () => {
  assert.deepEqual(renderStreamHtml([]), { html: '', toc: [] });
  assert.deepEqual(renderStreamHtml(null), { html: '', toc: [] });
});

test('Erster Abschnitt gleichnamig mit Kapitel: keine zweite Ueberschrift, kein TOC-Eintrag', () => {
  const { html, toc } = renderStreamHtml([
    { kind: 'chapter', name: 'Kapitel 3', depth: 0, key: 'c0', chapterId: 7 },
    { kind: 'page', name: '  kapitel   3 ', html: '<p data-bid="b1">Text</p>', depth: 0, key: 'p1', id: 1, chapterId: 7 },
    { kind: 'page', name: 'Kapitel 3', html: '<p>zwei</p>', depth: 0, key: 'p2', id: 2, chapterId: 7 },
  ]);
  assert.equal((html.match(/ms-page__title/g) || []).length, 1, 'nur der zweite Abschnitt traegt einen Titel');
  assert.ok(html.includes('<p data-bid="b1">Text</p>'), 'Text des ersten Abschnitts bleibt');
  assert.deepEqual(toc.map(t => t.label), ['Kapitel 3', 'Kapitel 3']);
  assert.deepEqual(toc.map(t => t.level), [1, 2]);
});

test('Kapitel-Share: gleichnamiger erster Abschnitt verdoppelt den h1-Kopf nicht', () => {
  const { html, toc } = renderStreamHtml([
    { kind: 'chapter', name: 'Kap', depth: 0, key: 'c0', chapterId: 7 },
    { kind: 'page', name: 'Kap', html: '<p>x</p>', depth: 0, key: 'p1', id: 1, chapterId: 7 },
  ], { pageTag: 'h2', omitChapterId: 7 });
  assert.ok(!html.includes('ms-page__title'));
  assert.equal(toc.length, 0);
});

test('Abweichender Name im Mehr-Abschnitt-Kapitel und Beitrag mit Schlagzeile behalten ihre Ueberschrift', () => {
  const { html } = renderStreamHtml([
    { kind: 'chapter', name: 'Kap', depth: 0, key: 'c0', chapterId: 7 },
    { kind: 'page', name: 'Kap', html: '<p>x</p>', depth: 0, key: 'p1', id: 1, chapterId: 7, article: true },
    { kind: 'chapter', name: 'Kap2', depth: 0, key: 'c1', chapterId: 8 },
    { kind: 'page', name: 'Szene', html: '<p>y</p>', depth: 0, key: 'p2', id: 2, chapterId: 8 },
    { kind: 'page', name: 'Szene 2', html: '<p>z</p>', depth: 0, key: 'p3', id: 3, chapterId: 8 },
  ]);
  assert.equal((html.match(/<h3 /g) || []).length, 3);
});

test('Einziger Abschnitt eines Kapitels: keine eigene Ueberschrift, auch bei abweichendem Namen', () => {
  const { html, toc } = renderStreamHtml([
    { kind: 'chapter', name: 'Kapitel 2: Das erste Date', depth: 0, key: 'c0', chapterId: 7 },
    { kind: 'page', name: 'Kapitel 2', html: '<p data-bid="b1">Text</p>', depth: 0, key: 'p1', id: 1, chapterId: 7 },
  ]);
  assert.ok(!html.includes('ms-page__title'));
  assert.ok(html.includes('<p data-bid="b1">Text</p>'));
  assert.deepEqual(toc.map(t => t.label), ['Kapitel 2: Das erste Date']);
});

test('Unterkapitel: Tiefen-Klasse + Verzeichnis-Ebene aus depth', () => {
  const { html, toc } = renderStreamHtml(fromGroups([
    { chapterId: 1, chapter: { id: 1, name: 'Teil I', parent_chapter_id: null }, pages: [] },
    { chapterId: 2, chapter: { id: 2, name: 'Kapitel 1', parent_chapter_id: 1 }, pages: [
      { pd: { id: 9, name: 'Szene', html: '<p>x</p>' } }, { pd: { id: 10, name: 'Szene 2', html: '<p>y</p>' } },
    ] },
  ]));
  assert.match(html, /<h2 id="sec1" class="ms-chapter">Teil I<\/h2>/);
  assert.match(html, /<h2 id="sec2" class="ms-chapter ms-chapter--d1">Kapitel 1<\/h2>/);
  assert.deepEqual(toc.map(t => t.level), [1, 2, 3, 3]);
});

test('Kapitel-Share mit Unterkapiteln: nur das Wurzel-Kapitel entfaellt, Unterkapitel bleiben', () => {
  const { html, toc } = renderStreamHtml(fromGroups([
    { chapterId: 1, chapter: { id: 1, name: 'Teil I', parent_chapter_id: null }, pages: [
      { pd: { id: 8, name: 'Vorwort', html: '<p>v</p>' } }, { pd: { id: 7, name: 'Motto', html: '<p>m</p>' } },
    ] },
    { chapterId: 2, chapter: { id: 2, name: 'Kapitel 1', parent_chapter_id: 1 }, pages: [
      { pd: { id: 9, name: 'Szene', html: '<p>x</p>' } }, { pd: { id: 10, name: 'Szene 2', html: '<p>y</p>' } },
    ] },
  ]), { pageTag: 'h2', omitChapterId: 1 });
  assert.ok(!html.includes('>Teil I<'));
  assert.match(html, />Kapitel 1<\/h2>/);
  assert.deepEqual(toc.map(t => [t.label, t.level]),
    [['Vorwort', 1], ['Motto', 1], ['Kapitel 1', 1], ['Szene', 2], ['Szene 2', 2]]);
});
