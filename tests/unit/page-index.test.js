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
    // Private-Use-Zeichen im Text (kodiert und roh) sind Text, keine Marken.
    '<p>a&#xE001;b</p><div class="msg-thread"><p class="msg-in">x&#xE000;y \uE001 z</p></div>',
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

test('page_stats.sentences stammt aus derselben Satzzerlegung wie die Satzlänge', () => {
  const { computePageIndex } = require('../../lib/page-index');
  const text = 'Dr. Meier kam um 14.30 Uhr, d. h. z. B. pünktlich. Er sagte: «Na?» Dann ging er.';
  const idx = computePageIndex(text);
  assert.equal(idx.sentences, 3, 'Abkürzungen und Uhrzeit beenden keinen Satz');
  assert.equal(Math.round((idx.sentence_words / idx.sentences) * 10) / 10, idx.avg_sentence_len);
  assert.equal(JSON.parse(idx.sentence_lens).length, idx.sentences);
});

// ── Englische Bücher (book_settings.language = 'en', lib/style-lang.js) ──────

test('EN: Füllwörter nach englischer Liste, deutsche Liste greift nicht', () => {
  const text = 'I really just wanted to leave. Basically, it was actually quite late.';
  assert.equal(computeStyleStats(text).filler_count, 0, 'deutsches Profil kennt kein „really"');
  // really, just, basically, actually, quite
  assert.equal(computeStyleStats(text, { language: 'en' }).filler_count, 5);
});

test('EN: Passiv = be/get + Partizip, Zustandsadjektive und -ed-Nomen zählen nicht', () => {
  const passives = (t) => JSON.parse(computeStyleStats(t, { language: 'en' }).style_samples).passive.map(s => s.token);
  const count = (t) => computeStyleStats(t, { language: 'en' }).passive_count;
  assert.deepEqual(passives('The letter was sent. The house was built in 1902.'), ['was sent', 'was built']);
  assert.equal(count('He was never told. They were quickly taken away. It was later sold.'), 3, 'Adverb dazwischen');
  assert.equal(count('I got lost.'), 1, 'get-Passiv');
  assert.deepEqual(passives('It was being decided.'), ['being decided'], '„was being" verliert das Partizip nicht');
  assert.equal(count("It wasn't finished."), 1, 'Kontraktion');
  assert.equal(count('I was tired. She was interested in books. He was naked. It was red.'), 0);
  assert.equal(count('Er wurde gesehen.'), 0, 'deutsches werden ist im englischen Profil kein Passiv');
});

test('EN: Adverbien = -ly ohne Adjektiv-/Nomen-Ausnahmen plus feste Formen', () => {
  const advs = (t) => JSON.parse(computeStyleStats(t, { language: 'en' }).style_samples).adverb.map(s => s.token);
  assert.deepEqual(advs('She quietly closed the door. Otherwise nothing happened.'), ['quietly', 'Otherwise']);
  assert.deepEqual(advs('The only lonely family was early and friendly.'), []);
  assert.deepEqual(advs('He often came here.'), ['often', 'here']);
});

test('EN: Flesch Reading Ease statt Amstad', () => {
  // 2 Sätze, 8 Wörter, je 1 Silbe → 206.835 − 1.015·4 − 84.6·1 = 118.2
  const en = computeStyleStats('The cat sat down. The dog ran off.', { language: 'en' });
  assert.equal(en.flesch_de, 118.2);
  // Amstad derselbe Text: 180 − 4 − 58.5 = 117.5
  assert.equal(computeStyleStats('The cat sat down. The dog ran off.').flesch_de, 117.5);
});

test('EN: Silbenzählung kennt stumme Endungen', () => {
  const { _countSyllablesEn: syl } = require('../../lib/style-lang');
  const cases = { make: 1, makes: 1, table: 2, horses: 2, walked: 1, wanted: 2, played: 1, carried: 2,
    yellow: 2, beautiful: 3, readability: 5, I: 1, the: 1 };
  for (const [w, n] of Object.entries(cases)) assert.equal(syl(w), n, w);
});

test('EN: Pronomen landen in denselben Gruppen-Schlüsseln wie DE', () => {
  const text = 'I closed my door and we left. He took his coat; she and they followed. “I know,” you said.';
  const { pronoun_counts: pc } = computePronounsAndDialog(text, [], 'en');
  assert.equal(pc.ich.narr, 2, 'I + my');
  assert.equal(pc.ich.dlg, 1, 'I im Dialog');
  assert.equal(pc.wir.narr, 1);
  assert.equal(pc.er.narr, 2, 'He + his');
  assert.equal(pc.sie_sg.narr, 2, 'she + they');
  assert.equal(pc.du.narr, 1);
  // Deutsches Profil: „man" ist im Englischen ein Nomen — darf nur DE zählen.
  assert.equal(computePronounsAndDialog('The man left.', [], 'en').pronoun_counts.man.narr, 0);
  assert.equal(computePronounsAndDialog('I left.').pronoun_counts.ich.narr, 0, 'DE kennt „I" nicht');
});

