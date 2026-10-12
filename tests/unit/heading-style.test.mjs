// Ueberschriften-Gestaltung: SSoT lib/heading-style.js, EPUB-Markup/CSS,
// Validatoren beider Formate und die Wort-Nummerierung.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import hs from '../../lib/heading-style.js';
import epub from '../../lib/export-builders/epub.js';
import { headingHtml, ruleHtml, headingCss } from '../../lib/export-builders/epub/heading.js';
import { validateConfig, defaultConfig } from '../../lib/pdf-export-defaults.js';
import { validateMeta, defaultMeta } from '../../lib/publication-meta.js';
import layout from '../../lib/pdf-render/layout.js';

const { buildEpub, _buildCss } = epub;

test('validateHeadingStyle: Defaults, Enums, Clamping, Praefix-Text', () => {
  assert.deepEqual(hs.validateHeadingStyle(undefined), { ...hs.DEFAULTS });
  const v = hs.validateHeadingStyle({
    ruleStyle: 'diamond', ruleWeight: 'nope', numberSizePct: 300, numberPrefixText: '  Buch  ', numberTracking: 0,
  });
  assert.equal(v.ruleStyle, 'diamond');
  assert.equal(v.ruleWeight, hs.DEFAULTS.ruleWeight, 'unbekannter Wert → Default');
  assert.equal(v.numberSizePct, 100, 'geclampt');
  assert.equal(v.numberPrefixText, 'Buch');
  assert.equal(v.numberTracking, false);
  assert.equal(hs.validateHeadingStyle({ numberSizePct: 10 }).numberSizePct, 40);
});

test('PDF-Profil und EPUB-Meta haben dieselben Defaults', () => {
  const pdf = hs.fromPdfChapter(defaultConfig().chapter);
  const ep = hs.fromEpubMeta(defaultMeta());
  assert.deepEqual(pdf, ep);
  assert.deepEqual(pdf, { ...hs.DEFAULTS });
});

test('validateConfig / validateMeta tragen die Felder durch', () => {
  const c = validateConfig({ chapter: { ruleStyle: 'dotted', rulePosition: 'both', subTitleAlign: 'center', pageTitleAlign: 'center', subTitleRule: true } });
  assert.equal(c.chapter.ruleStyle, 'dotted');
  assert.equal(c.chapter.rulePosition, 'both');
  assert.equal(c.chapter.subTitleAlign, 'center');
  assert.equal(c.chapter.subTitleRule, true);
  const m = validateMeta({ epub_rule_style: 'stars', epub_number_case: 'smallcaps', epub_number_size_pct: '75', epub_sub_title_rule: 1, epub_number_prefix: 'custom', epub_number_prefix_text: 'Buch' });
  const s = hs.fromEpubMeta(m);
  assert.equal(s.ruleStyle, 'stars');
  assert.equal(s.numberCase, 'smallcaps');
  assert.equal(s.numberSizePct, 75);
  assert.equal(s.subTitleRule, true);
  assert.equal(s.numberPrefixText, 'Buch');
  assert.equal(validateMeta({ epub_rule_style: '<x>' }).epub_rule_style, 'single');
});

test('numberText: Praefix nur auf oberster Ebene, je Sprache', () => {
  const st = (o) => ({ ...hs.DEFAULTS, ...o });
  assert.equal(hs.numberText('3', 1, st({ numberPrefix: 'chapter' }), 'de'), 'Kapitel 3');
  assert.equal(hs.numberText('III', 1, st({ numberPrefix: 'part' }), 'en'), 'Part III');
  assert.equal(hs.numberText('3', 1, st({ numberPrefix: 'custom', numberPrefixText: 'Buch' }), 'de'), 'Buch 3');
  assert.equal(hs.numberText('3', 1, st({ numberPrefix: 'custom', numberPrefixText: '' }), 'de'), '3');
  assert.equal(hs.numberText('3.2', 2, st({ numberPrefix: 'chapter' }), 'de'), '3.2', 'kein Praefix am Unterkapitel');
  assert.equal(hs.numberText(null, 1, st({ numberPrefix: 'chapter' }), 'de'), null);
});

