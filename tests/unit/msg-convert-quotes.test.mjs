// Absätze → Nachrichtenverlauf (editor/notebook/toolbar/msg-convert.js):
// welche Anführungszeichen beim Umwandeln wegfallen und welche stehen bleiben.
// Die Umwandlung selbst (Selektion, Seitenwechsel, Merge mit Nachbarverlauf,
// Undo) prüft tests/e2e-app/notebook-msg-convert.spec.js im echten Browser.
//
// Setup: linkedom liefert window/document für die DOM-Helfer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.NodeFilter = window.NodeFilter || { SHOW_TEXT: 4 };

const { stripLineQuotes } = await import('../../public/js/editor/notebook/toolbar/msg-convert.js');

function strip(html) {
  const p = document.createElement('p');
  p.innerHTML = html;
  stripLineQuotes(p);
  return p.innerHTML;
}

test('Anführung um die ganze Zeile fällt weg, in allen üblichen Formen', () => {
  assert.equal(strip('„Bist du schon da?“'), 'Bist du schon da?');
  assert.equal(strip('«gleich, 5 min»'), 'gleich, 5 min');
  assert.equal(strip('»Wo bist du?«'), 'Wo bist du?');
  assert.equal(strip('"ok"'), 'ok');
  assert.equal(strip('“ok”'), 'ok');
  assert.equal(strip('‹ja›'), 'ja');
  assert.equal(strip('‚ja‘'), 'ja');
});

test('Leerraum am Rand und Inline-Formatierung bleiben erhalten', () => {
  assert.equal(strip('  „Hallo“ '), '  Hallo ');
  assert.equal(strip('„<em>wirklich</em>?“'), '<em>wirklich</em>?');
  assert.equal(strip('<strong>„Jetzt</strong> sofort“'), '<strong>Jetzt</strong> sofort');
});

test('mehrabsätzige Rede: öffnendes Zeichen ohne schliessendes fällt trotzdem', () => {
  assert.equal(strip('„und dann noch das'), 'und dann noch das');
});

test('Zeilen mit Erzählung oder Binnenzitat bleiben unangetastet', () => {
  assert.equal(strip('„Ja“, sagte sie, „gern“'), '„Ja“, sagte sie, „gern“');
  assert.equal(strip('„Er sagte „nein“ dazu“'), '„Er sagte „nein“ dazu“');
  assert.equal(strip('Sie schrieb: „Komm“'), 'Sie schrieb: „Komm“');
});

test('Apostroph ist keine Anführung', () => {
  assert.equal(strip('\'s Wetter ist mies'), '\'s Wetter ist mies');
  assert.equal(strip('hab\'s gesehen\''), 'hab\'s gesehen\'');
});

test('ein einzelnes Anführungszeichen fällt weg, Text ohne Anführung bleibt', () => {
  assert.equal(strip('„'), '');
  assert.equal(strip('ohne'), 'ohne');
});