test('EN: computePageIndex reicht die Sprache an Pronomen und Stil durch', () => {
  const { computePageIndex, METRICS_VERSION } = require('../../lib/page-index');
  const r = computePageIndex('I was really sent away. I knew it.', { language: 'en' });
  assert.equal(JSON.parse(r.pronoun_counts).ich.narr, 2);
  assert.equal(r.filler_count, 1);
  assert.equal(r.passive_count, 1);
  assert.equal(r.metrics_version, METRICS_VERSION);
});

// Wortgrenze der Stil-Metriken = Wortgrenze des Wortschatzes (lib/lexicon/tokenize.js):
// eine Kontraktion ist EIN Wort. Zerlegt („don" + „t") hob sie Satzlänge und
// Wortzahl an und drückte die Silben je Wort — Flesch und LIX verschoben sich.
test('Kontraktionen sind ein Wort — in beiden Sprachen, gerader und typografischer Apostroph', () => {
  const en = computeStyleStats("I don't know. She couldn’t stay.", { language: 'en' });
  assert.equal(en.sentence_words, 6);
  assert.equal(en.avg_sentence_len, 3);
  const de = computeStyleStats("Wie geht's dir? Gibt’s Neues?");
  assert.equal(de.sentence_words, 5);
  // Satzanfang mit typografischem Apostroph = derselbe wie mit geradem.
  const op = JSON.parse(computeStyleStats("Don't go. Don’t stay.", { language: 'en' }).opener_counts);
  assert.equal(op.counts["don't"], 2);
  assert.equal(op.repeats, 1);
});

test('LIX zählt Buchstaben: der Apostroph macht kein Wort lang', () => {
  // „couldn't" hat sieben Buchstaben (> 6 → lang), „didn't" fünf (kurz).
  const lix = (t) => computeStyleStats(t, { language: 'en' }).lix;
  // 2 Wörter / 1 Satz, 1 langes Wort: 2 + 100·1/2 = 52
  assert.equal(lix("Couldn't stay."), 52);
  // 2 Wörter / 1 Satz, kein langes: 2
  assert.equal(lix("Didn't stay."), 2);
});

test('Wiederholung: Kontraktionen treffen die Stoppwortliste, auch mit typografischem Apostroph', () => {
  // lib/stopwords-en.js führt „couldn't" gerade; zerlegt („couldn" + „t") hätte
  // „couldn" als häufigstes Wort gegolten.
  const top = (t) => JSON.parse(computeStyleStats(t, { language: 'en' }).repetition_data).top.map(r => r.word);
  const words = top('She couldn’t sleep. She couldn’t eat. She couldn’t breathe. Silence, silence, silence.');
  assert.ok(!words.includes("couldn't") && !words.includes('couldn'), words.join(','));
  assert.ok(words.includes('silence'));
});

test('htmlToPlainTextWithMsgRanges: Private-Use-Entity verschiebt keine Bereiche', () => {
  const html = '<p>Vor&#xE001;her.</p><div class="msg-thread"><p class="msg-in">ich &#xE000;bin da</p><p class="msg-out">gut</p></div>';
  const { text, msgRanges } = htmlToPlainTextWithMsgRanges(html);
  assert.equal(text, htmlToPlainText(html));
  assert.deepEqual(msgRanges.map(([a, b]) => text.slice(a, b)), ['ich \uE000bin da', 'gut']);
});

test('htmlToPlainTextWithMsgRanges: Absender je Nachricht wie msgUtterances', () => {
  const { msgThreadLines, msgUtterances } = require('../../lib/html-text');
  const html = '<div class="msg-thread"><p class="msg-name">Lena</p><p class="msg-in">hi</p><p class="msg-out">yo</p>'
    + '<p class="msg-name">Tom</p><p class="msg-out">ok</p><p>noch</p></div>';
  const { msgSenders } = htmlToPlainTextWithMsgRanges(html);
  assert.deepEqual(msgSenders, ['Lena', null, 'Tom', 'Lena']);
  assert.deepEqual(msgSenders, msgUtterances(msgThreadLines(html)).map(u => u.sender));
});

test('Stil-Index: repetition_data.words zählt nur den Prosatext', () => {
  const { computePageIndex } = require('../../lib/page-index');
  const { stripMsgThreads } = require('../../lib/html-text');
  const html = '<p>Sie wartete am Bahnhof.</p><div class="msg-thread"><p class="msg-in">bist du schon da oder nicht</p></div>';
  const { text, msgRanges } = htmlToPlainTextWithMsgRanges(html);
  const idx = computePageIndex(text, { msgRanges, proseText: htmlToPlainText(stripMsgThreads(html)) });
  assert.equal(JSON.parse(idx.repetition_data).words, 4);
});