test('ruleLength: auto = kurz unter zentriertem, voll unter linksbuendigem Titel', () => {
  const st = (o) => ({ ...hs.DEFAULTS, ...o });
  assert.equal(hs.ruleLength(st({}), 'center', 300, 10), 10 * hs.SHORT_RULE_EM);
  assert.equal(hs.ruleLength(st({}), 'left', 300, 10), 300);
  assert.equal(hs.ruleLength(st({ ruleWidth: 'third' }), 'left', 300, 10), 100);
  assert.equal(hs.ruleLength(st({ ruleStyle: 'diamond', ruleWidth: 'short' }), 'center', 300, 10), 10 * hs.DIAMOND_MIN_EM);
});

test('Wort-Nummerierung: bis 99 ausgeschrieben, hierarchisch ohne Wort-Ziffer-Mix', () => {
  assert.equal(layout._chapterLabel('word', 21, 'de'), 'Einundzwanzig');
  assert.equal(layout._chapterLabel('word', 40, 'de'), 'Vierzig');
  assert.equal(layout._chapterLabel('word', 99, 'en'), 'Ninety-Nine');
  assert.equal(layout._chapterLabel('word', 100, 'de'), '100');
  assert.equal(layout._chapterLabelNested('word', [3, 2, 0], 2, 'nested', 'de'), '3.2');
  assert.equal(layout._chapterLabelNested('word', [3, 0, 0], 1, 'nested', 'de'), 'Drei');
  assert.equal(layout._chapterLabelNested('roman', [3, 2, 0], 2, 'nested', 'de'), 'III.2');
});

test('Wort-Nummerierung folgt der Buch-Region: ss in CH/LI, ß sonst', () => {
  assert.equal(layout._chapterLabel('word', 30, 'de', 'DE'), 'Dreißig');
  assert.equal(layout._chapterLabel('word', 30, 'de', null), 'Dreißig');
  assert.equal(layout._chapterLabel('word', 31, 'de', 'CH'), 'Einunddreissig');
  assert.equal(layout._chapterLabel('word', 30, 'de', 'li'), 'Dreissig');
  assert.equal(layout._chapterLabelNested('word', [35, 0, 0], 1, 'nested', 'de', 'CH'), 'Fünfunddreissig');
});

test('buildEpub reicht die Region an die Kapitelnummer durch', async () => {
  const groups = Array.from({ length: 30 }, (_, i) => ({
    chapterId: i + 1, chapter: { id: i + 1, name: `K${i + 1}` }, pages: [{ p: { name: 'S' }, pd: { html: '<p>x</p>' } }],
  }));
  const bundle = { scope: 'book', book: { id: 1, name: 'B' }, groups };
  const meta = { epub_chapter_numbering: 'word', epub_chapter_numbering_mode: 'flat' };
  const ch = await JSZip.loadAsync(await buildEpub(bundle, { lang: 'de', region: 'CH', author: 'A', meta }));
  assert.ok((await ch.file('OEBPS/entry_29.xhtml').async('string')).includes('>Dreissig</span>'));
  const de = await JSZip.loadAsync(await buildEpub(bundle, { lang: 'de', region: 'DE', author: 'A', meta }));
  assert.ok((await de.file('OEBPS/entry_29.xhtml').async('string')).includes('>Drei&#xDF;ig</span>'), 'ß bleibt (als XML-Zeichenreferenz)');
});

test('EPUB ruleHtml: Linie als hr, Ornament als div, Ausrichtung + Lage', () => {
  const st = (o) => ({ ...hs.DEFAULTS, ...o });
  assert.match(ruleHtml(st({}), 'center'), /^<hr class="epub-rule epub-rule--center epub-rule--len-short" aria-hidden="true" \/>$/);
  assert.match(ruleHtml(st({}), 'left', 'above'), /epub-rule--left epub-rule--above epub-rule--len-full/);
  for (const orn of ['stars', 'asterism', 'diamond', 'dots']) {
    assert.match(ruleHtml(st({ ruleStyle: orn }), 'center'), new RegExp(`^<div class="epub-orn epub-orn--${orn} epub-orn--center`));
  }
});

