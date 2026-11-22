// resolveCurrentQuote: trennt match / moved / changed / gone für den
// Owner-Kommentar-Diff (Stelle seit dem Kommentar geändert?).

import test from 'node:test';
import assert from 'node:assert/strict';

// share-anchor.js nutzt CSS.escape + querySelector — minimal stubben.
globalThis.CSS = globalThis.CSS || { escape: (s) => String(s) };

// Fake-rootEl: querySelector('[data-bid="X"]') → block mit textContent.
function root(bid, text) {
  const block = text == null ? null : { textContent: text };
  return { querySelector: (sel) => (text != null && sel.includes(bid) ? block : null) };
}

const { resolveCurrentQuote } = await import('../../public/js/share-anchor.js');

test('kein Block (bid weg / andere Seite) → gone', () => {
  assert.equal(resolveCurrentQuote(root('b1', null), { bid: 'b1', quote: 'x', start: 0, end: 1 }).status, 'gone');
  assert.equal(resolveCurrentQuote(null, { bid: 'b1' }).status, 'gone');
  assert.equal(resolveCurrentQuote(root('b1', 'txt'), { bid: '' }).status, 'gone');
});

test('Quote unverändert an Offsets → match', () => {
  const r = resolveCurrentQuote(root('b1', 'Hallo Welt!'), { bid: 'b1', quote: 'Welt', start: 6, end: 10 });
  assert.equal(r.status, 'match');
  assert.equal(r.currentText, 'Welt');
});

test('Quote verschoben (Offsets passen nicht, aber vorhanden) → moved', () => {
  const r = resolveCurrentQuote(root('b1', 'Noch ein Hallo Welt!'), { bid: 'b1', quote: 'Welt', start: 6, end: 10 });
  assert.equal(r.status, 'moved');
  assert.equal(r.currentText, 'Welt');
});

test('Quote weg → changed, currentText um die Offsets gekappt', () => {
  const r = resolveCurrentQuote(root('b1', 'Hallo schöne neue Erde!'), { bid: 'b1', quote: 'Welt', start: 6, end: 10 });
  assert.equal(r.status, 'changed');
  assert.ok(r.currentText.length > 0);
  assert.ok(!r.currentText.includes('Welt'));
});

// quoteWindow: Ausschnitt des heutigen Block-Texts für den „Stelle geändert"-Diff.
const { quoteWindow } = await import('../../public/js/share-anchor.js');

test('quoteWindow: kurzer Block bleibt ganz', () => {
  assert.equal(quoteWindow('Kurz und knapp.', { quote: 'knapp', start: 9, end: 14 }), 'Kurz und knapp.');
});

test('quoteWindow: geänderte Stelle im langen Absatz → Ausschnitt auf Wortgrenzen mit …', () => {
  const vor = 'Erster Satz steht hier ganz vorne und hat nichts mit der Stelle zu tun. ';
  const nach = ' Danach folgt noch ein langer Rest, der ebenfalls nicht in den Diff gehört.';
  const txt = vor + 'Die Polizei zog ab, aber sie kam wieder.' + nach;
  const anchor = { quote: 'Die Polizei zog ab, aber sie würden wiederkommen.', start: vor.length, end: vor.length + 49 };
  const w = quoteWindow(txt, anchor);
  assert.ok(w.startsWith('… '), w);
  assert.ok(w.endsWith(' …'), w);
  assert.ok(w.includes('Die Polizei zog ab, aber sie kam wieder.'), w);
  assert.ok(!w.includes('Erster Satz'), w);
  assert.ok(!w.includes('ebenfalls'), w);
});

// Der Kern wird nur in einem Fenster um die alten Offsets gesucht (locateApprox:
// kein Treffer weit weg) — ein kurzer Einschub davor bleibt darin.
test('quoteWindow: kurzer Einschub davor → Fenster folgt dem überlebenden Kern, nicht den alten Offsets', () => {
  const einschub = 'Neu am Anfang eingefügt. ';
  const txt = einschub + 'Am Abend regnete es heftig über der Stadt.' + ' Schluss des Absatzes mit weiterem Text, viel weiterem Text.';
  const w = quoteWindow(txt, { quote: 'Am Abend regnete es leicht über der Stadt.', start: 0, end: 42 });
  assert.ok(w.includes('Am Abend regnete es heftig über der Stadt.'), w);
  assert.ok(!w.includes('eingefügt'), w);
});
