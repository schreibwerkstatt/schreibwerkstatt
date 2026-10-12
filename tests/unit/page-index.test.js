'use strict';
// Unit-Tests für lib/page-index.js – Pronomen/Dialog-Split, Stil-Stats, Figuren-Matching.

const test = require('node:test');
const assert = require('node:assert/strict');

// better-sqlite3 öffnet die DB beim Import. Für reine Logik-Tests umgehen wir das
// nicht (es ist ok, db schema zu laden — die Funktionen verwenden es erst lazy).
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const {
  computePronounsAndDialog,
  computeStyleStats,
  computeFigureMentions,
  tokenizeNamesForStopwords,
  findDialogRanges,
} = require('../../lib/page-index');

test('Pronomen: Ich-Erzähler narrativ vs. Dialog getrennt gezählt', () => {
  const text = 'Ich ging zum Fenster. Er sagte: «Ich komme gleich.»';
  const { pronoun_counts } = computePronounsAndDialog(text);
  assert.equal(pronoun_counts.ich.narr, 1, 'ein Ich im Erzähltext');
  assert.equal(pronoun_counts.ich.dlg,  1, 'ein Ich im Dialog');
});

test('Dialog-Marker: «…» umschliesst korrekt', () => {
  const text = 'Er antwortete «sie kommt gleich».';
  const { pronoun_counts, dialog_chars } = computePronounsAndDialog(text);
  assert.ok(dialog_chars > 0, 'dialog_chars > 0 für CH-Guillemets');
  assert.equal(pronoun_counts.sie_sg.dlg, 1);
  assert.equal(pronoun_counts.sie_sg.narr, 0);
});

test('Dialog-Marker: engl. Smart Quotes \u201C\u2026\u201D', () => {
  const text = 'Er fragte \u201Csie kommt gleich\u201D.';
  const { pronoun_counts, dialog_chars } = computePronounsAndDialog(text);
  assert.ok(dialog_chars > 0, 'dialog_chars > 0 für Smart Quotes');
  assert.equal(pronoun_counts.sie_sg.dlg, 1);
});

test('Dialog-Marker: inverted DE \u00BB\u2026\u00AB', () => {
  const text = 'Er rief \u00BBsie kommt gleich\u00AB.';
  const { pronoun_counts, dialog_chars } = computePronounsAndDialog(text);
  assert.ok(dialog_chars > 0, 'dialog_chars > 0 für inverted Guillemets');
  assert.equal(pronoun_counts.sie_sg.dlg, 1);
});

test('Dialog-Marker: DE typografisch \u201E\u2026\u201C', () => {
  const text = 'Er sagte \u201Esie kommt gleich\u201C.';
  const { pronoun_counts, dialog_chars } = computePronounsAndDialog(text);
  assert.ok(dialog_chars > 0, 'dialog_chars > 0 für DE typografisch');
  assert.equal(pronoun_counts.sie_sg.dlg, 1);
});

test('Dialog-Marker: franz. einfach \u2039\u2026\u203A', () => {
  const text = 'Er flüsterte \u2039sie kommt\u203A leise.';
  const { pronoun_counts, dialog_chars } = computePronounsAndDialog(text);
  assert.ok(dialog_chars > 0, 'dialog_chars > 0 für FR einfach');
  assert.equal(pronoun_counts.sie_sg.dlg, 1);
});

test('Dialog-Marker: DE einfach \u201A\u2026\u2018', () => {
  const text = 'Er dachte \u201Asie kommt gleich\u2018.';
  const { pronoun_counts, dialog_chars } = computePronounsAndDialog(text);
  assert.ok(dialog_chars > 0, 'dialog_chars > 0 für DE einfach');
  assert.equal(pronoun_counts.sie_sg.dlg, 1);
});