test('EPUB headingHtml: Linie ueber/unter, Nummer mit Praefix', () => {
  const style = { ...hs.DEFAULTS, rulePosition: 'both' };
  const h = headingHtml({ tag: 'h1', name: 'A & B', numberText: 'Kapitel 1', style, align: 'center', withRule: true });
  assert.ok(h.startsWith('<hr class="epub-rule'), 'Linie oben');
  assert.ok(h.endsWith('aria-hidden="true" />'), 'Linie unten');
  assert.ok(h.includes('<span class="epub-chapter-num">Kapitel 1</span>'));
  assert.ok(h.includes('A &amp; B'));
  const plain = headingHtml({ tag: 'h2', name: 'X', numberText: null, style: hs.DEFAULTS, align: 'left', withRule: false });
  assert.equal(plain, '<h2>X</h2>');
});

test('EPUB-CSS: Linienart, Staerke, Nummern-Groesse und -Schreibung', () => {
  const css = headingCss({ ...hs.DEFAULTS, ruleStyle: 'double', ruleWeight: 'medium', numberCase: 'smallcaps', numberSizePct: 50, numberTracking: false }, 'normal');
  assert.match(css, /hr\.epub-rule \{[^}]*border-bottom: 4\.5pt double currentColor/);
  assert.match(css, /\.epub-chapter-num \{ font-size: 0\.4em; letter-spacing: normal; text-transform: uppercase; \}/);
  assert.match(_buildCss({ epub_rule_style: 'dashed' }), /border-bottom: 1pt dashed/);
  assert.match(_buildCss({ epub_heading_scale: 'large', epub_chapter_title_style: 'minimal' }), /ts-minimal > h1 \{ font-size: 1\.9em; \}/, 'minimal folgt der Ueberschriften-Groesse');
});

test('buildEpub: Unterkapitel h2/h3, Ausrichtung, Abschnittstitel-Ebene, Praefix', async () => {
  const bundle = { scope: 'book', book: { id: 1, name: 'B' }, groups: [
    { chapterId: 1, chapter: { id: 1, name: 'Eins' }, pages: [{ p: { name: 'S1' }, pd: { html: '<p>a</p>' } }, { p: { name: 'S2' }, pd: { html: '<p>b</p>' } }] },
    { chapterId: 2, chapter: { id: 2, name: 'Zwei', parent_chapter_id: 1 }, pages: [{ p: { name: 'S3' }, pd: { html: '<p>c</p>' } }] },
    { chapterId: 3, chapter: { id: 3, name: 'Drei', parent_chapter_id: 2 }, pages: [{ p: { name: 'S4' }, pd: { html: '<p>d</p>' } }] },
  ] };
  const buf = await buildEpub(bundle, { lang: 'de', author: 'A', meta: {
    epub_chapter_numbering: 'arabic', epub_number_prefix: 'chapter',
    epub_sub_title_align: 'center', epub_sub_title_rule: true, epub_rule_style: 'diamond',
    epub_page_title_align: 'center',
  } });
  const zip = await JSZip.loadAsync(buf);
  const top = await zip.file('OEBPS/chap_0.xhtml').async('string');
  assert.ok(top.includes('<span class="epub-chapter-num">Kapitel 1</span>'), 'Praefix am Hauptkapitel');
  assert.ok(/<h1 class="epub-chapter-title/.test(top));
  assert.ok(!top.includes('epub-orn'), 'Hauptkapitel ohne Linie (Default)');
  const page = await zip.file('OEBPS/chap_0_p_0.xhtml').async('string');
  assert.ok(page.includes('<h2 class="epub-page-title epub-page-title--center">S1</h2>'));
  const sub = await zip.file('OEBPS/entry_1.xhtml').async('string');
  assert.ok(/<h2 class="epub-chapter-title[^"]*"><span class="epub-chapter-num">1\.1<\/span>/.test(sub), 'Unterkapitel h2, ohne Praefix');
  assert.ok(sub.includes('epub-chapter-head--align-center'));
  assert.ok(sub.includes('epub-orn--diamond'), 'Unterkapitel-Linie');
  const subsub = await zip.file('OEBPS/entry_2.xhtml').async('string');
  assert.ok(/<h3 class="epub-chapter-title/.test(subsub), 'Unter-Unterkapitel h3');
});

test('Frontend-Auswahllisten decken sich mit dem Server-SSoT', async () => {
  const { HEADING_STYLE_ENUMS } = await import('../../public/js/cards/export-heading-style.js');
  assert.deepEqual({ ...HEADING_STYLE_ENUMS }, { ...hs.ENUMS });
});
