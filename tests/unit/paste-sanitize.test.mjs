// Unit-Tests für sanitizePasteHtml (public/js/utils.js) — die reine
// Whitelist-Sanitisierung von Clipboard-HTML, bevor handleEditorPaste
// (editor/shared/paste.js) sie via execCommand('insertHTML') in einen der drei
// Editoren schiebt. Bisher war diese Funktion nur indirekt über einen E2E-
// Paste-Test abgedeckt; hier wird das Tag-/Attribut-Verhalten isoliert geprüft
// (inkl. Absatz-/<br>-Erhalt, der den Paste-Pfad mit dem Tipp-Pfad konsistent
// hält).
//
// Setup analog tests/unit/editor-shared-save.test.mjs: linkedom liefert ein
// browser-kompatibles DOM; DOMParser wird gestubt, weil linkedoms eigener
// DOMParser 'text/html'-Fragmente nicht spec-konform in <body> wickelt.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.Node = window.Node;
globalThis.HTMLElement = window.HTMLElement;
if (!window.matchMedia) {
  window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
}

class StubDOMParser {
  parseFromString(html, _type) {
    const wrapped = `<!doctype html><html><body>${html}</body></html>`;
    return parseHTML(wrapped).document;
  }
}
globalThis.DOMParser = StubDOMParser;

const { sanitizePasteHtml } = await import('../../public/js/utils.js');

// ────────── leere / falsy Eingaben ──────────

test('sanitizePasteHtml: falsy Eingabe → leerer String', () => {
  assert.equal(sanitizePasteHtml(''), '');
  assert.equal(sanitizePasteHtml(null), '');
  assert.equal(sanitizePasteHtml(undefined), '');
});

// ────────── Whitelist-Tags bleiben ──────────

test('sanitizePasteHtml: <p> bleibt erhalten', () => {
  const out = sanitizePasteHtml('<p>Hallo Welt</p>');
  assert.ok(out.includes('<p>Hallo Welt</p>'));
});

test('sanitizePasteHtml: <br> im Absatz bleibt (Soft-Break)', () => {
  const out = sanitizePasteHtml('<p>Zeile eins<br>Zeile zwei</p>');
  assert.ok(/<br\s*\/?>/i.test(out), `kein <br> im Output: ${out}`);
  assert.ok(out.includes('Zeile eins'));
  assert.ok(out.includes('Zeile zwei'));
});

test('sanitizePasteHtml: mehrere Absätze bleiben getrennt', () => {
  const out = sanitizePasteHtml('<p>Eins</p><p>Zwei</p>');
  assert.ok(out.includes('<p>Eins</p>'));
  assert.ok(out.includes('<p>Zwei</p>'));
});

test('sanitizePasteHtml: Inline-Formatierung + Heading + Liste bleiben', () => {
  const out = sanitizePasteHtml(
    '<h2>Titel</h2><p>Hallo <strong>fett</strong> und <em>kursiv</em></p><ul><li>A</li><li>B</li></ul>',
  );
  assert.ok(out.includes('<h2>Titel</h2>'));
  assert.ok(out.includes('<strong>fett</strong>'));
  assert.ok(out.includes('<em>kursiv</em>'));
  assert.ok(out.includes('<li>A</li>'));
  assert.ok(out.includes('<li>B</li>'));
});

// ────────── unbekannte Tags werden unwrapped (Text bleibt) ──────────

test('sanitizePasteHtml: <span> wird entfernt, Text bleibt', () => {
  const out = sanitizePasteHtml('<p><span>Inhalt</span></p>');
  assert.equal(out.indexOf('<span'), -1);
  assert.ok(out.includes('Inhalt'));
});

test('sanitizePasteHtml: <font>-Hülle weg, Text bleibt', () => {
  const out = sanitizePasteHtml('<p><font color="red">getönt</font></p>');
  assert.equal(out.toLowerCase().indexOf('<font'), -1);
  assert.ok(out.includes('getönt'));
});

test('sanitizePasteHtml: verschachtelte unbekannte Tags voll unwrapped (Guard-Loop)', () => {
  const out = sanitizePasteHtml('<section><article><span>tief</span></article></section>');
  assert.equal(out.toLowerCase().indexOf('<section'), -1);
  assert.equal(out.toLowerCase().indexOf('<article'), -1);
  assert.equal(out.indexOf('<span'), -1);
  assert.ok(out.includes('tief'));
});

