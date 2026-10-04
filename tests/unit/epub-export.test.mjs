import { test } from 'node:test';
import assert from 'node:assert/strict';
import epub from '../../lib/export-builders/epub.js';
import sharp from 'sharp';
import JSZip from 'jszip';

const { _resolveEpubMeta, _countUnfetchableImages, _buildFrontmatter, _buildBackmatter, _buildImprintBackmatter, _buildExtraSections, _proseToXhtml, buildEpub, _buildOpfExtraMeta, _buildAccessibilityMeta, _buildLandmarksNav, _buildContentOPF, _buildCoverXhtml, _buildCss, _applyBreaks, _dedupeIds } = epub;

test('_applyBreaks: Editor-hr nach Klasse → pagebreak/blankpage/Szenentrenner', () => {
  const html = '<hr class="pagebreak" data-bid="a1">x'
    + '<hr class="blankpage" data-bid="b2">y'
    + '<hr data-bid="c3">z';
  const out = _applyBreaks(html, 'stars');
  assert.equal(out.match(/<hr class="pagebreak" \/>/g).length, 1);
  // Blankpage-Div traegt ein U+00A0, damit Reader die leere Seite nicht kollabieren.
  assert.equal(out.match(/<div class="blankpage">[^<]*<\/div>/g).length, 1);
  // Plain-hr (kein Break-Marker) → konfigurierter Szenentrenner.
  assert.ok(out.includes('<p class="scene-sep">* * *</p>'));
});

test('_applyBreaks: unbekannter sceneSep → line-Default, leeres html durchgereicht', () => {
  assert.equal(_applyBreaks('', 'stars'), '');
  assert.ok(_applyBreaks('<hr data-bid="x">', 'bogus').includes('<hr class="scene-line" />'));
});

test('_applyBreaks: Leerzeile → scene-gap nur bei aktivem Einzug (Belletristik)', () => {
  // indentActive=true: leerer Absatz wird Szenentrenner-Leerzeile.
  const on = _applyBreaks('<p>A</p><p data-bid="x"></p><p>B</p>', 'line', true);
  assert.ok(on.includes('<p class="scene-gap">&#160;</p>'));
  // indentActive=false (Sachbuch-Satz): unangetastet, Absatzabstand trennt selbst.
  const off = _applyBreaks('<p>A</p><p></p><p>B</p>', 'line', false);
  assert.ok(!off.includes('scene-gap'));
});

test('_applyBreaks: scene-gaps kollabieren + führend/abschliessend entfernt', () => {
  const out = _applyBreaks('<p><br></p><p>A</p><p></p><p><br></p><p>B</p><p></p>', 'line', true);
  assert.equal(out.match(/scene-gap/g).length, 1);
  assert.ok(out.startsWith('<p>A</p>'));
  assert.ok(out.endsWith('<p>B</p>'));
});

test('_dedupeIds: doppelte IDs werden eindeutig, erstes Vorkommen bleibt', () => {
  const out = _dedupeIds('<p id="bkmrk-a">1</p><p id="bkmrk-a">2</p><p id="bkmrk-a">3</p>');
  assert.equal((out.match(/id="bkmrk-a"/g) || []).length, 1, 'erstes bkmrk-a bleibt');
  assert.ok(out.includes('id="bkmrk-a-2"') && out.includes('id="bkmrk-a-3"'), 'Duplikate durchnummeriert');
});

test('_dedupeIds: synthetischer Suffix kollidiert nicht mit echter ID', () => {
  // "x-2" existiert bereits — das umbenannte Duplikat von "x" muss "x-3" werden.
  const out = _dedupeIds('<p id="x">a</p><p id="x-2">b</p><p id="x">c</p>');
  assert.ok(out.includes('id="x-2">b'), 'echte x-2 bleibt unangetastet');
  assert.ok(out.includes('id="x-3"'), 'Duplikat weicht auf x-3 aus');
});

test('_dedupeIds: leere id wird entfernt, ohne ids unveraendert', () => {
  assert.equal(_dedupeIds('<p id="">x</p>'), '<p>x</p>');
  assert.equal(_dedupeIds('<p id="bkmrk-">a</p><p id="bkmrk-">b</p>'), '<p id="bkmrk-">a</p><p id="bkmrk--2">b</p>');
  const plain = '<p class="x">kein id</p>';
  assert.equal(_dedupeIds(plain), plain);
});

test('_buildContentOPF: leerer Verlag → keine leeren publisher-Elemente', () => {
  const opf = _buildContentOPF({}, {}, { hasImages: false, lang: 'de' });
  assert.ok(!/<dc:publisher>/.test(opf), 'leeres dc:publisher entfernt');
  assert.ok(!/dcterms:publisher/.test(opf), 'leeres dcterms:publisher-meta entfernt');
  assert.ok(!/ by <%= publisher %>/.test(opf), 'Copyright-Default ohne dangling "by"');
  // Mit Verlag bleiben die Zeilen (ejs-Platzhalter) erhalten.
  const withPub = _buildContentOPF({ publisher: 'Mein Verlag' }, {}, { hasImages: false, lang: 'de' });
  assert.ok(/<dc:publisher><%= publisher %><\/dc:publisher>/.test(withPub), 'publisher-Zeile bleibt bei gesetztem Verlag');
});

test('buildEpub: ohne publisher kein leeres dc:publisher im OPF (RSC-005)', async () => {
  const bundle = { scope: 'book', book: { id: 1, name: 'B', description: 'D' }, groups: _oneGroup() };
  const buf = await buildEpub(bundle, { lang: 'de', author: 'A', meta: {} });
  const zip = await _unzip(buf);
  const opf = await zip.file('OEBPS/content.opf').async('string');
  assert.ok(!/<dc:publisher>\s*<\/dc:publisher>/.test(opf), 'kein leeres dc:publisher');
  assert.ok(!/<meta property="dcterms:publisher">\s*<\/meta>/.test(opf), 'kein leeres dcterms:publisher-meta');
});

