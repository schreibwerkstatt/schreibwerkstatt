// Gedicht (`div.poem`) durch alle Ausgabewege: Strophen bleiben getrennt,
// Verse bleiben Zeilen, kein Erstzeilen-Einzug. Zwei Schreibweisen aus dem
// Editor — ein Absatz pro Vers (Enter, leerer Absatz = Strophe) und ein Absatz
// pro Strophe mit <br>-Versen (Shift+Enter, jeder Import).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { useTmpDb } from '../_helpers/tmp-db.js';

useTmpDb('poem-export');
await import('../../../db/schema.js');

const { parseHtmlToBlocks } = await import('../../../lib/pdf-render/html-walker.js');
const { htmlToText, buildTxt } = await import('../../../lib/export-builders/txt.js');
const { buildMd }   = await import('../../../lib/export-builders/md.js');
const { buildSubstack } = await import('../../../lib/export-builders/substack.js');
const { buildDocx } = await import('../../../lib/export-builders/docx.js');
const { buildPdf }  = await import('../../../lib/export-builders/pdf.js');
const { EPUB_CSS_BASE } = await import('../../../lib/export-builders/epub/css.js');

const STANZA_POEM = '<div class="poem"><p>Beiss nicht gleich <br>Er könnte sauer sein </p>'
  + '<p>Küss nicht jedes<br>Das kann gefährlich sein<br></p></div>';
const LINE_POEM = '<div class="poem"><p>Vers eins</p><p>Vers zwei</p><p><br></p><p>Vers drei</p></div>';

const bundleOf = (html) => ({
  scope: 'page',
  book: { id: 1, name: 'Buch', slug: 'buch' },
  page: { id: 100, name: 'Seite', slug: 's' },
  groups: [{ chapterId: null, chapter: null, pages: [{ p: { id: 100, name: 'Seite' }, pd: { html } }] }],
});

const lineTexts = (block) => block.lines.map(l => l.map(r => r.text).join(''));

test('Walker: Absatz mit <br>-Versen = Strophe → leere Zeile an jeder Absatzgrenze', () => {
  const [b] = parseHtmlToBlocks(STANZA_POEM);
  assert.equal(b.kind, 'poem');
  assert.deepEqual(lineTexts(b), ['Beiss nicht gleich', 'Er könnte sauer sein', '', 'Küss nicht jedes', 'Das kann gefährlich sein']);
});

test('Walker: ein Absatz pro Vers bleibt ohne eingeschobene Leerzeilen', () => {
  const [b] = parseHtmlToBlocks(LINE_POEM);
  assert.deepEqual(lineTexts(b), ['Vers eins', 'Vers zwei', '', 'Vers drei']);
});

test('Walker: Rand-Leerzeichen im Vers werden getrimmt, Binnen-Leerzeichen bleiben', () => {
  const [b] = parseHtmlToBlocks('<div class="poem"><p>  Apfel <em>rot </em><br>Birne</p></div>');
  assert.equal(b.lines[0].map(r => r.text).join(''), 'Apfel rot');
  assert.equal(b.lines[0][0].text, 'Apfel ');
});

test('TXT: Absätze getrennt, Strophen durch Leerzeile, Verse untereinander', () => {
  assert.equal(htmlToText('<p>Eins.</p><p>Zwei.</p>'), 'Eins.\n\nZwei.');
  assert.equal(htmlToText(`<p>Vor.</p>${STANZA_POEM}<p>Nach.</p>`),
    'Vor.\n\nBeiss nicht gleich\nEr könnte sauer sein\n\nKüss nicht jedes\nDas kann gefährlich sein\n\nNach.');
  assert.equal(htmlToText(LINE_POEM), 'Vers eins\nVers zwei\n\nVers drei');
  assert.equal(htmlToText('<ul><li>a</li><li>b</li></ul>'), 'a\nb');
});

test('TXT-Builder: Gedicht bleibt im Gesamtexport erhalten', async () => {
  const out = (await buildTxt(bundleOf(STANZA_POEM), {})).toString('utf8');
  assert.ok(out.includes('Er könnte sauer sein\n\nKüss nicht jedes'), out);
});

test('Markdown: Strophen als Absätze, Kursive ohne Leerraum vor dem Stern', async () => {
  const out = (await buildMd(bundleOf(STANZA_POEM), {})).toString('utf8');
  assert.ok(out.includes('*Beiss nicht gleich*  \n*Er könnte sauer sein*\n\n*Küss nicht jedes*'), out);
  assert.ok(!/\s\*(\s|$)/m.test(out.replace(/^\*/gm, '')), 'Leerraum vor schliessendem Stern');
});

test('Substack: jede Strophe ein eigener Absatz', async () => {
  const out = (await buildSubstack(bundleOf(STANZA_POEM), {})).toString('utf8');
  assert.ok(out.includes('<p><em>Beiss nicht gleich</em><br><em>Er könnte sauer sein</em></p><p><em>Küss nicht jedes</em>'), out);
});

test('Word: Verse eingerückt, Strophengrenze als Leerabsatz', async () => {
  const zip = await JSZip.loadAsync(await buildDocx(bundleOf(STANZA_POEM), {}));
  const xml = await zip.file('word/document.xml').async('string');
  const i = xml.indexOf('Er könnte sauer sein');
  const j = xml.indexOf('Küss nicht jedes');
  assert.ok(i > 0 && j > i);
  const between = xml.slice(i, j);
  assert.match(between, /<w:p><w:pPr>[^]*?<w:ind w:left="\d+"\/><\/w:pPr><\/w:p>/, 'Leerabsatz zwischen den Strophen fehlt');
  assert.match(xml.slice(xml.lastIndexOf('<w:p>', i), i), /<w:ind w:left="\d+"\/>/, 'Vers nicht eingerückt');
});

test('EPUB: Stylesheet setzt das Gedicht ohne Erstzeilen-Einzug', () => {
  assert.match(EPUB_CSS_BASE, /\.poem \{[^}]*font-style: italic/);
  assert.match(EPUB_CSS_BASE, /\.poem p \{[^}]*text-indent: 0/);
});

test('PDF: Gedicht über mehrere Seiten rendert ohne Fehler', async () => {
  const stanza = '<p>' + Array.from({ length: 6 }, (_, k) => `Vers ${k}`).join('<br>') + '</p>';
  const html = `<p>Vor.</p><div class="poem">${stanza.repeat(20)}</div><p>Nach.</p>`;
  const buf = await buildPdf(bundleOf(html), {});
  assert.equal(buf.subarray(0, 4).toString(), '%PDF');
});
