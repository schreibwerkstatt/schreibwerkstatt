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