test('buildEpub: doppelte bkmrk-IDs aus Seiten-HTML werden im XHTML dedupliziert', async () => {
  const bundle = {
    scope: 'book', book: { id: 1, name: 'B' },
    groups: [{ chapterId: null, chapter: null, pages: [{ p: { name: 'S1' }, pd: { html: '<p id="bkmrk-a">x</p><p id="bkmrk-a">y</p>' } }] }],
  };
  const buf = await buildEpub(bundle, { lang: 'de', author: 'A', meta: {} });
  const zip = await _unzip(buf);
  const entry = await zip.file('OEBPS/entry_0.xhtml').async('string');
  assert.equal((entry.match(/id="bkmrk-a"/g) || []).length, 1, 'nur ein bkmrk-a');
  assert.ok(entry.includes('id="bkmrk-a-2"'), 'Duplikat umbenannt');
});

test('_buildCss: scene-gap-Regel nur im Belletristik-Satz', () => {
  assert.ok(epub._buildCss({}).includes('.scene-gap + p'));
  assert.ok(!epub._buildCss({ epub_paragraph_style: 'spaced' }).includes('.scene-gap'));
});

test('_resolveEpubMeta: opts.author/lang setzen Autor + Sprache', () => {
  const m = _resolveEpubMeta({ author: 'Owner Name', lang: 'en' });
  assert.equal(m.author, 'Owner Name');
  assert.equal(m.lang, 'en');
  assert.equal(m.tocTitle, 'Contents');
});

test('_resolveEpubMeta: Default de + Inhalt, kein Autor', () => {
  const m = _resolveEpubMeta({});
  assert.equal(m.lang, 'de');
  assert.equal(m.tocTitle, 'Inhalt');
  assert.equal(m.author, '');
});

test('_resolveEpubMeta: tocTitle-Override schlaegt Sprach-Default', () => {
  assert.equal(_resolveEpubMeta({ lang: 'en', tocTitle: 'Index' }).tocTitle, 'Index');
});

test('_resolveEpubMeta: nur en-Praefix triggert Contents, sonst Inhalt', () => {
  assert.equal(_resolveEpubMeta({ lang: 'en-US' }).tocTitle, 'Contents');
  assert.equal(_resolveEpubMeta({ lang: 'de-CH' }).tocTitle, 'Inhalt');
  assert.equal(_resolveEpubMeta({ lang: 'fr' }).tocTitle, 'Inhalt');
});

test('_countUnfetchableImages: zaehlt nur non-http/non-data src', () => {
  const chapters = [
    { content: '<p>x</p><img src="https://a.com/x.jpg"><img src="data:image/png;base64,AAA">' },
    { content: '<img src="/local/rel.png"> und <img src="cover.jpg">' },
    { content: '<img SRC = "HTTP://b.com/y.png">' },
  ];
  // 2 unfetchbar: /local/rel.png + cover.jpg. http(s) + data + HTTP zaehlen nicht.
  assert.equal(_countUnfetchableImages(chapters), 2);
});

test('_countUnfetchableImages: leere/keine Bilder -> 0', () => {
  assert.equal(_countUnfetchableImages([{ content: '<p>kein Bild</p>' }, { content: '' }, {}]), 0);
});

test('_proseToXhtml: escaped, Doppel-Umbruch=Absatz, Einzel=<br/>', () => {
  assert.equal(_proseToXhtml('a\n\nb'), '<p>a</p>\n<p>b</p>');
  assert.equal(_proseToXhtml('a\nb'), '<p>a<br/>b</p>');
  assert.equal(_proseToXhtml('<b>&'), '<p>&lt;b&gt;&amp;</p>');
  assert.equal(_proseToXhtml('   '), '');
});

test('_buildFrontmatter: Titelseite immer, Rest konditional, alle __toc:false + beforeToc', () => {
  const f = _buildFrontmatter({ subtitle: 'Sub', year: '2026', dedication: 'Fuer X', imprint: 'Verlag', isbn: '123', copyright: '© 2026' }, { title: 'Buch', author: 'Autor', lang: 'de' });
  assert.ok(f.every(e => e.__toc === false && e.beforeToc === true));
  assert.equal(f[0].filename, 'front_title.xhtml');
  assert.ok(f[0].content.includes('Buch') && f[0].content.includes('Sub') && f[0].content.includes('Autor') && f[0].content.includes('2026'));
  const files = f.map(e => e.filename);
  assert.ok(files.includes('front_imprint.xhtml') && files.includes('front_dedication.xhtml'));
  assert.ok(f.find(e => e.filename === 'front_imprint.xhtml').content.includes('ISBN: 123'));
});

test('_buildFrontmatter: nur Titelseite wenn keine Meta', () => {
  const f = _buildFrontmatter(null, { title: 'B', author: '', lang: 'en' });
  assert.equal(f.length, 1);
  assert.equal(f[0].title, 'Title');
});

test('_buildBackmatter: leere Bio -> [], mit Bio -> Eintrag (+Foto data-uri)', () => {
  assert.deepEqual(_buildBackmatter({ author_bio: '' }, { lang: 'de' }), []);
  const withImg = _buildBackmatter({ author_bio: 'Bio Text' }, { lang: 'de' }, { image: Buffer.from('x'), mime: 'image/jpeg' });
  assert.equal(withImg.length, 1);
  assert.equal(withImg[0].__toc, false);
  assert.ok(withImg[0].content.includes('Über den Autor'));
  assert.ok(withImg[0].content.includes('data:image/jpeg;base64,'));
});

// 1x1 PNG
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('buildEpub: erzeugt Buffer mit Frontmatter/Backmatter-Dateien + Cover', async () => {
  const bundle = {
    scope: 'book',
    book: { id: 1, name: 'Mein Buch', description: 'Desc' },
    groups: [{ chapterId: null, chapter: null, pages: [{ p: { name: 'Seite 1' }, pd: { html: '<p>Inhalt</p>' } }] }],
  };
  const buf = await buildEpub(bundle, {
    lang: 'de',
    author: 'Test Autor',
    meta: { dedication: 'Fuer dich', author_bio: 'Der Autor lebt.', epub_justify: true, subtitle: 'Untertitel', year: '2026' },
    cover: { image: PNG_1x1, mime: 'image/png' },
  });
  assert.ok(Buffer.isBuffer(buf) && buf.length > 0);
  // Zip-Local-Header-Dateinamen liegen unkomprimiert im Buffer.
  const s = buf.toString('latin1');
  assert.ok(s.includes('front_title.xhtml'), 'Titelseite fehlt');
  assert.ok(s.includes('front_dedication.xhtml'), 'Widmung fehlt');
  assert.ok(s.includes('back_author.xhtml'), 'Autor-Seite fehlt');
});