test('Dialog-Marker: engl. einfach \u2018\u2026\u2019 — Apostroph schliesst nicht', () => {
  const said = (t) => findDialogRanges(t).map(([a, b]) => t.slice(a, b));
  assert.deepEqual(said('\u2018Come here,\u2019 said Anna. \u2018I don\u2019t know.\u2019'),
    ['\u2018Come here,\u2019', '\u2018I don\u2019t know.\u2019']);
  // Besitz-Apostroph mitten in der Rede: der Schluss mit Satzzeichen gewinnt.
  assert.deepEqual(said('He said, \u2018It\u2019s James\u2019 hat, isn\u2019t it?\u2019 and left.'),
    ['\u2018It\u2019s James\u2019 hat, isn\u2019t it?\u2019']);
  // Einwort-Zitat ohne Satzzeichen, danach weitere Rede: nicht zusammenkleben.
  assert.deepEqual(said('She wrote \u2018never\u2019 twice, he said. \u2018Go.\u2019'),
    ['\u2018never\u2019', '\u2018Go.\u2019']);
  // Apostroph allein ist kein Dialog — auch nicht im Deutschen.
  assert.deepEqual(said('The boys\u2019 house was empty.'), []);
  assert.deepEqual(said('Hans\u2019 Hut lag da. Anna\u2019s dog barked.'), []);
  assert.deepEqual(said('\u2018Unclosed and the paragraph ends'), []);
});

test('Speech-Verb + Colon ohne Quotes: "Er sagte: Ich komme."', () => {
  const text = 'Er sagte: Ich komme gleich.';
  const { pronoun_counts, dialog_chars } = computePronounsAndDialog(text);
  assert.ok(dialog_chars > 0, 'dialog_chars > 0 für Speech-Verb-Stil');
  assert.equal(pronoun_counts.ich.dlg, 1, 'Ich nach «sagte:» als Dialog gezählt');
  assert.equal(pronoun_counts.ich.narr, 0);
});

test('Speech-Verb + Colon: dachte, fragte, lowercase — je als Dialog', () => {
  const text = 'Anna dachte: Ich bin müde. Er fragte: Bist du bereit?';
  const { pronoun_counts } = computePronounsAndDialog(text);
  assert.equal(pronoun_counts.ich.dlg, 1, 'Ich nach «dachte:» im Dialog');
  assert.equal(pronoun_counts.du.dlg, 1, 'du nach «fragte:» im Dialog');
});

test('Speech-Verb + Colon: Aufzählung triggert NICHT', () => {
  const text = 'Er hatte drei Argumente: Ich sei faul, du auch.';
  const { pronoun_counts } = computePronounsAndDialog(text);
  assert.equal(pronoun_counts.ich.dlg, 0, 'hatte ist kein Speech-Verb');
  assert.equal(pronoun_counts.ich.narr, 1);
});

test('Em-Dash-Zeilenanfang: "— Ich komme."', () => {
  const text = 'Sie nickte.\n\u2014 Ich komme gleich.\nEr wandte sich ab.';
  const { pronoun_counts, dialog_chars } = computePronounsAndDialog(text);
  assert.ok(dialog_chars > 0, 'dialog_chars > 0 für Em-Dash-Stil');
  assert.equal(pronoun_counts.ich.dlg, 1, 'Ich nach Em-Dash als Dialog');
});

test('Pronomen: Er-Pronomen inkl. Possessiv-Formen', () => {
  const text = 'Er öffnete seinen Mantel. Sein Blick war leer.';
  const { pronoun_counts } = computePronounsAndDialog(text);
  assert.equal(pronoun_counts.er.narr, 3, 'Er + seinen + Sein');
});

test('computeStyleStats: leerer Text liefert Null-Metriken', () => {
  const stats = computeStyleStats('');
  assert.equal(stats.filler_count, 0);
  assert.equal(stats.passive_count, 0);
  assert.equal(stats.avg_sentence_len, null);
  assert.equal(stats.lix, null);
});

test('computeStyleStats: Füllwörter und Passiv-Formen', () => {
  const text = 'Eigentlich wurde die Tür geöffnet. Das ist natürlich sehr wichtig.';
  const stats = computeStyleStats(text);
  assert.ok(stats.filler_count >= 3, `erwartet ≥3 Füllwörter, gemessen ${stats.filler_count}`);
  assert.ok(stats.passive_count >= 1, `erwartet ≥1 Passiv (wurde), gemessen ${stats.passive_count}`);
});

test('computeStyleStats: Abkürzungen, Ordinalzahlen und Dialog-Einschübe beenden keinen Satz', () => {
  const lens = (t) => JSON.parse(computeStyleStats(t).sentence_lens);
  assert.deepEqual(lens('Dr. Meier kam am 3. Mai z. B. mit dem Zug.'), [10]);
  assert.deepEqual(lens('«Komm!», rief er. Sie kam.'), [3, 2]);
  assert.deepEqual(lens('„Komm!“ rief er. Sie kam.'), [3, 2]);
  assert.deepEqual(lens('Er wartete … und ging. Dann Stille.'), [4, 2]);
  assert.deepEqual(lens('Wirklich? Ja! Gut.'), [1, 1, 1]);
  assert.deepEqual(lens('Ohne Punkt am Ende'), [4]);
});