// ────────── gefährliche / Office-Tags fliegen samt Subtree raus ──────────

test('sanitizePasteHtml: <script> wird mit Inhalt entfernt', () => {
  const out = sanitizePasteHtml('<p>davor</p><script>alert(1)</script><p>danach</p>');
  assert.equal(out.indexOf('alert'), -1);
  assert.equal(out.toLowerCase().indexOf('<script'), -1);
  assert.ok(out.includes('davor'));
  assert.ok(out.includes('danach'));
});

test('sanitizePasteHtml: <style>-Block samt Inhalt weg', () => {
  const out = sanitizePasteHtml('<style>p{color:red}</style><p>Text</p>');
  assert.equal(out.toLowerCase().indexOf('<style'), -1);
  assert.equal(out.indexOf('color:red'), -1);
  assert.ok(out.includes('<p>Text</p>'));
});

// ────────── <div>: nur .poem / .msg-thread überlebt ──────────

test('sanitizePasteHtml: nacktes <div> wird unwrapped', () => {
  const out = sanitizePasteHtml('<div>Inhalt</div>');
  assert.equal(out.toLowerCase().indexOf('<div'), -1);
  assert.ok(out.includes('Inhalt'));
});

test('sanitizePasteHtml: <div class="poem"> bleibt, Klasse auf "poem" normalisiert', () => {
  const out = sanitizePasteHtml('<div class="poem extra"><p>Vers 1</p><p>Vers 2</p></div>');
  assert.ok(out.includes('class="poem"'), `poem-div fehlt: ${out}`);
  assert.equal(out.indexOf('extra'), -1);
  assert.ok(out.includes('Vers 1'));
  assert.ok(out.includes('Vers 2'));
});

test('sanitizePasteHtml: Nachrichtenverlauf behält Wrapper und Zeilenarten', () => {
  const out = sanitizePasteHtml('<div class="msg-thread x"><p class="msg-out MsoNormal">Hi</p><p class="msg-name">Lena</p></div>');
  assert.ok(out.includes('<div class="msg-thread">'), `Verlauf fehlt: ${out}`);
  assert.ok(out.includes('<p class="msg-out">Hi</p>'), `Zeilenart fehlt: ${out}`);
  assert.ok(out.includes('<p class="msg-name">Lena</p>'));
});

test('sanitizePasteHtml: Zeilenklasse ausserhalb eines Verlaufs und Fremdklassen fallen', () => {
  const out = sanitizePasteHtml('<p class="msg-out">lose</p><p class="MsoNormal">Word</p>');
  assert.equal(out.indexOf('class='), -1, out);
});

// ────────── Attribute werden gestrippt (ausser Whitelist) ──────────

test('sanitizePasteHtml: style/id/on*-Attribute werden entfernt', () => {
  const out = sanitizePasteHtml('<p style="color:red" id="x" onclick="boom()">Text</p>');
  assert.equal(out.indexOf('style'), -1);
  assert.equal(out.indexOf('id='), -1);
  assert.equal(out.indexOf('onclick'), -1);
  assert.ok(out.includes('Text'));
});

test('sanitizePasteHtml: <a> behält href, verliert onclick', () => {
  const out = sanitizePasteHtml('<a href="https://example.com" onclick="boom()">Link</a>');
  assert.ok(out.includes('href="https://example.com"'));
  assert.equal(out.indexOf('onclick'), -1);
  assert.ok(out.includes('Link'));
});

test('sanitizePasteHtml: <a> ohne href wird unwrapped (Text bleibt)', () => {
  const out = sanitizePasteHtml('<a>kein-link</a>');
  assert.equal(out.toLowerCase().indexOf('<a'), -1);
  assert.ok(out.includes('kein-link'));
});

// ────────── Tabellen im Clipboard ──────────
// Ohne Behandlung packte der Tag-Filter <table>/<tr>/<td> aus, und die
// Zelltexte klebten ohne Trenner aneinander («JahrUmsatz2023…»).

const SHEET = '<table style="width:300px"><tr><th style="font-weight:bold">Jahr</th>'
  + '<th data-align="right">Umsatz</th></tr>'
  + '<tr><td class="xl65" style="color:red">2023</td><td data-align="right"><b>1.2</b> Mio</td></tr></table>';

