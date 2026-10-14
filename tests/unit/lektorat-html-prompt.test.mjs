// Regression: htmlToTextForPrompt moet Absatzgrenzen bewaren, damit die
// Dialogformat-Regel „Sprecherwechsel → neuer Absatz" geprüft werden kann.
// Die kompakte `htmlToText` einebnet jede Grenze ein — woraufhin die KI jeden
// Sprecherwechsel als fehlenden Umbruch moniert (Bug: Prüftyp «dialog»
// bemerkt den Zeilenumbruch nicht und meldet ihn als fehlend).

import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToTextForPrompt, htmlToText } from '../../routes/jobs/shared/ai.js';

test('htmlToTextForPrompt: bewahrt <p>-Grenzen als doppelten Newline', () => {
  const html = '<p>„Komm her", sagte Anna.</p><p>„Nein", erwiderte Ben.</p>';
  const out = htmlToTextForPrompt(html);
  assert.ok(out.includes('\n\n'), 'erwartet einen doppelten Newline zwischen den Absätzen');
  const pars = out.split(/\n{2,}/);
  assert.equal(pars.length, 2);
  assert.ok(pars[0].includes('Komm her'));
  assert.ok(pars[1].includes('Nein'));
});

test('htmlToTextForPrompt: <br> wird einzelner Newline (Vers/Adresse)', () => {
  const html = '<p>Rosen sind rot,<br>Veilchen sind blau.</p>';
  const out = htmlToTextForPrompt(html);
  assert.ok(out.includes('rot,\nVeilchen'), 'erwartet einzelnes \\n am <br>');
  assert.ok(!out.includes('\n\n'), 'kein Absatz-Umbruch innerhalb eines <p>');
});

test('htmlToTextForPrompt: inline-Tags (em/strong/a) werden zu Space, kein Umbruch', () => {
  const html = '<p>Er sagte <em>das magische</em> Wort.</p>';
  const out = htmlToTextForPrompt(html);
  assert.equal(out, 'Er sagte das magische Wort.');
});

test('htmlToTextForPrompt: blockquote li h2 gelten als Absatzgrenze', () => {
  const html = '<h2>Kapitel</h2><blockquote>Zitat</blockquote><ul><li>Eins</li><li>Zwei</li></ul>';
  const out = htmlToTextForPrompt(html);
  assert.ok(out.includes('Kapitel\n\nZitat'));
  assert.ok(out.includes('Eins\n\nZwei'));
});

test('htmlToTextForPrompt: Entities werden dekodiert', () => {
  const html = '<p>Sie sagte &bdquo;Hallo&ldquo;.</p>';
  const out = htmlToTextForPrompt(html);
  assert.equal(out, 'Sie sagte „Hallo“.');
});

test('htmlToTextForPrompt: 3+ Newlines werden zu 2 gekappt', () => {
  const html = '<p>A</p><p>B</p><p>C</p>';
  const out = htmlToTextForPrompt(html);
  assert.equal(out, 'A\n\nB\n\nC');
});

test('htmlToTextForPrompt: leere Eingabe → leerer String', () => {
  assert.equal(htmlToTextForPrompt(''), '');
  assert.equal(htmlToTextForPrompt(null), '');
  assert.equal(htmlToTextForPrompt(undefined), '');
});

test('htmlToTextForPrompt: trimt führende/trailing Leerzeichen und Newlines', () => {
  const html = '   <p>Text</p>   ';
  const out = htmlToTextForPrompt(html);
  assert.equal(out, 'Text');
});

test('htmlToText (kompakt) bleibt einzeilig — Frontend-match-Invariante', () => {
  // Frontend findInHtml/replaceInHtml normalisieren `\s+` → ' ' beim Match,
  // so dass die kompakte Text-View zu finden Dom entspricht. Die kompakte
  // `htmlToText` darf darum Absatzgrenzen nicht bewahren — ansonsten driftet
  // sie von der Frontend-Normalisierung weg.
  const html = '<p>A</p><p>B</p>';
  assert.equal(htmlToText(html), 'A B');
});

