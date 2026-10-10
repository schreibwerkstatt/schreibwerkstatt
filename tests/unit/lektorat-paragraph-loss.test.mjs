// Regression: Lektorat-Korrekturen duerfen niemals ganze Absaetze (bzw. deren
// Text) verschwinden lassen.
//
// Der Apply-Pfad lebt in public/js/editor/lektorat.js#_applyCorrections: pro
// Finding wird replaceInHtml(html, original, korrektur) aus utils.js gerufen.
// Getestet wird hier die Engine direkt — die _applyCorrections-Schleife ist als
// 1:1-Mirror nachgebaut (sie delegiert vollstaendig an replaceInHtml; die echte
// Methode in eine Node-Umgebung zu importieren scheitert an Browser-Deps wie
// window.matchMedia).
//
// Kern-Invariante: replaceInHtml ersetzt NUR das erste Vorkommen von `original`
// durch `korrektur`. Aller uebrige Text bleibt unangetastet — es gibt keinen
// Pfad, auf dem unbeteiligte Absaetze geloescht werden. Selbst eine Korrektur,
// die eine Absatzgrenze ueberspannt, verliert keinen Text (sie segmentiert im
// schlimmsten Fall um, Inhalt bleibt vollstaendig).

import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceInHtml, SAFETY_HTML_RATIO } from '../../public/js/utils.js';

// 1:1-Mirror von lektoratMethods._applyCorrections (editor/lektorat.js):
//   - ueberspringt Findings ohne original/korrektur oder mit original===korrektur
//   - wendet jede Korrektur sequenziell via replaceInHtml an
function applyCorrections(html, fehler) {
  let result = html;
  for (const f of fehler) {
    if (!f.original || !f.korrektur || f.original === f.korrektur) continue;
    result = replaceInHtml(result, f.original, f.korrektur);
  }
  return result;
}

// Text-View wie _buildHtmlTextMap: Tags -> Space, Whitespace kollabiert,
// getrimmt. Misst "verschwundenen" Text strukturunabhaengig.
const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const countTag = (html, tag) => (html.match(new RegExp('<' + tag + '\\b', 'gi')) || []).length;

test('Stale-/Offline-Fall: nicht gefundenes original laesst HTML unveraendert', () => {
  // Nach einem Verbindungsabbruch laedt _loadApplyAndSave die Seite frisch (fresh:true).
  // Weicht sie vom Job-Snapshot ab, wird das Finding-`original` nicht mehr gefunden —
  // replaceInHtml ist dann ein No-Op, KEINE Loeschung.
  const html = '<p>Absatz eins.</p><p>Absatz zwei.</p>';
  const out = applyCorrections(html, [{ original: 'gibt es nicht', korrektur: 'xxx', typ: 'grammatik' }]);
  assert.equal(out, html);
});

test('Einzelkorrektur: Blockanzahl + unbeteiligte Absaetze bleiben erhalten', () => {
  const html = '<p>Der Hund bellt laut.</p><p>Die Katze schläft.</p><p>Der Vogel singt.</p>';
  const out = applyCorrections(html, [{ original: 'bellt laut', korrektur: 'bellt leise', typ: 'stil' }]);
  assert.equal(countTag(out, 'p'), 3);
  assert.ok(out.includes('Die Katze schläft.'));
  assert.ok(out.includes('Der Vogel singt.'));
  assert.ok(out.includes('bellt leise'));
});

test('Ganze-Absatz-Korrektur behaelt den <p>-Wrapper (kein verschwundener Block)', () => {
  // original == kompletter Absatztext, korrektur deutlich kuerzer: der <p>-Wrapper
  // bleibt, nur der Inhalt schrumpft. Der Folgeabsatz ist unberuehrt.
  const html = '<p>Dies ist ein langer einleitender Satz.</p><p>Folgeabsatz.</p>';
  const out = applyCorrections(html, [{ original: 'Dies ist ein langer einleitender Satz.', korrektur: 'Kurz.', typ: 'stil' }]);
  assert.equal(countTag(out, 'p'), 2);
  assert.equal(textOf(out), 'Kurz. Folgeabsatz.');
});

test('Korrektur ueber eine <em>-Spanne behaelt Absatz + Tag-Balance', () => {
  // Wort-Diff-Ersatz: nur das geänderte Wort wird ersetzt, die <em>-Spanne um
  // die unveränderten Wörter bleibt stehen — Tag-Balance und Absatz intakt.
  const html = '<p>Er sagte <em>das magische</em> Wort.</p>';
  const out = applyCorrections(html, [{ original: 'das magische Wort', korrektur: 'das geheime Wort', typ: 'grammatik' }]);
  assert.equal(countTag(out, 'p'), 1);
  assert.equal((out.match(/<em\b/g) || []).length, (out.match(/<\/em>/g) || []).length);
  assert.equal(out, '<p>Er sagte <em>das geheime</em> Wort.</p>');
});

test('Mehrere Findings nacheinander: kein Absatz-Text geht verloren', () => {
  const html = '<p>Erstens falsch.</p><p>Zweitens auch falsch.</p><p>Drittens korrekt.</p>';
  const fehler = [
    { original: 'Erstens falsch', korrektur: 'Erstens richtig', typ: 'grammatik' },
    { original: 'Zweitens auch falsch', korrektur: 'Zweitens stimmt', typ: 'grammatik' },
  ];
  const out = applyCorrections(html, fehler);
  assert.equal(countTag(out, 'p'), 3);
  assert.ok(out.includes('Erstens richtig'));
  assert.ok(out.includes('Zweitens stimmt'));
  assert.ok(out.includes('Drittens korrekt.')); // unangetastet
});

