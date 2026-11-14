// Nachrichtenverlauf: Randfälle der Ausgabewege (Ergänzung zu msg-thread.test.mjs)
// — Absender-Seite über leere Zeilen, Doppelklassen, verwaiste Absender im
// PDF, Umbrüche/Escape/Doppel-Auszeichnung in den Textwegen, leere Zeilen im
// EPUB, Bild-Zeilen im WordPress-Push, Blasenbreite und Abstand im Word-Export.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import { useTmpDb } from '../_helpers/tmp-db.js';

useTmpDb('msg-thread-edges');
await import('../../../db/schema.js');

const require = createRequire(import.meta.url);
const PDFDocument = require('pdfkit');
const { parseHtmlToBlocks } = require('../../../lib/pdf-render/html-walker.js');
const { renderMessages, messagesLeadHeight } = require('../../../lib/pdf-render/block-messages.js');
const { minLeadHeight, KEEP_LINES } = require('../../../lib/pdf-render/keep.js');
const { htmlToText } = require('../../../lib/export-builders/txt.js');
const { buildMd } = require('../../../lib/export-builders/md.js');
const { buildSubstack } = require('../../../lib/export-builders/substack.js');
const { _applyBreaks } = require('../../../lib/export-builders/epub/content.js');
const { _buildCss } = require('../../../lib/export-builders/epub/css.js');
const { buildHtml } = require('../../../lib/export-builders/html.js');
const { appToWpHtml, wpToAppHtml, wpLossyBlocks } = require('../../../lib/wp-html.js');
const { _bubbleWidthTwip } = require('../../../lib/export-builders/docx-messages.js');
const { buildDocxProfile } = require('../../../lib/export-builders/docx.js');
const { validateConfig: validateDocx } = require('../../../lib/docx-export-defaults.js');

const bundleOf = (html) => ({
  scope: 'page',
  book: { id: 1, name: 'Buch', slug: 'buch' },
  page: { id: 100, name: 'Seite', slug: 's' },
  groups: [{ chapterId: null, chapter: null, pages: [{ p: { id: 100, name: 'Seite' }, pd: { html } }] }],
});
const thread = (inner) => `<div class="msg-thread">${inner}</div>`;

// ── 1 · Walker ──────────────────────────────────────────────────────────────

test('Walker: Absender-Seite auf der vollen Zeilenfolge, leere Zeilen erst danach weg', () => {
  const lines = parseHtmlToBlocks(thread('<p class="msg-name">Tom</p><p class="msg-out"><br></p><p class="msg-in">hi</p>'))[0].lines;
  assert.deepEqual(lines.map(l => [l.kind, l.side || null]), [['name', 'out'], ['in', null]]);
});

test('Walker: zwei Zeilenklassen → die erste im class-Attribut zählt', () => {
  const a = parseHtmlToBlocks(thread('<p class="msg-out msg-name">x</p>'))[0].lines;
  const b = parseHtmlToBlocks(thread('<p class="msg-name msg-out">x</p>'))[0].lines;
  assert.equal(a[0].kind, 'out');
  assert.equal(b[0].kind, 'name');
});

// ── 2 · PDF: Absender nicht allein am Seitenfuss ────────────────────────────

function pdfDoc() {
  const doc = new PDFDocument({ size: 'A5', margin: 50, autoFirstPage: true });
  doc.registerFont('body', 'Helvetica');
  doc.registerFont('body-bold', 'Helvetica-Bold');
  doc.registerFont('body-italic', 'Helvetica-Oblique');
  doc.registerFont('body-bolditalic', 'Helvetica-BoldOblique');
  let page = 0;
  doc.on('pageAdded', () => { page++; });
  const texts = [];
  const rects = [];
  const text = doc.text.bind(doc);
  doc.text = (t, ...rest) => { texts.push({ t: String(t), page }); return text(t, ...rest); };
  const rr = doc.roundedRect.bind(doc);
  doc.roundedRect = (...a) => { rects.push(page); return rr(...a); };
  return { doc, texts, rects };
}
const pdfCtx = (style) => ({ font: { body: { sizePt: 10, lineHeight: 1.4 } }, messages: { style } });
const LONG = 'eins zwei drei vier fünf sechs sieben acht neun zehn elf zwölf dreizehn vierzehn fünfzehn sechzehn siebzehn achtzehn neunzehn zwanzig';

