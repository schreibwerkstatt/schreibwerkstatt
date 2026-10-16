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
  '<p>Er ging.</p><p>»Hallo«, sagte sie.</p>',
  '<p>He said</p><p>“Hello,” she said.</p>',
  '<p>Liste</p><ul><li>…und dann</li></ul>',
  '<p>Ende mit <em>Link</em></p><p>(Fortsetzung)</p>',
];

for (const html of TAG_GAP_CASES) {
  test(`Fundstellen-View findet den Prompt-Text: ${htmlToText(html).slice(0, 42)}…`, () => {
    assert.equal(countInHtml(html, htmlToText(html)), 1, 'Prompt-Text muss in der View auffindbar sein');
  });
}

// Block-Tags trennen immer: die Satzzeichen-Klassen sind nicht eindeutig genug
// für eine Absatzgrenze (`“` oeffnet im Englischen, `»` in »…«, `…` am
// Absatzanfang). Ohne die Regel klebte der kompakte `htmlToText` (ohne
// Absatz-Umbrüche) die Absätze aneinander.
test('Absatzgrenze vor öffnendem Anführungszeichen/Auslassung bleibt Space', () => {
  assert.equal(htmlToText('<p>Er ging.</p><p>»Hallo«, sagte sie.</p>'), 'Er ging. »Hallo«, sagte sie.');
  assert.equal(htmlToText('<p>He said</p><p>“Hello,” she said.</p>'), 'He said “Hello,” she said.');
  assert.equal(htmlToText('<p>Liste</p><ul><li>…und dann</li></ul>'), 'Liste …und dann');
  assert.equal(htmlToText('Zeile<br>“Neu”'), 'Zeile “Neu”');
});

test('Block-Tag in einem Lauf mit Inline-Tags trennt ebenfalls', () => {
  assert.equal(htmlToText('<p>Er ging.</em></p><p><em>»Hallo«</em></p>'), 'Er ging. »Hallo«');
  // Inline-Grenze im selben Absatz bleibt ohne Space.
  assert.equal(htmlToText('<p>Ein <a href="x">Link</a>.</p><p>Weiter</p>'), 'Ein Link. Weiter');
});

test('Prompt-Variante: Absätze bleiben Absätze, auch vor »', () => {
  assert.equal(htmlToTextForPrompt('<p>Er ging.</p><p>»Hallo«</p>'), 'Er ging.\n\n»Hallo«');
});

// Drift-Gate der beiden Zwillinge (Server sync, Browser ESM — die ESM-Bridge
// ist async und taugt fuer den synchronen Prompt-Pfad nicht).
const { TAG_GAP_CLASSES } = await import('../../lib/html-text.js');
const textMatch = await import('../../public/js/utils/text-match.js');

test('Tag-Grenzen-Regeln: Server und Fundstellen-View identisch', () => {
  assert.equal(textMatch.BINDS_LEFT.source, TAG_GAP_CLASSES.bindsLeft.source);
  assert.equal(textMatch.BINDS_RIGHT.source, TAG_GAP_CLASSES.bindsRight.source);
  assert.equal(textMatch.BLOCK_TAG.source, TAG_GAP_CLASSES.blockTag.source);
  assert.equal(textMatch.BLOCK_TAG.flags, TAG_GAP_CLASSES.blockTag.flags);
});
