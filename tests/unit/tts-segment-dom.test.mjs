// DOM-Seite der TTS-Segmentierung (public/js/tts-segment.js): Sprech-Einheiten,
// Block-Aufzaehlung, Segmente, Klick-Position und Sprech-Normalisierung. Beide
// Vorlese-Oberflaechen (Notebook + Share-Reader) segmentieren ueber
// collectTtsSegments — was hier gilt, gilt fuer beide.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import {
  ttsUnits, ttsBlockText, ttsBlocks, collectTtsSegments, hasTtsText,
  ttsOffsetAt, ttsSegmentAt, normalizeForSpeech,
} from '../../public/js/tts-segment.js';

function root(html) {
  const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body></html>`);
  return document.getElementById('r');
}
const texts = (r) => collectTtsSegments(r, 'de').map(s => s.text);

test('<br> trennt Woerter: „Zeile eins<br>Zeile zwei" klebt nicht zusammen', () => {
  const r = root('<p>Zeile eins<br>Zeile zwei</p>');
  assert.equal(ttsBlockText(r.firstElementChild), 'Zeile eins\nZeile zwei');
  const spoken = texts(r).map(normalizeForSpeech).join(' ');
  assert.match(spoken, /eins, Zeile zwei/);
  assert.doesNotMatch(spoken, /einsZeile/);
});

test('Listenpunkte werden einzeln gelesen, nicht als „ErstensZweitens"', () => {
  const r = root('<ul><li>Erstens kommt der Anfang.</li><li>Zweitens folgt der Rest.</li></ul>');
  const all = texts(r).join(' | ');
  assert.doesNotMatch(all, /AnfangZweitens|Anfang\.Zweitens/);
  assert.match(all, /Erstens kommt der Anfang\./);
  assert.match(all, /Zweitens folgt der Rest\./);
});

test('Listenpunkt mit Unterliste: eigener Text UND Unterpunkt werden gelesen, nichts doppelt', () => {
  const r = root('<ul><li>Punkt A ist der Oberpunkt<ul><li>Sub eins steht darunter</li></ul></li></ul>');
  const joined = texts(r).join(' | ');
  assert.equal((joined.match(/Punkt A/g) || []).length, 1);
  assert.equal((joined.match(/Sub eins/g) || []).length, 1);
});

test('blockquote > p wird einmal gelesen', () => {
  const r = root('<blockquote><p>Ein Zitat mit genug Text darin.</p></blockquote>');
  assert.equal(texts(r).filter(t => t.includes('Zitat')).length, 1);
});

test('Tabellen, Diagramme und Szenentrenner fallen weg', () => {
  const r = root('<p>Vorher steht ein Satz.</p><table><tr><td>Zelle eins</td></tr></table>'
    + '<pre class="mermaid">flowchart TD A</pre><p>* * *</p><p>Nachher steht ein Satz.</p>');
  const all = texts(r).join(' | ');
  assert.doesNotMatch(all, /Zelle|flowchart|\*/);
  assert.match(all, /Vorher/);
  assert.match(all, /Nachher/);
  assert.equal(ttsBlocks(r).some(b => b.tagName === 'TD'), false);
});

test('hasTtsText: nur Tabelle/Diagramm → kein Vorlese-Text', () => {
  assert.equal(hasTtsText(root('<table><tr><td>Zahl 42</td></tr></table>')), false);
  assert.equal(hasTtsText(root('<pre class="mermaid">graph TD</pre>')), false);
  assert.equal(hasTtsText(root('<p>Text.</p>')), true);
});

test('eingeblendete Korrekturvorschlaege werden nicht mitgelesen', () => {
  const r = root('<p>Er <mark class="lektorat-mark">gieng</mark><ins class="lektorat-ins">ging</ins> nach Hause.</p>'
    + '<p>Sie <mark class="chat-mark">sagt</mark><ins class="chat-mark-ins">sprach</ins> leise.</p>');
  assert.equal(ttsBlockText(r.children[0]), 'Er gieng nach Hause.');
  assert.equal(ttsBlockText(r.children[1]), 'Sie sagt leise.');
});

test('ttsUnits: Sprechtext und Einheiten teilen den Offsetraum', () => {
  const p = root('<p>a <em>b</em><br>c</p>').firstElementChild;
  const units = ttsUnits(p);
  assert.equal(units.map(u => u.text).join(''), ttsBlockText(p));
  assert.ok(units.some(u => u.sep && u.sep.tagName === 'BR'));
});

test('ttsOffsetAt / ttsSegmentAt finden das Segment unter einem Textpunkt', () => {
  const r = root('<p>Der erste Satz ist wirklich lang genug fuer ein ganz eigenes Fragment. Der zweite Satz ist ebenfalls lang genug fuer ein eigenes Stueck.</p>');
  const p = r.firstElementChild;
  const segs = collectTtsSegments(r, 'de');
  assert.equal(segs.length, 2);
  const node = p.firstChild;
  const off = node.nodeValue.indexOf('zweite');
  assert.equal(ttsOffsetAt(p, node, off), off);
  assert.equal(ttsSegmentAt(segs, node, off), 1);
  assert.equal(ttsSegmentAt(segs, node, 3), 0);
  // Punkt im zweiten Absatz, wenn es nur einen gibt → -1
  assert.equal(ttsSegmentAt(segs, root('<p>x</p>').firstChild.firstChild, 0), -1);
});

test('ttsOffsetAt: Punkt in einem verschachtelten Block gehoert nicht zum Elternblock', () => {
  const r = root('<ul><li>Oben<ul><li>Unten</li></ul></li></ul>');
  const outer = r.querySelector('li');
  const innerText = r.querySelector('li li').firstChild;
  assert.equal(ttsOffsetAt(outer, innerText, 1), null);
});

test('normalizeForSpeech: Gedankenstrich, Auslassung, Auszeichnungsreste', () => {
  assert.equal(normalizeForSpeech('Er kam – und ging.'), 'Er kam, und ging.');
  assert.equal(normalizeForSpeech('Er zögerte …'), 'Er zögerte.');
  assert.equal(normalizeForSpeech('Und dann ... nichts.'), 'Und dann, nichts.');
  assert.equal(normalizeForSpeech('Ein *betontes* Wort.'), 'Ein betontes Wort.');
  assert.equal(normalizeForSpeech('Midlife-Krise bleibt.'), 'Midlife-Krise bleibt.');
  assert.equal(normalizeForSpeech('Satz.\nNeue Zeile'), 'Satz. Neue Zeile');
});