test('PDF (Sprechblasen): Absender wandert mit einer mehrzeiligen Blase auf die nächste Seite', async () => {
  const block = parseHtmlToBlocks(thread(`<p class="msg-name">Lena</p><p class="msg-in">${LONG}</p>`))[0];
  const { doc, texts, rects } = pdfDoc();
  const ctx = pdfCtx('bubbles');
  const lead = messagesLeadHeight(doc, block.lines, 0, ctx, true);
  // Platz für Absender + zweieinhalb Zeilen, aber nicht für die ganze Blase.
  doc.y = doc.page.maxY() - (lead - 8);
  doc.x = doc.page.margins.left;
  await renderMessages(doc, block, ctx);
  const name = texts.find(x => x.t.includes('Lena'));
  assert.equal(rects.length, 1);
  assert.equal(name.page, rects[0], 'Absender und Blase auf derselben Seite');
  doc.end();
});

test('keep.js: Überschrift vor dem Verlauf hält Absender + erste ganze Blase', async () => {
  const block = parseHtmlToBlocks(thread(`<p class="msg-name">Lena</p><p class="msg-in">${LONG}</p>`))[0];
  const { doc } = pdfDoc();
  const bub = await minLeadHeight(doc, block, pdfCtx('bubbles'));
  const plain = await minLeadHeight(doc, block, pdfCtx('plain'));
  assert.equal(bub, messagesLeadHeight(doc, block.lines, 0, pdfCtx('bubbles'), true));
  assert.ok(bub > plain, 'Blase ganz > zwei Zeilen');
  const twoLines = await minLeadHeight(doc, { kind: 'paragraph', runs: [] }, pdfCtx('plain'));
  assert.ok(plain > twoLines * 0.9 && plain < twoLines * 2, 'typografisch: Absender + zwei Zeilen');
  assert.equal(KEEP_LINES, 2);
  doc.end();
});

// ── 3–6 · Textwege ──────────────────────────────────────────────────────────

const BR = thread('<p class="msg-in">eins<br>zwei</p><p class="msg-out">drei<br>vier</p>');

test('TXT: Umbruch bleibt, Folgezeilen jeder Nachricht eingerückt', () => {
  assert.equal(htmlToText(BR), 'eins\n  zwei\n→ drei\n  vier');
});

test('TXT: Zeile nur aus &nbsp; fällt weg (kein nackter Pfeil/Doppelpunkt)', () => {
  const t = htmlToText(thread('<p class="msg-out">&nbsp;</p><p class="msg-name">&nbsp;</p><p class="msg-in">ok</p><p class="msg-out">a<br>&nbsp;</p>'));
  assert.equal(t, 'ok\n→ a');
});