test('sanitizePasteHtml: tables → normalisierte Tabelle über table-html.js', () => {
  const out = sanitizePasteHtml(SHEET, { tables: true });
  assert.match(out, /^<table><thead><tr><th scope="col">Jahr<\/th><th scope="col" data-align="right">Umsatz<\/th><\/tr><\/thead>/);
  assert.match(out, /<td>2023<\/td><td data-align="right"><b>1\.2<\/b> Mio<\/td>/);
  assert.doesNotMatch(out, /style=|class=/);
});

test('sanitizePasteHtml: ohne tables → eine Zeile je Absatz, Zellen mit « | »', () => {
  const out = sanitizePasteHtml('<p>Vorher</p>' + SHEET, {});
  assert.equal(out, '<p>Vorher</p><p>Jahr | Umsatz</p><p>2023 | 1.2 Mio</p>');
  assert.doesNotMatch(out, /JahrUmsatz/);
});

test('sanitizePasteHtml: leere Tabelle fällt weg', () => {
  assert.equal(sanitizePasteHtml('<table><tr><td> </td></tr></table><p>x</p>', { tables: true }), '<p>x</p>');
});

// ────────── Office-Markup ──────────

test('sanitizePasteHtml: Google Docs — Hülle fällt, Span-Fett/-Kursiv werden strong/em', () => {
  const out = sanitizePasteHtml('<b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr">'
    + '<span style="font-weight:400">Normal </span><span style="font-weight:700">fett</span>'
    + '<span style="font-style:italic">kursiv</span></p></b>');
  assert.equal(out, '<p>Normal <strong>fett</strong><em>kursiv</em></p>');
});

test('sanitizePasteHtml: Word-Aufzählung wird echte Liste mit Ebenen, ohne Zeichen und Kommentare', () => {
  const out = sanitizePasteHtml(
    "<p class=MsoListParagraphCxSpFirst style='mso-list:l0 level1 lfo1'><!--[if !supportLists]-->"
    + "<span style='mso-list:Ignore'>·<span>&nbsp;&nbsp;</span></span><!--[endif]-->Eins</p>"
    + "<p class=MsoListParagraphCxSpMiddle style='mso-list:l0 level2 lfo1'><span style='mso-list:Ignore'>o<span>&nbsp;</span></span>Unter</p>"
    + "<p class=MsoListParagraphCxSpLast style='mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>·<span>&nbsp;</span></span>Zwei</p>"
    + '<p class=MsoNormal>Danach</p>');
  assert.equal(out, '<ul><li>Eins<ul><li>Unter</li></ul></li><li>Zwei</li></ul><p>Danach</p>');
});

test('sanitizePasteHtml: nummerierte Word-Liste wird <ol>', () => {
  const out = sanitizePasteHtml(
    "<p class=MsoListParagraph style='mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>1.<span>&nbsp;</span></span>Eins</p>");
  assert.equal(out, '<ol><li>Eins</li></ol>');
});

// ────────── editor-interne Kopie (structure) ──────────

const OWN = '<figure><img src="/img/a.png" alt="x"><figcaption>Unter</figcaption><p class="figure-credit">Foto: K</p></figure>'
  + '<pre class="mermaid">graph TD</pre>'
  + '<ul class="todo"><li class="todo-item"><input type="checkbox" checked=""><span class="todo-text">T</span></li></ul>';

test('sanitizePasteHtml: interne Kopie behält Abbildung, Diagramm und Checkbox-Liste', () => {
  const norm = (h) => h.replace('checked=""', 'checked'); // linkedom serialisiert ohne Wert
  assert.equal(norm(sanitizePasteHtml(OWN, { tables: true, structure: true })), norm(OWN));
});

test('sanitizePasteHtml: ohne structure fallen Bild, Diagramm-Klasse und Checkbox', () => {
  const out = sanitizePasteHtml(OWN, { tables: true });
  assert.ok(!/<img|<input|class="mermaid"|<figure/.test(out), out);
});

test('sanitizePasteHtml: interne Kopie — Bild nur mit Raster-data: oder eigener URL', () => {
  const out = sanitizePasteHtml('<figure><img src="data:image/svg+xml;base64,AAA"><figcaption>c</figcaption></figure>', { structure: true });
  assert.ok(!out.includes('<img'), out);
  assert.ok(sanitizePasteHtml('<img src="data:image/png;base64,AAA">', { structure: true }).includes('<img'));
  assert.ok(!sanitizePasteHtml('<img src="javascript:alert(1)">', { structure: true }).includes('<img'));
});