test('htmlToTextForPrompt: Sprecherwechsel bleibt ein Absatz-Umbruch', () => {
  // Konkretes Bug-Szenario: zwei Sprecher-Blöcke müssen als zwei Absätze an
  // die KI geliefert werden, nicht als eine Lauftextzeile.
  const html = '<p>„Das ist meine Seite", sagte Anna.</p><p>„Dann geh", erwiderte Ben.</p>';
  const out = htmlToTextForPrompt(html);
  const blocks = out.split(/\n{2,}/);
  assert.equal(blocks.length, 2, 'genau zwei Absätze – jeder Sprecher ein Block');
  assert.ok(blocks[0].endsWith('sagte Anna.'));
  assert.ok(blocks[1].startsWith('„Dann geh'));
});

// Bug: Tag-Grenzen wurden blind zu Leerzeichen, also sah der Prompt-Text hinter
// jedem Link ein Space, das der Editor nicht rendert — und das Lektorat meldete
// genau das als Grammatikfehler („Vor dem Satzschlusspunkt steht kein
// Leerzeichen", «Asianometry .» / «» ,»), obwohl im Text nichts zu korrigieren war.
test('Punkt/Komma direkt nach einem Link: kein Phantom-Leerzeichen', () => {
  const html = '<p>so mein Berichterstatter <a href="https://www.asianometry.com/">Asianometry</a>.</p>'
    + '<p>Vibe-Coding als <a href="https://de.wikipedia.org/wiki/Vibe-Coding">«Art der Softwareentwicklung»</a>, mittels KI.</p>';
  const out = htmlToTextForPrompt(html);
  assert.ok(out.includes('Asianometry.'), 'Punkt klebt am Linktext, kein Space davor');
  assert.ok(!out.includes('Asianometry .'));
  assert.ok(out.includes('«Art der Softwareentwicklung»,'), 'Komma klebt an der Klammer');
  assert.ok(!out.includes('» ,'));
});

test('beide htmlToText-Varianten behandeln Satzzeichen an Tag-Grenzen gleich', () => {
  const html = '<p>Er sagte <em>(laut</em>), dann <a href="x">ging</a> er.</p>';
  assert.equal(htmlToTextForPrompt(html), 'Er sagte (laut), dann ging er.');
  assert.equal(htmlToText(html), 'Er sagte (laut), dann ging er.');
});

test('echtes getipptes Leerzeichen vor Satzzeichen bleibt (kein Befund-Verstecker)', () => {
  const html = '<p>Wort <em>x</em> , Tippfehler.</p>';
  assert.equal(htmlToTextForPrompt(html), 'Wort x , Tippfehler.');
});

test('Wortzeichen an beiden Seiten einer Tag-Grenze bleiben getrennt', () => {
  assert.equal(htmlToText('<p>Wort</em><em>Wort</em></p>'), 'Wort Wort');
});

// Drift-Gate über beide Seiten derselben Sicht: was die KI im Prompt-Text
// zitiert, muss die Fundstellen-View des Browsers wiederfinden
// (public/js/utils/html-find.js), sonst fällt der Befund als „nicht gefunden“
// ersatzlos heraus. Beide tragen dieselbe Tag-Grenzen-Regel
// (lib/html-text.js#stripTagsKeepPunctuation ↔ `_tagGapIsSpace`).
// html-find.js legt seinen Entity-Decoder nur an, wenn `document` existiert —
// ohne Stub bleiben Entities in der View wörtlich, was für diese Fixtures
// (keine Entities) reicht und keinen Browser-Rumpel im Test braucht.
const { countInHtml } = await import('../../public/js/utils/html-find.js');

const TAG_GAP_CASES = [
  '<p>so mein Berichterstatter <a href="https://www.asianometry.com/">Asianometry</a>.</p>',
  '<p>Vibe-Coding als <a href="https://de.wikipedia.org/wiki/Vibe-Coding">«Art der Softwareentwicklung»</a>, mittels KI.</p>',
  '<p>Der Satz ist <em>schön</em>. Er geht <strong>weiter</strong>!</p>',
  '<p>(<a href="https://x.ch">Klammer</a>) und <em>Wort</em>: <strong>dann</strong> los.</p>',
  '<p>Zitat „<em>Er sagte</em>“ war falsch.</p>',
  '<p>Wort <em>x</em> , Tippfehler bleibt.</p>',
];

for (const html of TAG_GAP_CASES) {
  test(`Fundstellen-View findet den Prompt-Text: ${htmlToText(html).slice(0, 42)}…`, () => {
    assert.equal(countInHtml(html, htmlToText(html)), 1, 'Prompt-Text muss in der View auffindbar sein');
  });
}