test('computeStyleStats: Wörter mit Akzenten zerfallen nicht', () => {
  const s = computeStyleStats('Sie ass Crème brûlée im Café.');
  assert.deepEqual(JSON.parse(s.sentence_lens), [6]);
});

test('computeStyleStats: Seite ohne zählbaren Satz hat keinen LIX — und das ist ein Ergebnis', () => {
  // lib/stil-heatmap.js#needsSync darf daran nicht hängen, sonst rechnete die
  // Stil-Karte bei jedem Öffnen neu.
  const s = computeStyleStats('1984 – 2001');
  assert.equal(s.lix, null);
  assert.equal(s.flesch_de, null);
});

test('computeStyleStats: Wiederholungs-Score klammert Eigennamen via extraStopwords aus', () => {
  const text = 'Anna ging. Anna sprach. Anna hörte.';
  const withoutFilter = computeStyleStats(text);
  const withFilter    = computeStyleStats(text, { extraStopwords: new Set(['anna']) });

  const repWith = JSON.parse(withFilter.repetition_data);
  const repWithout = JSON.parse(withoutFilter.repetition_data);
  // "anna" sollte in der gefilterten Top-Liste fehlen, in der ungefilterten vorhanden sein.
  assert.ok(repWithout.top.some(t => t.word === 'anna'));
  assert.ok(!repWith.top.some(t => t.word === 'anna'));
});

test('computeStyleStats: Wiederholungs-Score nimmt die Stoppwörter der Buchsprache', () => {
  const text = 'They would wait. They would listen. They would leave.';
  const words = (opts) => JSON.parse(computeStyleStats(text, opts).repetition_data).top.map(t => t.word);
  assert.ok(words().includes('would'), 'deutsche Liste kennt "would" nicht');
  assert.ok(!words({ language: 'en' }).includes('would'));
  assert.ok(!words({ language: 'en' }).includes('they'));
});

test('computeFigureMentions: Vollname-Match + Token-Match gewichtet', () => {
  const text = 'Anna Müller trat ein. Später kam Anna allein zurück.';
  const figures = [{ id: 1, name: 'Anna Müller', kurzname: 'Anna' }];
  const mentions = computeFigureMentions(text, figures);
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].figure_id, 1);
  // Vollname (1.0) + 2× "Anna" (0.5 für Token-Match + 1.0 fürs kurzname-Vollname-Match)
  // Das genaue Gewicht muss nicht ein exakter Integer sein – wir erwarten ≥ 2.
  assert.ok(mentions[0].count >= 2, `count ≥ 2, gemessen ${mentions[0].count}`);
  assert.equal(mentions[0].first_offset, 0, 'erste Erwähnung am Textanfang');
});

test('computeFigureMentions: Token-Blocklist verhindert "Herr"-Matches', () => {
  // Vollname "Herr Müller" (1.0) + "Müller" Token (0.5) = 1.5 → round → 2.
  // "Herr" allein zählt nicht (Blocklist) – ohne Blocklist käme jedes "Herr"-Vorkommen mit dazu.
  const text = 'Herr Müller kam herein. Später tauchte noch ein anderer Herr auf.';
  const figures = [{ id: 1, name: 'Herr Müller', kurzname: null }];
  const mentions = computeFigureMentions(text, figures);
  assert.equal(mentions.length, 1);
  // Der zweite "Herr" (allein) darf NICHT mitgezählt werden.
  // Vollname(1) + Müller-Token(0.5) = 1.5 → round → 2.
  assert.equal(mentions[0].count, 2, 'Vollname + Müller-Token, aber kein freistehendes "Herr"');
});

test('tokenizeNamesForStopwords: strippt Namen in lowercase-Tokens, filtert Blocklist/Kurzwörter', () => {
  const tokens = tokenizeNamesForStopwords(['Anna Müller', 'Sankt-Gallen', 'Herr Dr. Schmidt']);
  assert.ok(tokens.has('anna'));
  assert.ok(tokens.has('müller'));
  assert.ok(tokens.has('sankt'));
  assert.ok(tokens.has('gallen'));
  assert.ok(tokens.has('schmidt'));
  assert.ok(!tokens.has('herr'), 'blocklist: herr ausgeschlossen');
  assert.ok(!tokens.has('dr'),   'zu kurz: dr ausgeschlossen');
});