test('Doppeltes original: nur erstes Vorkommen ersetzt, zweiter Absatz bleibt', () => {
  const html = '<p>Hallo Welt.</p><p>Hallo Welt.</p>';
  const out = applyCorrections(html, [{ original: 'Hallo Welt.', korrektur: 'Servus Welt.', typ: 'stil' }]);
  assert.equal(countTag(out, 'p'), 2);
  assert.ok(out.includes('Servus Welt.'));
  assert.ok(out.includes('Hallo Welt.')); // zweites Vorkommen unangetastet
});

test('Absatz-uebergreifende Korrektur wird uebersprungen (Struktur + Text unveraendert)', () => {
  // Grenzfall: `original` ueberspannt die Absatzgrenze </p><p>. Eine Ersetzung
  // wuerde verschachtelte/aufgespaltene Bloecke erzeugen — darum wird sie NICHT
  // angewandt. HTML bleibt 1:1 erhalten, kein Wort und kein Absatz verschwindet.
  const html = '<p>Er ging nach Hause.</p><p>Dann schlief er ein.</p>';
  const out = applyCorrections(html, [{ original: 'nach Hause. Dann', korrektur: 'heim. Sofort danach', typ: 'stil' }]);
  assert.equal(out, html);
  assert.equal(countTag(out, 'p'), 2);
});

test('Korrektur ueber eine Listen-Grenze </li><li> wird uebersprungen', () => {
  const html = '<ul><li>Erstens.</li><li>Zweitens.</li></ul>';
  const out = applyCorrections(html, [{ original: 'Erstens. Zweitens', korrektur: 'Eins. Zwei', typ: 'stil' }]);
  assert.equal(out, html);
  assert.equal(countTag(out, 'li'), 2);
});

test('Korrektur ueber eine Heading-Grenze </h2><p> wird uebersprungen', () => {
  const html = '<h2>Kapitel eins</h2><p>Der Anfang.</p>';
  const out = applyCorrections(html, [{ original: 'Kapitel eins Der', korrektur: 'Kapitel 1 Ein', typ: 'stil' }]);
  assert.equal(out, html);
  assert.equal(countTag(out, 'h2'), 1);
  assert.equal(countTag(out, 'p'), 1);
});

test('Korrektur ueber einen <br> wird uebersprungen (Zeilenumbruch bleibt erhalten)', () => {
  // `original` ueberspannt einen <br> (Vers/Strophe/Adresse). Die Text-View macht
  // aus dem <br> einen Space, sodass der Match greift — beim Ersetzen ginge der
  // sichtbare Umbruch aber ersatzlos verloren. Darum: No-Op, HTML 1:1 erhalten.
  const html = '<p>Rosen sind rot,<br>Veilchen sind blau.</p>';
  const out = applyCorrections(html, [{ original: 'rot, Veilchen', korrektur: 'rot und Veilchen', typ: 'grammatik' }]);
  assert.equal(out, html);
  assert.equal(countTag(out, 'br'), 1);
});

test('Korrektur neben (nicht ueber) einem <br> wird normal angewandt', () => {
  // Der Match liegt komplett in EINER Zeile, der <br> bleibt ausserhalb der Range
  // → normale Ersetzung, Umbruch unberuehrt.
  const html = '<p>Rosen sind rot,<br>Veilchen sind blau.</p>';
  const out = applyCorrections(html, [{ original: 'Veilchen sind blau', korrektur: 'Veilchen sind lila', typ: 'stil' }]);
  assert.equal(countTag(out, 'br'), 1);
  assert.ok(out.includes('Veilchen sind lila'));
  assert.ok(out.includes('Rosen sind rot,'));
});

test('korrektur mit rohem \\n fuegt keinen Zeilenumbruch hinzu', () => {
  // Ein KI-Artefakt-Newline in `korrektur` darf nicht verbatim ins HTML wandern
  // (in <pre>/.poem wuerde es als sichtbarer Umbruch gerendert). Es wird zu Space.
  const html = '<p>Der Satz ist gut.</p>';
  const out = applyCorrections(html, [{ original: 'Der Satz ist gut.', korrektur: 'Der Satz\nist sehr gut.', typ: 'stil' }]);
  assert.ok(!out.includes('\n'));
  assert.ok(out.includes('Der Satz ist sehr gut.'));
  assert.equal(countTag(out, 'br'), 0);
});

test('SAFETY_HTML_RATIO faengt katastrophale Schrumpfung ab, blockt normale Korrektur nicht', () => {
  // Replikat des Guards aus _loadApplyAndSave: finalHtml < page.html * RATIO -> Fehler.
  const guard = (before, after) => after.length < before.length * SAFETY_HTML_RATIO;
  const bigText = 'Ein langer Absatz voller Inhalt der immer weiter laeuft. '.repeat(12).trim();
  const html = '<p>' + bigText + '</p><p>Noch ein Absatz.</p>';

  // Normale, lokale Korrektur darf NICHT als unsicher gelten.
  const normal = applyCorrections(html, [{ original: 'Noch ein Absatz.', korrektur: 'Noch ein langer Absatz.', typ: 'stil' }]);
  assert.equal(guard(html, normal), false);

  // Korrektur, die den gesamten grossen Absatz (innerhalb EINES Blocks) wegnimmt,
  // schrumpft die Seite unter die Schwelle und MUSS gefangen werden.
  const destructive = applyCorrections(html, [{ original: bigText, korrektur: 'X', typ: 'stil' }]);
  assert.notEqual(destructive, html);
  assert.equal(guard(html, destructive), true);
});