test('_buildCoverXhtml: SVG-viewBox bei bekannten Maßen, jpeg-Endung wie die Lib', () => {
  const svg = _buildCoverXhtml({ mime: 'image/jpeg', width: 750, height: 1200 });
  assert.ok(svg.includes('viewBox="0 0 750 1200"'));
  // epub-gen-memory legt das Bild als cover.jpeg ab (mime.getExtension) — Referenz muss matchen.
  assert.ok(svg.includes('xlink:href="cover.jpeg"'));
  assert.ok(svg.includes('class="cover-page"'));
  // Roh-Fallback (keine Maße) → einfaches <img>, png behält png-Endung.
  const fallback = _buildCoverXhtml({ mime: 'image/png', width: 0, height: 0 });
  assert.ok(fallback.includes('<img src="cover.png"') && !fallback.includes('<svg'));
});

test('buildEpub: Cover wird auf Hochformat gecroppt + als Vollbild-Cover-Seite injiziert', async () => {
  // Querformat-Quelle (1600×900) → muss zu ~1:1.6 Hochformat beschnitten werden.
  const landscape = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 44, g: 62, b: 80 } } }).png().toBuffer();
  const bundle = {
    scope: 'book', book: { id: 1, name: 'Buch', description: 'D' },
    groups: [{ chapterId: null, chapter: null, pages: [{ p: { name: 'S1' }, pd: { html: '<p>x</p>' } }] }],
  };
  const buf = await buildEpub(bundle, { lang: 'de', author: 'A', meta: {}, cover: { image: landscape, mime: 'image/png' } });

  // OCF: mimetype als erste Entry + unkomprimiert (STORE = Methode 0).
  assert.equal(buf.readUInt16LE(8), 0, 'mimetype muss STORE bleiben');

  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
  assert.equal(names[0], 'mimetype');
  const opfPath = names.find(n => n.endsWith('.opf'));
  const dir = opfPath.replace(/[^/]+$/, '');

  // Cover-Bild ist Hochformat (~1:1.6), immer JPEG.
  const cov = await zip.file(`${dir}cover.jpeg`).async('nodebuffer');
  const m = await sharp(cov).metadata();
  assert.ok(Math.abs(m.height / m.width - 1.6) < 0.02, `Cover-Ratio ${m.height}/${m.width} ≠ ~1.6`);

  // Cover-Seite existiert, SVG mit korrektem viewBox + Bildreferenz.
  const cx = await zip.file(`${dir}front_cover.xhtml`).async('string');
  assert.ok(cx.includes(`viewBox="0 0 ${m.width} ${m.height}"`));
  assert.ok(cx.includes('xlink:href="cover.jpeg"'));

  // OPF: EPUB3-cover-image-Property + Cover als erste Spine-Seite + Manifest-Item.
  const opf = await zip.file(opfPath).async('string');
  assert.ok(/properties="cover-image"/.test(opf));
  assert.ok(/<item id="cover-page"[^>]*href="front_cover\.xhtml"/.test(opf));
  assert.ok(/<spine[^>]*>\s*<itemref idref="cover-page"/.test(opf), 'Cover muss erste Spine-Seite sein');
});

test('buildEpub: ohne Cover keine Cover-Seite, mimetype bleibt STORE', async () => {
  const bundle = { scope: 'book', book: { id: 1, name: 'B', description: 'D' }, groups: [{ chapterId: null, chapter: null, pages: [{ p: { name: 'S1' }, pd: { html: '<p>x</p>' } }] }] };
  const buf = await buildEpub(bundle, { lang: 'de', author: 'A', meta: {} });
  assert.equal(buf.readUInt16LE(8), 0);
  const zip = await JSZip.loadAsync(buf);
  assert.ok(!Object.keys(zip.files).some(n => n.endsWith('front_cover.xhtml')));
});

test('_buildOpfExtraMeta: ohne keywords/series nur Hauptautor-aut-Relator', () => {
  // Hauptautor-MARC-Relator (aut auf das Lib-#creator) wird immer emittiert;
  // ohne keywords/series/Co-Autoren ist das die einzige Zeile.
  const AUT = '<meta refines="#creator" property="role" scheme="marc:relators">aut</meta>';
  assert.equal(_buildOpfExtraMeta({}), AUT);
  assert.equal(_buildOpfExtraMeta({ keywords: '  ,  ' }), AUT);
  assert.ok(!_buildOpfExtraMeta({}).includes('dc:subject') && !_buildOpfExtraMeta({}).includes('belongs-to-collection'), 'kein Subject/Collection ohne keywords/series');
});

test('_buildOpfExtraMeta: keywords → dc:subject je Term (escaped), series → collection + calibre', () => {
  const out = _buildOpfExtraMeta({ keywords: 'Fantasy, Abenteuer & Co', series: 'Die <Reihe>', series_index: '2' });
  assert.ok(out.includes('<dc:subject>Fantasy</dc:subject>'));
  assert.ok(out.includes('<dc:subject>Abenteuer &amp; Co</dc:subject>'));
  assert.ok(out.includes('belongs-to-collection') && out.includes('Die &lt;Reihe&gt;'));
  assert.ok(out.includes('group-position">2<'));
  assert.ok(out.includes('calibre:series') && out.includes('calibre:series_index'));
});