// ── Nachrichtenverlauf als Dialog ────────────────────────────────────────────
const { htmlToPlainText, htmlToPlainTextWithMsgRanges } = require('../../lib/html-text');

test('htmlToPlainTextWithMsgRanges: Text zeichengleich mit htmlToPlainText', () => {
  const samples = [
    '<p>Sie wartete.</p><div class="msg-thread"><p class="msg-name">Lena</p><p class="msg-in">bist du  schon da?</p><p class="msg-out"> gleich, 5 min </p><p class="msg-meta">Di, 14:32</p></div><p>Dann kam er.</p>',
    '<div class="msg-thread"><p class="msg-in"></p><p class="msg-out">&nbsp;ok&amp;tschüss&#160;</p></div>',
    '<div class="msg-thread"><p>ohne Klasse</p></div>',
    '<p>Kein Verlauf, «Rede».</p>',
    '',
  ];
  for (const html of samples) {
    assert.equal(htmlToPlainTextWithMsgRanges(html).text, htmlToPlainText(html), html);
  }
});

test('htmlToPlainTextWithMsgRanges: nur Nachrichten, nicht Absender/Zeit', () => {
  const html = '<p>Sie wartete.</p><div class="msg-thread"><p class="msg-name">Lena</p><p class="msg-in">bist du schon da?</p><p class="msg-out">gleich, 5 min</p><p class="msg-meta">Di, 14:32</p><p>ich auch</p><p class="msg-in"> </p></div>';
  const { text, msgRanges } = htmlToPlainTextWithMsgRanges(html);
  assert.deepEqual(msgRanges.map(([a, b]) => text.slice(a, b)), ['bist du schon da?', 'gleich, 5 min', 'ich auch']);
});

test('Dialog: Nachrichten eines Verlaufs zählen ohne Anführungszeichen als Rede', () => {
  const html = '<p>Ich starrte aufs Handy.</p><div class="msg-thread"><p class="msg-in">ich bin da</p><p class="msg-out">ich auch</p></div>';
  const { text, msgRanges } = htmlToPlainTextWithMsgRanges(html);
  const ohne = computePronounsAndDialog(text);
  assert.equal(ohne.dialog_chars, 0, 'ohne Bereiche sieht die Heuristik keine Rede');
  const mit = computePronounsAndDialog(text, msgRanges);
  assert.equal(mit.dialog_chars, 'ich bin da'.length + 'ich auch'.length);
  assert.equal(mit.pronoun_counts.ich.narr, 1, 'Ich im Erzähltext');
  assert.equal(mit.pronoun_counts.ich.dlg, 2, 'ich in beiden Nachrichten');
});

test('Dialog: Anführungszeichen in einer Nachricht zählen nicht doppelt', () => {
  const html = '<div class="msg-thread"><p class="msg-in">er sagte «nein»</p></div>';
  const { text, msgRanges } = htmlToPlainTextWithMsgRanges(html);
  assert.deepEqual(findDialogRanges(text, msgRanges), [[0, text.length]]);
});

test('Satzmetriken: Nachrichten kleben nicht an den Erzählsätzen', () => {
  const { computePageIndex } = require('../../lib/page-index');
  const { stripMsgThreads } = require('../../lib/html-text');
  const html = '<p>Sie wartete am Bahnhof.</p><div class="msg-thread"><p class="msg-in">bist du schon da</p><p class="msg-out">gleich 5 min</p></div><p>Dann kam er endlich.</p>';
  const { text, msgRanges } = htmlToPlainTextWithMsgRanges(html);
  const proseText = htmlToPlainText(stripMsgThreads(html));
  const idx = computePageIndex(text, { msgRanges, proseText });
  assert.deepEqual(JSON.parse(idx.sentence_lens), [4, 4], 'zwei Erzählsätze, keine Chat-Zeilen');
  assert.equal(idx.sentences, 2);
  assert.equal(idx.dialog_chars, 'bist du schon da'.length + 'gleich 5 min'.length, 'Dialog weiter mit Nachrichten');
});
