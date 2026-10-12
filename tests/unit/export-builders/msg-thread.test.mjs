// Nachrichtenverlauf (`div.msg-thread`, Markup-SSoT public/js/messages/msg-html.js)
// durch alle Ausgabewege: Walker erkennt Zeilenarten, kein Weg verliert Text,
// Ausgehend bleibt von Eingehend unterscheidbar, die Profil-Option
// „Sprechblasen" greift in PDF, Word und EPUB.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import JSZip from 'jszip';

process.env.DB_PATH = path.join('/tmp', `msg-thread-export-${process.pid}-${Date.now()}.db`);
await import('../../../db/schema.js');

const { parseHtmlToBlocks } = await import('../../../lib/pdf-render/html-walker.js');
const { htmlToText } = await import('../../../lib/export-builders/txt.js');
const { buildMd } = await import('../../../lib/export-builders/md.js');
const { buildSubstack } = await import('../../../lib/export-builders/substack.js');
const { buildDocxProfile } = await import('../../../lib/export-builders/docx.js');
const { validateConfig: validateDocx } = await import('../../../lib/docx-export-defaults.js');
const { renderPdfBuffer } = await import('../../../lib/pdf-render.js');
const { defaultConfig: pdfDefaults, validateConfig: validatePdf } = await import('../../../lib/pdf-export-defaults.js');
const { buildEpub } = await import('../../../lib/export-builders/epub/build.js');
const { _buildCss } = await import('../../../lib/export-builders/epub/css.js');
const { validateMeta } = await import('../../../lib/publication-meta.js');

const THREAD = '<div class="msg-thread">'
  + '<p class="msg-name">Lena</p>'
  + '<p class="msg-in">bist du <em>schon</em> da?</p>'
  + '<p class="msg-out">gleich, 5 min</p>'
  + '<p><br></p>'
  + '<p class="msg-meta">Dienstag, 14:32</p>'
  + '<p>ohne Klasse</p>'
  + '</div>';
const HTML = `<p>Vor.</p>${THREAD}<p>Nach.</p>`;

const bundleOf = (html) => ({
  scope: 'page',
  book: { id: 1, name: 'Buch', slug: 'buch' },
  page: { id: 100, name: 'Seite', slug: 's' },
  groups: [{ chapterId: null, chapter: null, pages: [{ p: { id: 100, name: 'Seite' }, pd: { html } }] }],
});

test('Walker: Zeilenarten, leere Zeile fällt weg, ohne Klasse = eingehend', () => {
  const blocks = parseHtmlToBlocks(HTML);
  assert.deepEqual(blocks.map(b => b.kind), ['paragraph', 'messages', 'paragraph']);
  const lines = blocks[1].lines;
  assert.deepEqual(lines.map(l => l.kind), ['name', 'in', 'out', 'meta', 'in']);
  assert.deepEqual(lines[1].runs.map(r => r.text).join(''), 'bist du schon da?');
  assert.ok(lines[1].runs.some(r => r.italic), 'Auszeichnung bleibt');
});

test('TXT: eine Zeile pro Nachricht, Ausgehend mit Pfeil', () => {
  assert.equal(htmlToText(HTML),
    'Vor.\n\nLena:\nbist du schon da?\n→ gleich, 5 min\n[Dienstag, 14:32]\nohne Klasse\n\nNach.');
});

test('Markdown + Substack: Zitatblock, Ausgehend mit Pfeil', async () => {
  const md = (await buildMd(bundleOf(HTML), {})).toString('utf8');
  assert.match(md, /> \*\*Lena:\*\* {2}\n> bist du \*schon\* da\? {2}\n> → gleich, 5 min/);
  const sub = (await buildSubstack(bundleOf(HTML), {})).toString('utf8');
  assert.match(sub, /<blockquote><p><strong>Lena:<\/strong><br>bist du <em>schon<\/em> da\?<br>→ gleich, 5 min/);
});

