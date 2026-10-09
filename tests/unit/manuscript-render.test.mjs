// Renderer-Tests (String-Assertions, kein DOM). Sichert v.a. die Escaping-
// Invariante: Namen escaped, html verbatim (data-bid bleibt).

import test from 'node:test';
import assert from 'node:assert/strict';

const { renderStreamHtml } = await import('../../public/js/manuscript-render.js');
const { fromGroups } = await import('../../public/js/manuscript-stream.js');

const BOOK = [
  { kind: 'chapter', name: 'K1', depth: 0, key: 'c0', chapterId: 10 },
  { kind: 'page', name: 'Seite A', html: '<p data-bid="abc123">Text</p>', depth: 0, key: 'p1', id: 1, chapterId: 10 },
  { kind: 'page', name: 'Solo', html: '<p>x</p>', depth: 0, key: 'p2', id: 2, chapterId: null },
];

test('Anchor-Nummerierung sec1..N über Kapitel + Seiten', () => {
  const { html, toc } = renderStreamHtml(BOOK);
  assert.equal(toc.map(t => t.anchor).join(','), 'sec1,sec2,sec3');
  assert.match(html, /id="sec1"/);
  assert.match(html, /id="sec2"/);
  assert.match(html, /id="sec3"/);
});

test('TOC-Level: Kapitel=1, Seite-mit-chapterId=2, Solo-Seite=1', () => {
  const { toc } = renderStreamHtml(BOOK);
  assert.deepEqual(toc.map(t => t.level), [1, 2, 1]);
  assert.deepEqual(toc.map(t => t.label), ['K1', 'Seite A', 'Solo']);
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

test('omitChapterHeaders (Kapitel-Share): kein Kapitel-Heading, Seiten h2 + Level 1', () => {
  const { html, toc } = renderStreamHtml(BOOK, { pageTag: 'h2', omitChapterHeaders: true });
  assert.ok(!html.includes('ms-chapter'), 'kein Kapitel-Heading');
  assert.match(html, /<h2 id="sec1" class="ms-page__title">Seite A<\/h2>/);
  assert.deepEqual(toc.map(t => t.level), [1, 1]);
  assert.deepEqual(toc.map(t => t.anchor), ['sec1', 'sec2']);  // Kapitel verbraucht keinen Anchor
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
    { chapterId: 10, chapter: { id: 10, name: 'Kap' }, pages: [{ pd: { id: 1, name: 'P', html: '<p>hi</p>' } }] },
  ];
  const { html, toc } = renderStreamHtml(fromGroups(groups));
  assert.match(html, /Kap<\/h2>/);
  assert.match(html, /<p>hi<\/p>/);
  assert.deepEqual(toc.map(t => t.level), [1, 2]);
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
  ], { pageTag: 'h2', omitChapterHeaders: true });
  assert.ok(!html.includes('ms-page__title'));
  assert.equal(toc.length, 0);
});

test('Abweichender Name und Beitrag mit Schlagzeile behalten ihre Ueberschrift', () => {
  const { html } = renderStreamHtml([
    { kind: 'chapter', name: 'Kap', depth: 0, key: 'c0', chapterId: 7 },
    { kind: 'page', name: 'Kap', html: '<p>x</p>', depth: 0, key: 'p1', id: 1, chapterId: 7, article: true },
    { kind: 'chapter', name: 'Kap2', depth: 0, key: 'c1', chapterId: 8 },
    { kind: 'page', name: 'Szene', html: '<p>y</p>', depth: 0, key: 'p2', id: 2, chapterId: 8 },
  ]);
  assert.equal((html.match(/<h3 /g) || []).length, 2);
});