test('_buildOpfExtraMeta: ISBN → dc:identifier urn:isbn + onix-Code, Bindestriche gestrippt', () => {
  const out13 = _buildOpfExtraMeta({ isbn: '978-3-16-148410-0' });
  assert.ok(out13.includes('<dc:identifier id="isbn">urn:isbn:9783161484100</dc:identifier>'));
  assert.ok(out13.includes('property="identifier-type" scheme="onix:codelist5">15</meta>'), 'ISBN-13 → onix 15');
  // ISBN-10 (mit X-Pruefziffer) → onix 02.
  const out10 = _buildOpfExtraMeta({ isbn: '3-16-148410-X' });
  assert.ok(out10.includes('urn:isbn:316148410X'));
  assert.ok(out10.includes('>02</meta>'), 'ISBN-10 → onix 02');
  // Kein ISBN → kein Identifier.
  assert.ok(!_buildOpfExtraMeta({}).includes('urn:isbn'));
});

test('_buildAccessibilityMeta: textual immer, visual nur mit Bildern, Sprach-Summary', () => {
  const noImg = _buildAccessibilityMeta({ hasImages: false, lang: 'de' });
  assert.ok(noImg.includes('schema:accessMode">textual<'));
  assert.ok(!noImg.includes('>visual<'), 'kein visual ohne Bilder');
  assert.ok(noImg.includes('schema:accessibilityFeature">tableOfContents<'));
  assert.ok(noImg.includes('schema:accessibilityHazard">none<'));
  assert.ok(noImg.includes('Reflowierbarer Text'), 'DE-Summary');
  assert.ok(noImg.includes('dcterms:conformsTo'), 'conformsTo-Link fehlt');
  const withImg = _buildAccessibilityMeta({ hasImages: true, lang: 'en' });
  assert.ok(withImg.includes('>visual<'), 'visual bei Bildern');
  assert.ok(withImg.includes('Reflowable text'), 'EN-Summary');
});

test('_buildLandmarksNav: toc + bodymatter, bodymatter nur mit Start-Datei', () => {
  const nav = _buildLandmarksNav('entry_0.xhtml', 'de');
  assert.ok(nav.includes('epub:type="landmarks"') && nav.includes('hidden="'));
  assert.ok(nav.includes('epub:type="toc" href="toc.xhtml"'));
  assert.ok(nav.includes('epub:type="bodymatter" href="entry_0.xhtml"'));
  assert.ok(nav.includes('Inhaltsverzeichnis') && nav.includes('Textbeginn'));
  // Ohne Start-Datei kein bodymatter-Eintrag.
  assert.ok(!_buildLandmarksNav(null, 'en').includes('bodymatter'));
});

test('_buildContentOPF: injiziert Accessibility-Meta (immer) + ISBN', () => {
  const opf = _buildContentOPF({ isbn: '9783161484100' }, {}, { hasImages: false, lang: 'de' });
  assert.ok(opf.includes('schema:accessMode">textual<'), 'a11y-Meta immer eingebettet');
  assert.ok(opf.includes('urn:isbn:9783161484100'));
  assert.ok(opf.indexOf('schema:accessibilitySummary') < opf.indexOf('</metadata>'), 'a11y vor </metadata>');
});

test('_buildContentOPF: stempelt App-generator, injiziert Extra-Meta vor </metadata>', () => {
  const bare = _buildContentOPF({});
  assert.ok(bare.includes('<meta name="generator" content="Schreibwerkstatt '), 'generator weist die App aus');
  assert.ok(!bare.includes('content="epub-gen"'), 'Lib-generator-Tag ist ersetzt');
  const opf = _buildContentOPF({ keywords: 'X' });
  assert.ok(opf.includes('<dc:subject>X</dc:subject>'));
  assert.ok(opf.indexOf('<dc:subject>X</dc:subject>') < opf.indexOf('</metadata>'), 'Extra-Meta muss vor </metadata> stehen');
  assert.ok(opf.includes('<%= title %>'), 'ejs-Platzhalter der Lib bleiben erhalten');
  assert.ok(opf.includes('dcterms:modified'), '"wann" (Build-Zeitstempel) bleibt erhalten');
});