async function docxXml(style) {
  const config = validateDocx({ messages: { style } });
  const zip = await JSZip.loadAsync(await buildDocxProfile(bundleOf(HTML), { config, lang: 'de' }));
  return zip.file('word/document.xml').async('string');
}

test('Word: Ausgehend rechtsbündig, Sprechblasen nur mit Option', async () => {
  const plain = await docxXml('plain');
  assert.match(plain, /<w:jc w:val="right"\/>[\s\S]*gleich, 5 min/);
  assert.ok(!/w:fill="E0E0E0"/.test(plain), 'plain ohne Schattierung');
  assert.ok(!/<w:tbl>/.test(plain), 'plain ohne Tabellen');
  const bubbles = await docxXml('bubbles');
  assert.match(bubbles, /w:fill="E0E0E0"/);
  assert.match(bubbles, /w:fill="EFEFEF"/);
  // Eine Blase je Nachricht (3 Nachrichten: in, out, ohne Klasse = in) — als
  // Absatzschattierung fasste Word Nachbarn zu EINEM Kasten zusammen.
  assert.equal((bubbles.match(/<w:tbl>/g) || []).length, 3);
  assert.match(bubbles, /<w:jc w:val="right"\/>[\s\S]*?w:fill="E0E0E0"/, 'ausgehende Blase rechts');
});

test('Profile: messages.style wird validiert, Default plain', () => {
  assert.equal(pdfDefaults().messages.style, 'plain');
  assert.equal(validatePdf({ messages: { style: 'bubbles' } }).messages.style, 'bubbles');
  assert.equal(validatePdf({ messages: { style: 'neon' } }).messages.style, 'plain');
  assert.equal(validateDocx({}).messages.style, 'plain');
  assert.equal(validateMeta({}).epub_msg_style, 'plain');
  assert.equal(validateMeta({ epub_msg_style: 'bubbles' }).epub_msg_style, 'bubbles');
});

for (const style of ['plain', 'bubbles']) {
  test(`PDF (${style}): langer Verlauf über mehrere Seiten rendert`, async () => {
    const cfg = pdfDefaults();
    cfg.cover.enabled = false;
    cfg.pdfa.enabled = false;
    cfg.messages.style = style;
    const long = '<p class="msg-in">' + 'Wort '.repeat(60) + '</p><p class="msg-out">kurz</p>';
    const html = `<p>Vor.</p><div class="msg-thread"><p class="msg-name">Lena</p>${long.repeat(25)}</div><p>Nach.</p>`;
    const buf = await renderPdfBuffer({
      book: { name: 'T' }, groups: bundleOf(html).groups, profile: { config: cfg }, coverBuf: null, token: null,
    });
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  });
}

test('EPUB: Klassen überleben den Build, Sprechblasen-CSS nur mit Option', async () => {
  const buf = await buildEpub({ ...bundleOf(HTML), scope: 'book' }, { lang: 'de', author: 'A', meta: {} });
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files).filter(n => /\.xhtml$/.test(n));
  const all = (await Promise.all(names.map(n => zip.file(n).async('string')))).join('\n');
  assert.match(all, /<div class="msg-thread">/);
  assert.match(all, /<p class="msg-out">gleich, 5 min<\/p>/);
  assert.match(_buildCss({}), /\.msg-thread p\.msg-out \{[^}]*text-align: right/);
  assert.ok(!/border-radius: 0\.6em/.test(_buildCss({})), 'plain ohne Blasen');
  // Die Ausgangs-Regel muss mindestens so spezifisch sein wie die allgemeine
  // Blasen-Regel (zwei :not()), sonst verliert sie Rand und Farbe und die
  // ausgehende Blase steht links.
  const bub = _buildCss({ epub_msg_style: 'bubbles' });
  assert.match(bub, /\.msg-thread p:not\(\.msg-name\):not\(\.msg-meta\) \{[^}]*border-radius/);
  assert.match(bub, /\.msg-thread p\.msg-out:not\(\.msg-name\):not\(\.msg-meta\) \{[^}]*margin-left: auto[^}]*background/);
});
