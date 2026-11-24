// Änderungsvorschlag eines Reviewers übernehmen (public/js/editor/comment-suggestion.js):
//   - nur im verankerten Block, ein gleichlautender Satz anderswo bleibt
//   - genau ein Treffer im Block, sonst Abbruch (keine Wahl)
//   - Ersatz ist Klartext; eine Stelle mit Quellen-Chip blockt
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

// DOM für das Modul (template/querySelector) aus linkedom; der Entity-Decoder
// von html-find.js (textarea.innerHTML → value) bekommt einen Minimal-Stub wie
// in html-find-tolerant.test.mjs, linkedom dekodiert dort nicht.
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': '\u00a0' };
const { document } = parseHTML('<!doctype html><html><body></body></html>');
const createElement = document.createElement.bind(document);
document.createElement = (tag) => {
  if (tag !== 'textarea') return createElement(tag);
  let v = '';
  return { set innerHTML(x) { v = ENT[x] ?? x; }, get value() { return v; } };
};
// linkedom kennt document.implementation nicht; der Browser liefert damit ein
// inertes Dokument, hier tut es ein frisch geparstes.
document.implementation ??= {
  createHTMLDocument: () => parseHTML('<!doctype html><html><body></body></html>').document,
};
globalThis.document = document;
globalThis.CSS ??= { escape: (s) => String(s).replace(/["\\]/g, '\\$&') };

const { applySuggestionToHtml, suggestionReasonKey } = await import('../../public/js/editor/comment-suggestion.js');

const PAGE = '<p data-bid="aa11">Der Hund bellt laut.</p><p data-bid="bb22">Der Hund bellt laut. Und <em>wieder</em>.</p>';

test('ersetzt nur im verankerten Block, der gleiche Satz im Nachbarblock bleibt', () => {
  const r = applySuggestionToHtml(PAGE, { bid: 'aa11', quote: 'bellt laut', replacement: 'kläfft leise' });
  assert.ok(r.html, JSON.stringify(r));
  assert.match(r.html, /<p data-bid="aa11">Der Hund kläfft leise\.<\/p>/);
  assert.match(r.html, /<p data-bid="bb22">Der Hund bellt laut\. Und <em>wieder<\/em>\.<\/p>/);
});

test('Block weg, Text geändert, mehrfach im Block → Abbruch mit Grund', () => {
  assert.deepEqual(applySuggestionToHtml(PAGE, { bid: 'zz99', quote: 'Hund', replacement: 'Katze' }), { reason: 'blockGone' });
  assert.deepEqual(applySuggestionToHtml(PAGE, { bid: 'aa11', quote: 'miaut', replacement: 'x' }), { reason: 'quoteGone' });
  const twice = '<p data-bid="cc33">ja und ja</p>';
  assert.deepEqual(applySuggestionToHtml(twice, { bid: 'cc33', quote: 'ja', replacement: 'nein' }), { reason: 'ambiguous' });
});

test('Ersatz ist Klartext, nie Markup', () => {
  const r = applySuggestionToHtml(PAGE, { bid: 'aa11', quote: 'laut', replacement: '<b>leise</b>' });
  assert.ok(r.html);
  assert.doesNotMatch(r.html, /<b>/);
  assert.match(r.html, /&lt;b&gt;leise&lt;\/b&gt;/);
});

test('Stelle über einen Quellen-Chip hinweg → blockiert', () => {
  const html = '<p data-bid="dd44">Wie <span class="cite" data-src="7">(Müller, 2020)</span> zeigt, gilt das.</p>';
  const r = applySuggestionToHtml(html, { bid: 'dd44', quote: 'Wie (Müller, 2020) zeigt', replacement: 'Laut Müller' });
  assert.ok(r.reason, 'kein Ersatz über den Chip');
});

test('suggestionReasonKey: i18n-Key je Grund', () => {
  assert.equal(suggestionReasonKey('ambiguous'), 'share.comments.suggestion.ambiguous');
  assert.equal(suggestionReasonKey(''), 'share.comments.suggestion.failed');
});

// Steht der Ersatztext schon genau einmal im Block (von Hand übernommen, oder
// der Status-PATCH nach dem Speichern scheiterte), ist das kein «Text geändert»:
// die Leiste setzt dann nur den Status.
test('schon übernommen: alte Stelle fehlt, neuer Text genau einmal im Block', () => {
  const html = '<p data-bid="aa11">Der Hund kläfft leise.</p>';
  const r = applySuggestionToHtml(html, { bid: 'aa11', quote: 'bellt laut', replacement: 'kläfft leise' });
  assert.equal(r.reason, 'alreadyApplied');
});

test('nicht übernommen und neuer Text fehlt: bleibt quoteGone', () => {
  const html = '<p data-bid="aa11">Der Hund schläft.</p>';
  const r = applySuggestionToHtml(html, { bid: 'aa11', quote: 'bellt laut', replacement: 'kläfft leise' });
  assert.equal(r.reason, 'quoteGone');
});