test('_buildContentOPF: Provenienz — Instanz-Domain im generator, User in generated-by', () => {
  const opf = _buildContentOPF({}, { instanceUrl: 'https://buch.example.ch', exportedBy: 'a@b.ch' });
  assert.ok(/<meta name="generator" content="Schreibwerkstatt [^"]*\(https:\/\/buch\.example\.ch\)" \/>/.test(opf), 'Instanz-URL im generator-Content');
  assert.ok(opf.includes('<meta name="generated-by" content="a@b.ch" />'), 'exportierender User als generated-by');
  // Ohne Provenienz kein generated-by, generator ohne Klammer-Zusatz.
  const bare = _buildContentOPF({});
  assert.ok(!bare.includes('generated-by'), 'kein generated-by ohne User');
  assert.ok(/<meta name="generator" content="Schreibwerkstatt [^"(]*" \/>/.test(bare), 'generator ohne Instanz-Zusatz wenn keine URL');
});

// content.opf + style.css liegen DEFLATE-komprimiert im Zip — Buffer-Grep findet
// sie nicht. Entpacken via jszip.
async function _unzip(buf) {
  const JSZip = (await import('jszip')).default;
  return JSZip.loadAsync(buf);
}
const _oneGroup = () => ([{ chapterId: null, chapter: null, pages: [{ p: { name: 'S1' }, pd: { html: '<p>x</p>' } }] }]);

test('buildEpub: Kapitelnumerierung prependet Label an TOC-Titel + Ueberschrift', async () => {
  const bundle = {
    scope: 'book', book: { id: 1, name: 'B' },
    groups: [
      { chapterId: 10, chapter: { id: 10, name: 'Anfang' }, pages: [{ p: { name: 'S1' }, pd: { html: '<p>a</p>' } }] },
      { chapterId: 11, chapter: { id: 11, name: 'Mitte' }, pages: [{ p: { name: 'S2' }, pd: { html: '<p>b</p>' } }] },
    ],
  };
  const buf = await buildEpub(bundle, {
    lang: 'de', author: 'A',
    meta: { epub_chapter_numbering: 'arabic', epub_chapter_numbering_mode: 'flat' },
  });
  const zip = await _unzip(buf);
  const nav = await zip.file('OEBPS/toc.xhtml').async('string');
  assert.ok(nav.includes('1. Anfang') && nav.includes('2. Mitte'), 'TOC-Eintraege fehlt Numerierung');
  const ncx = await zip.file('OEBPS/toc.ncx').async('string');
  assert.ok(ncx.includes('<text>1. Anfang</text>'), 'NavMap fehlt Numerierung');
  const entry = await zip.file('OEBPS/entry_0.xhtml').async('string');
  // Body-Ueberschrift gestapelt: Nummer + Titel in eigenen Spans (TOC bleibt flach).
  assert.ok(entry.includes('class="epub-chapter-num">1</span>') && entry.includes('class="epub-chapter-name">Anfang</span>'), 'Body-Ueberschrift gestapelt mit Numerierung');
});

test('buildEpub: numerierte Ueberschrift gestapelt — Reihenfolge Nummer → Strich → Titel, Strich dekorativ', async () => {
  const bundle = {
    scope: 'book', book: { id: 1, name: 'B' },
    groups: [{ chapterId: 10, chapter: { id: 10, name: 'Anfang' }, pages: [{ p: { name: 'S1' }, pd: { html: '<p>a</p>' } }] }],
  };
  const buf = await buildEpub(bundle, {
    lang: 'de', author: 'A',
    meta: { epub_chapter_numbering: 'arabic', epub_chapter_numbering_mode: 'flat' },
  });
  const zip = await _unzip(buf);
  const entry = await zip.file('OEBPS/entry_0.xhtml').async('string');
  const iNum = entry.indexOf('epub-chapter-num');
  const iRule = entry.indexOf('epub-chapter-rule');
  const iName = entry.indexOf('epub-chapter-name');
  assert.ok(iNum >= 0 && iRule > iNum && iName > iRule, 'Reihenfolge Nummer → Strich → Titel');
  assert.ok(/epub-chapter-rule"[^>]*aria-hidden="true"/.test(entry), 'Strich-Trenner ist dekorativ (aria-hidden)');
  assert.ok(entry.includes('epub-chapter-title--numbered'), 'gestapelte Ueberschrift traegt --numbered-Klasse');
  // Stylesheet enthaelt die Layout-Regel fuer die gestapelte Ueberschrift.
  assert.ok(_buildCss({}).includes('.epub-chapter-title--numbered'), 'CSS-Regel fuer gestapelte Ueberschrift vorhanden');
});

test('buildEpub: epub_chapter_number_divider=false → Nummer + Titel ohne ———-Strich', async () => {
  const bundle = {
    scope: 'book', book: { id: 1, name: 'B' },
    groups: [{ chapterId: 10, chapter: { id: 10, name: 'Anfang' }, pages: [{ p: { name: 'S1' }, pd: { html: '<p>a</p>' } }] }],
  };
  const buf = await buildEpub(bundle, {
    lang: 'de', author: 'A',
    meta: { epub_chapter_numbering: 'arabic', epub_chapter_numbering_mode: 'flat', epub_chapter_number_divider: false },
  });
  const zip = await _unzip(buf);
  const entry = await zip.file('OEBPS/entry_0.xhtml').async('string');
  assert.ok(entry.includes('class="epub-chapter-num">1</span>'), 'Nummer bleibt erhalten');
  assert.ok(entry.includes('class="epub-chapter-name">Anfang</span>'), 'Titel bleibt erhalten');
  assert.ok(!entry.includes('epub-chapter-rule'), 'kein Strich-Trenner mehr');
  assert.ok(entry.includes('epub-chapter-title--numbered'), 'gestapelte Ueberschrift bleibt');
});

test('buildEpub: epub_unnumbered_chapter_ids — markiertes Kapitel ohne Nummer, Zaehlung ohne Luecke', async () => {
  const bundle = {
    scope: 'book', book: { id: 1, name: 'B' },
    groups: [
      { chapterId: 10, chapter: { id: 10, name: 'Anfang' }, pages: [{ p: { name: 'S1' }, pd: { html: '<p>a</p>' } }] },
      { chapterId: 11, chapter: { id: 11, name: 'Vorwort' }, pages: [{ p: { name: 'S2' }, pd: { html: '<p>b</p>' } }] },
      { chapterId: 12, chapter: { id: 12, name: 'Mitte' }, pages: [{ p: { name: 'S3' }, pd: { html: '<p>c</p>' } }] },
    ],
  };
  const buf = await buildEpub(bundle, {
    lang: 'de', author: 'A',
    meta: { epub_chapter_numbering: 'arabic', epub_chapter_numbering_mode: 'flat', epub_unnumbered_chapter_ids: [11] },
  });
  const zip = await _unzip(buf);
  const e0 = await zip.file('OEBPS/entry_0.xhtml').async('string');
  const e1 = await zip.file('OEBPS/entry_1.xhtml').async('string');
  const e2 = await zip.file('OEBPS/entry_2.xhtml').async('string');
  assert.ok(e0.includes('class="epub-chapter-num">1</span>') && e0.includes('class="epub-chapter-name">Anfang</span>'), 'erstes Kapitel numeriert');
  assert.ok(e1.includes('<h1>Vorwort</h1>') && !e1.includes('epub-chapter-num'), 'markiertes Kapitel ohne Nummer (schlichte Ueberschrift)');
  assert.ok(e2.includes('class="epub-chapter-num">2</span>') && e2.includes('class="epub-chapter-name">Mitte</span>'), 'naechstes Kapitel laeuft ohne Luecke weiter (2, nicht 3)');
});

test('buildEpub: unnumbered cascade — markiertes Top-Kapitel zieht Sub-Kapitel mit', async () => {
  const bundle = {
    scope: 'book', book: { id: 1, name: 'B' },
    groups: [
      { chapterId: 20, chapter: { id: 20, name: 'Teil', parent_chapter_id: null }, pages: [{ p: { name: 'S1' }, pd: { html: '<p>a</p>' } }] },
      { chapterId: 21, chapter: { id: 21, name: 'Unterkapitel', parent_chapter_id: 20 }, pages: [{ p: { name: 'S2' }, pd: { html: '<p>b</p>' } }] },
      { chapterId: 22, chapter: { id: 22, name: 'Echtes', parent_chapter_id: null }, pages: [{ p: { name: 'S3' }, pd: { html: '<p>c</p>' } }] },
    ],
  };
  const buf = await buildEpub(bundle, {
    lang: 'de', author: 'A',
    meta: { epub_chapter_numbering: 'arabic', epub_chapter_numbering_mode: 'flat', epub_unnumbered_chapter_ids: [20] },
  });
  const zip = await _unzip(buf);
  const e0 = await zip.file('OEBPS/entry_0.xhtml').async('string');
  const e1 = await zip.file('OEBPS/entry_1.xhtml').async('string');
  const e2 = await zip.file('OEBPS/entry_2.xhtml').async('string');
  assert.ok(e0.includes('<h1>Teil</h1>') && !e0.includes('epub-chapter-num'), 'Top-Kapitel ohne Nummer');
  assert.ok(e1.includes('<h1>Unterkapitel</h1>') && !e1.includes('epub-chapter-num'), 'Sub-Kapitel erbt unnumbered via Cascade');
  assert.ok(e2.includes('class="epub-chapter-num">1</span>') && e2.includes('class="epub-chapter-name">Echtes</span>'), 'erstes echtes Kapitel ist 1 (Cascade verbrauchte keine Nummer)');
});

test('buildEpub: numbering none (Default) → keine Label-Praefixe', async () => {
  const bundle = {
    scope: 'book', book: { id: 1, name: 'B' },
    groups: [{ chapterId: 10, chapter: { id: 10, name: 'Anfang' }, pages: [{ p: { name: 'S1' }, pd: { html: '<p>a</p>' } }] }],
  };
  const buf = await buildEpub(bundle, { lang: 'de', author: 'A', meta: {} });
  const zip = await _unzip(buf);
  const entry = await zip.file('OEBPS/entry_0.xhtml').async('string');
  assert.ok(entry.includes('<h1>Anfang</h1>') && !entry.includes('epub-chapter-num'), 'Default darf nicht numerieren');
});

test('buildEpub: description-Fallback book→meta, publisher/series in OPF', async () => {
  const bundle = { scope: 'book', book: { id: 1, name: 'Mein Buch', description: 'Buch-Beschreibung' }, groups: _oneGroup() };
  const buf = await buildEpub(bundle, {
    lang: 'de', author: 'A',
    meta: { description: 'Klappentext', publisher: 'Mein Verlag', series: 'Saga', keywords: 'Krimi' },
  });
  const zip = await _unzip(buf);
  const opf = await zip.file('OEBPS/content.opf').async('string');
  assert.ok(opf.includes('<dc:description>Klappentext</dc:description>'), 'meta.description gewinnt vor book.description');
  assert.ok(opf.includes('<dc:publisher>Mein Verlag</dc:publisher>'), 'publisher fehlt');
  assert.ok(opf.includes('belongs-to-collection'), 'series collection fehlt');
  assert.ok(opf.includes('<dc:subject>Krimi</dc:subject>'), 'keyword fehlt');
});

test('buildEpub: ohne meta.description faellt auf book.description', async () => {
  const bundle = { scope: 'book', book: { id: 1, name: 'B', description: 'NurBuchDesc' }, groups: _oneGroup() };
  const buf = await buildEpub(bundle, { lang: 'de', author: 'A', meta: {} });
  const zip = await _unzip(buf);
  const opf = await zip.file('OEBPS/content.opf').async('string');
  assert.ok(opf.includes('<dc:description>NurBuchDesc</dc:description>'));
});

test('buildEpub: nav.xhtml enthält Landmarks, OPF enthält Accessibility-Meta', async () => {
  const bundle = { scope: 'book', book: { id: 1, name: 'B' }, groups: _oneGroup() };
  const buf = await buildEpub(bundle, { lang: 'de', author: 'A', meta: {} });
  const zip = await _unzip(buf);
  const nav = await zip.file('OEBPS/toc.xhtml').async('string');
  assert.ok(nav.includes('epub:type="landmarks"'), 'Landmarks-nav fehlt');
  assert.ok(nav.includes('epub:type="bodymatter"'), 'bodymatter-Landmark fehlt');
  const opf = await zip.file('OEBPS/content.opf').async('string');
  assert.ok(opf.includes('schema:accessMode">textual<'), 'a11y-Meta fehlt im OPF');
  assert.ok(opf.includes('dcterms:conformsTo'), 'conformsTo fehlt');
});

test('buildEpub: ISBN landet als urn:isbn-Identifier im OPF', async () => {
  const bundle = { scope: 'book', book: { id: 1, name: 'B' }, groups: _oneGroup() };
  const buf = await buildEpub(bundle, { lang: 'de', author: 'A', meta: { isbn: '978-3-16-148410-0' } });
  const zip = await _unzip(buf);
  const opf = await zip.file('OEBPS/content.opf').async('string');
  assert.ok(opf.includes('urn:isbn:9783161484100'), 'ISBN-Identifier fehlt im OPF');
});

test('buildEpub: epub_css_style sans → sans-serif body font', async () => {
  const bundle = { scope: 'book', book: { id: 1, name: 'B' }, groups: _oneGroup() };
  const buf = await buildEpub(bundle, { lang: 'de', author: 'A', meta: { epub_css_style: 'sans' } });
  const zip = await _unzip(buf);
  const css = await zip.file('OEBPS/style.css').async('string');
  assert.ok(css.includes('font-family: sans-serif'));
});

test('_buildOpfExtraMeta: co_authors → zusätzliche dc:creator mit aut-Relator + file-as', () => {
  const out = _buildOpfExtraMeta({ co_authors: [{ name: 'Max Muster', file_as: 'Muster, Max' }, { name: 'Eva <K>' }] });
  assert.ok(out.includes('<dc:creator id="creator-co1">Max Muster</dc:creator>'));
  assert.ok(out.includes('<meta refines="#creator-co1" property="role" scheme="marc:relators">aut</meta>'));
  assert.ok(out.includes('<meta refines="#creator-co1" property="file-as">Muster, Max</meta>'));
  // Zweiter Co-Autor escaped, ohne file-as keine file-as-Zeile.
  assert.ok(out.includes('<dc:creator id="creator-co2">Eva &lt;K&gt;</dc:creator>'));
  assert.ok(!out.includes('refines="#creator-co2" property="file-as"'));
});

test('_buildContentOPF: author_file_as überschreibt file-as des Hauptautors', () => {
  const opf = _buildContentOPF({ author_file_as: 'Beispiel, Anna' }, {}, { hasImages: false, lang: 'de' });
  assert.ok(opf.includes('<meta refines="#creator" property="file-as">Beispiel, Anna</meta>'));
  // Ohne author_file_as bleibt der ejs-Platzhalter der Lib erhalten.
  const bare = _buildContentOPF({}, {}, { hasImages: false, lang: 'de' });
  assert.ok(/<meta refines="#creator" property="file-as"><%=/.test(bare));
});

test('_buildExtraSections: front/back-Split, leere verworfen, CTA-Link nur http/mailto', () => {
  const { front, back } = _buildExtraSections({ extra_sections: [
    { placement: 'front', title: 'Warnung', body: 'Inhalt.' },
    { placement: 'back', title: 'Newsletter', body: 'Trag dich ein.', link_url: 'https://x.test', link_label: 'Anmelden' },
    { placement: 'back', title: '', body: '', link_url: '' },                       // leer → verworfen
    { placement: 'back', title: 'NoLink', body: 'x', link_url: 'javascript:alert(1)' }, // bad scheme → kein <a>
  ] }, { lang: 'de' });
  assert.equal(front.length, 1);
  assert.equal(back.length, 2);
  assert.ok(front[0].beforeToc === true && front[0].__toc === true);
  assert.ok(front[0].content.includes('<h2>Warnung</h2>'));
  assert.ok(back[0].content.includes('<p class="cta"><a href="https://x.test">Anmelden</a></p>'));
  assert.ok(!back[1].content.includes('<a '), 'unsicheres Schema → kein Link');
});

test('_buildExtraSections: toc=false / titelloser Eintrag nicht im TOC', () => {
  const { back } = _buildExtraSections({ extra_sections: [
    { placement: 'back', title: 'Danke', body: 'x', toc: false },
    { placement: 'back', title: '', body: 'nurBody' },
  ] }, { lang: 'de' });
  assert.equal(back[0].__toc, false); // explizit toc:false
  assert.equal(back[1].__toc, false); // kein Titel → kein TOC-Label
});

test('buildEpub: extra_sections → front_extra/back_extra Dateien + TOC-Eintraege', async () => {
  const bundle = { scope: 'book', book: { id: 1, name: 'B' }, groups: _oneGroup() };
  const buf = await buildEpub(bundle, { lang: 'de', author: 'A', meta: { extra_sections: [
    { placement: 'front', title: 'Triggerwarnung', body: 'Gewalt.' },
    { placement: 'back', title: 'Newsletter', body: 'Melde dich an.', link_url: 'https://nl.test', link_label: 'Anmelden' },
  ] } });
  const zip = await _unzip(buf);
  assert.ok(zip.file('OEBPS/front_extra_0.xhtml'), 'front-Sektion fehlt');
  assert.ok(zip.file('OEBPS/back_extra_1.xhtml'), 'back-Sektion fehlt');
  const back = await zip.file('OEBPS/back_extra_1.xhtml').async('string');
  assert.ok(back.includes('href="https://nl.test"'), 'CTA-Link fehlt');
  const nav = await zip.file('OEBPS/toc.xhtml').async('string');
  assert.ok(nav.includes('Triggerwarnung') && nav.includes('Newsletter'), 'extra-Sektionen fehlen im TOC');
});

test('buildEpub: co_authors → Anzeige-Autor + zusätzliche dc:creator + file-as im OPF', async () => {
  const bundle = { scope: 'book', book: { id: 1, name: 'B' }, groups: _oneGroup() };
  const buf = await buildEpub(bundle, { lang: 'de', author: 'Anna Beispiel', meta: {
    author_file_as: 'Beispiel, Anna',
    co_authors: [{ name: 'Max Muster', file_as: 'Muster, Max' }],
  } });
  const zip = await _unzip(buf);
  const title = await zip.file('OEBPS/front_title.xhtml').async('string');
  assert.ok(title.includes('Anna Beispiel') && title.includes('Max Muster'), 'Titelseite zeigt beide Autoren');
  const opf = await zip.file('OEBPS/content.opf').async('string');
  assert.ok(opf.includes('<meta refines="#creator" property="file-as">Beispiel, Anna</meta>'), 'Hauptautor file-as fehlt');
  assert.ok(opf.includes('<dc:creator id="creator-co1">Max Muster</dc:creator>'), 'Co-Autor-creator fehlt');
  const ncx = await zip.file('OEBPS/toc.ncx').async('string');
  assert.ok(ncx.includes('Anna Beispiel') && ncx.includes('Max Muster'), 'NCX docAuthor zeigt nicht beide');
});

// ── PDF-Pendant-Optionen (Migration 179) ────────────────────────────────────

test('_buildCss: Heading-Font/Scale/Numerals + getrennte Kapitel/Sub-Umbrueche', () => {
  const on = _buildCss({ epub_chapter_pagebreak: true, epub_subchapter_pagebreak: true, epub_heading_font: 'garamond', epub_heading_scale: 'large', epub_numerals: 'oldstyle' });
  assert.ok(on.includes('EB Garamond'), 'Heading-Font-Stack');
  assert.ok(/\nh1 \{ font-size: 2\.6em; \}/.test(on), 'Heading-Scale large');
  assert.ok(on.includes('oldstyle-nums'), 'Oldstyle-Ziffern');
  assert.ok(on.includes('.epub-chapter-head--top { page-break-before: always'), 'Top-Kapitelumbruch');
  assert.ok(on.includes('.epub-chapter-head--sub { page-break-before: always'), 'Sub-Kapitelumbruch');
  // Defaults: kein Heading-Override, keine Ziffern-Regel, kein Sub-Umbruch.
  const off = _buildCss({ epub_chapter_pagebreak: true });
  assert.ok(!/\nh1 \{ font-size/.test(off) && !off.includes('font-variant-numeric'), 'match/normal/default → kein Override');
  assert.ok(!off.includes('.epub-chapter-head--sub { page-break'), 'Sub-Umbruch default aus');
});

test('_buildCoverXhtml: epub_cover_fit cover→slice (+Klasse), default contain→meet', () => {
  const cov = _buildCoverXhtml({ mime: 'image/jpeg', width: 750, height: 1200 }, 'de', 'cover');
  assert.ok(cov.includes('xMidYMid slice') && cov.includes('cover-page--cover'), 'cover → slice + Klasse');
  const contain = _buildCoverXhtml({ mime: 'image/jpeg', width: 750, height: 1200 });
  assert.ok(contain.includes('xMidYMid meet') && contain.includes('class="cover-page"') && !contain.includes('cover-page--cover'), 'default contain → meet');
});

test('_buildImprintBackmatter: front → [], back → eigener Backmatter-Eintrag', () => {
  assert.deepEqual(_buildImprintBackmatter({ imprint: 'X', epub_imprint_position: 'front' }), [], 'front → kein Backmatter');
  assert.deepEqual(_buildImprintBackmatter({ epub_imprint_position: 'back' }), [], 'leeres Impressum → kein Backmatter');
  const ib = _buildImprintBackmatter({ imprint: 'Verlag X', isbn: '123', epub_imprint_position: 'back' });
  assert.equal(ib.length, 1);
  assert.equal(ib[0].filename, 'back_imprint.xhtml');
  assert.equal(ib[0].__toc, false);
  assert.ok(ib[0].content.includes('Verlag X') && ib[0].content.includes('ISBN: 123'));
});

test('buildEpub: titleStyle left-rule + epub_page_rule + Sub-Wrapper', async () => {
  const bundle = { scope: 'book', book: { id: 1, name: 'B' }, groups: [
    { chapterId: 10, chapter: { id: 10, name: 'Eins' }, pages: [{ p: { name: 'S1' }, pd: { html: '<p>a</p>' } }, { p: { name: 'S2' }, pd: { html: '<p>b</p>' } }] },
    { chapterId: 11, chapter: { id: 11, name: 'Zwei', parent_chapter_id: 10 }, pages: [{ p: { name: 'S3' }, pd: { html: '<p>c</p>' } }] },
  ] };
  const buf = await buildEpub(bundle, { lang: 'de', author: 'A', meta: { epub_chapter_title_style: 'left-rule', epub_page_rule: true } });
  const zip = await JSZip.loadAsync(buf);
  const chap0 = await zip.file('OEBPS/chap_0.xhtml').async('string');
  assert.ok(chap0.includes('epub-chapter-head--ts-left-rule') && chap0.includes('epub-chapter-head--top'), 'Top-Wrapper-Klassen');
  assert.ok(chap0.includes('epub-title-rule'), 'left-rule zeichnet den Titel-Strich (auch ohne epub_chapter_rule)');
  const page0 = await zip.file('OEBPS/chap_0_p_0.xhtml').async('string');
  assert.ok(page0.includes('epub-page-rule'), 'Seitentitel-Strich bei epub_page_rule');
  const sub = await zip.file('OEBPS/entry_1.xhtml').async('string');
  assert.ok(sub.includes('epub-chapter-head--sub') && !sub.includes('epub-title-rule'), 'Sub-Kapitel: --sub-Klasse, kein Titel-Strich');
});

test('buildEpub: epub_toc_enabled=false entfernt TOC aus der Spine, Nav bleibt im Manifest', async () => {
  const bundle = { scope: 'book', book: { id: 1, name: 'B' }, groups: [{ chapterId: null, chapter: null, pages: [{ p: { name: 'S1' }, pd: { html: '<p>x</p>' } }] }] };
  const on = await buildEpub(bundle, { lang: 'de', author: 'A', meta: {} });
  assert.ok((await (await JSZip.loadAsync(on)).file('OEBPS/content.opf').async('string')).includes('<itemref idref="toc" />'), 'Default: TOC in Spine');
  const off = await buildEpub(bundle, { lang: 'de', author: 'A', meta: { epub_toc_enabled: false } });
  const opf = await (await JSZip.loadAsync(off)).file('OEBPS/content.opf').async('string');
  assert.ok(!opf.includes('<itemref idref="toc" />'), 'TOC aus Spine entfernt');
  assert.ok(opf.includes('properties="nav"'), 'Nav-Dokument bleibt im Manifest');
  assert.equal(off.readUInt16LE(8), 0, 'mimetype bleibt STORE nach Rezip');
});

test('buildEpub: epub_toc_depth=1 blendet Sub-/Seiten-Eintraege aus dem TOC aus', async () => {
  const bundle = { scope: 'book', book: { id: 1, name: 'B' }, groups: [
    { chapterId: 10, chapter: { id: 10, name: 'Eins' }, pages: [{ p: { name: 'S1' }, pd: { html: '<p>a</p>' } }, { p: { name: 'S2' }, pd: { html: '<p>b</p>' } }] },
  ] };
  const buf = await buildEpub(bundle, { lang: 'de', author: 'A', meta: { epub_toc_depth: 1, epub_nest_pages_in_toc: true } });
  const zip = await JSZip.loadAsync(buf);
  const nav = await zip.file('OEBPS/toc.xhtml').async('string');
  assert.ok(nav.includes('>Eins<'), 'Top-Kapitel sichtbar');
  assert.ok(!nav.includes('>S1<') && !nav.includes('>S2<'), 'Seiten-Eintraege bei depth=1 ausgeblendet');
});