test('Markdown: Umbruch + geschützter Einzug, keine Doppel-Auszeichnung, Zeilenanfang escaped', async () => {
  const md = (await buildMd(bundleOf(BR), {})).toString('utf8');
  assert.match(md, /> eins {2}\n>   zwei {2}\n> → drei {2}\n>   vier/);
  const labels = thread('<p class="msg-name"><strong>Lena</strong></p><p class="msg-meta"><em>14:32</em></p><p class="msg-in">x</p>');
  const md2 = (await buildMd(bundleOf(labels), {})).toString('utf8');
  assert.match(md2, /> \*\*Lena:\*\* {2}\n> \*14:32\*/);
  const starts = thread('<p class="msg-in">- ok</p><p class="msg-in">1. Punkt</p><p class="msg-in"># Party</p><p class="msg-in">&gt; x</p><p class="msg-in">+ x</p><p class="msg-in">2) y</p>');
  const md3 = (await buildMd(bundleOf(starts), {})).toString('utf8');
  assert.match(md3, /> \\- ok {2}\n> 1\\\. Punkt {2}\n> \\# Party {2}\n> \\> x {2}\n> \\\+ x {2}\n> 2\\\) y/);
  // Prosa bleibt unberührt.
  const prose = (await buildMd(bundleOf('<p>1. Punkt</p>'), {})).toString('utf8');
  assert.match(prose, /^1\. Punkt/m);
});

test('Substack: Umbruch + &nbsp;-Einzug, keine verschachtelte Auszeichnung', async () => {
  const sub = (await buildSubstack(bundleOf(BR), {})).toString('utf8');
  assert.match(sub, /<blockquote><p>eins<br>&nbsp;&nbsp;zwei<br>→ drei<br>&nbsp;&nbsp;vier<\/p><\/blockquote>/);
  const labels = thread('<p class="msg-name"><strong>Lena</strong></p><p class="msg-meta"><em>14:32</em></p><p class="msg-in">x</p>');
  const sub2 = (await buildSubstack(bundleOf(labels), {})).toString('utf8');
  assert.match(sub2, /<strong>Lena:<\/strong><br><em>14:32<\/em><br>x/);
});

// ── 7 · EPUB / HTML-Export ──────────────────────────────────────────────────

test('EPUB: leerer Absatz im Verlauf wird kein Szenentrenner, ausserhalb schon', () => {
  const html = `<p>a</p><p></p><p>b</p>${thread('<p class="msg-in">x</p><p class="msg-out"><br></p><p class="msg-in">y</p>')}`;
  const out = _applyBreaks(html, 'line', true);
  const inner = out.match(/<div class="msg-thread">([\s\S]*?)<\/div>/)[1];
  assert.doesNotMatch(inner, /scene-gap/);
  assert.match(out, /<p>a<\/p><p class="scene-gap">/);
});

test('EPUB + HTML-Export: Absender und Hinweis halten mit der Folgezeile', async () => {
  for (const css of [_buildCss({}), _buildCss({ epub_msg_style: 'bubbles' })]) {
    assert.match(css, /\.msg-thread p\.msg-name \{[^}]*break-after: avoid; page-break-after: avoid/);
    assert.match(css, /\.msg-thread p\.msg-meta \{[^}]*break-after: avoid; page-break-after: avoid/);
  }
  const html = (await buildHtml(bundleOf(BR), {})).toString('utf8');
  assert.match(html, /\.msg-thread p\.msg-name \{[^}]*break-after: avoid/);
  assert.match(html, /\.msg-thread p\.msg-meta \{[^}]*break-after: avoid/);
});

// ── 8 · WordPress ───────────────────────────────────────────────────────────

test('WordPress: Zeile nur mit Bild überlebt Push und Pull, leere fällt weg', async () => {
  const src = thread('<p class="msg-in">hi</p><p class="msg-out"><img src="https://x.test/a.png" alt="a"></p><p class="msg-in"><br></p>');
  const wp = await appToWpHtml(src);
  assert.deepEqual(wpLossyBlocks(wp), []);
  assert.equal((wp.match(/<!-- wp:paragraph/g) || []).length, 2);
  const back = await wpToAppHtml(wp);
  assert.match(back, /<p class="msg-out"><img src="https:\/\/x\.test\/a\.png" alt="a"><\/p>/);
});

// ── 9 · Word ────────────────────────────────────────────────────────────────

test('Word: Blasenbreite zählt CJK/Emoji geviertbreit, Emoji als ein Zeichen, fett breiter', () => {
  const w = (text, bold) => _bubbleWidthTwip([{ text, bold }], 11, 1e9);
  assert.ok(w('日本語です') > w('abcde') * 1.6, 'CJK breiter als Latein');
  assert.equal(w('👨‍👩‍👧'), w('😀'), 'ZWJ-Familie = ein Zeichen');
  assert.ok(w('abcde', true) > w('abcde'), 'fett breiter');
  assert.equal(_bubbleWidthTwip([{ text: 'a'.repeat(500) }], 11, 3000), 3000, 'gedeckelt');
});

test('Word (Sprechblasen): Abstand vor dem Verlauf auch, wenn er mit einer Nachricht beginnt', async () => {
  const config = validateDocx({ messages: { style: 'bubbles' } });
  const zip = await JSZip.loadAsync(await buildDocxProfile(bundleOf(`<p>Vor.</p>${thread('<p class="msg-in">hi</p>')}`), { config, lang: 'de' }));
  const xml = await zip.file('word/document.xml').async('string');
  const between = xml.slice(xml.indexOf('Vor.'), xml.indexOf('<w:tbl>'));
  assert.match(between, /w:line="200" w:lineRule="exact"/, 'Abstandsabsatz vor der ersten Blase');
});

test('TXT: ein inneres <div> im Verlauf schneidet ihn nicht ab', () => {
  const out = htmlToText('<div class="msg-thread"><div><p class="msg-out">a</p></div>'
    + '<p class="msg-name">Tom</p><p class="msg-in">b</p></div><p>Erz</p>');
  assert.equal(out, '→ a\nTom:\nb\n\nErz');
});
