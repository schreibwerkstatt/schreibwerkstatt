'use strict';
// Alters-Analyse der Figuren: die drei reinen Schichten unter lib/figure-age/.
// Was hier gegated ist, ist genau das, was das Feature glaubwuerdig macht —
// Muster, die auch ausgeschriebene Zahlen greifen, eine Auswahl, die den
// Buchbogen abdeckt, und eine Verdichtung, die Widersprueche findet statt sie zu
// glaetten.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  germanNumberWord, germanOrdinalWord, extractAgeSignals, numbersIn,
  splitSentences, buildNameIndex, scanPage, scanMsgUtterances, selectCandidates, consolidateFigure,
} = require('../../lib/figure-age');

test('Zahlwoerter inkl. Komposita und Umlaut-Varianten', () => {
  assert.equal(germanNumberWord('zwölf'), 12);
  assert.equal(germanNumberWord('fünfundzwanzig'), 25);
  assert.equal(germanNumberWord('einundvierzig'), 41);
  assert.equal(germanNumberWord('dreissig'), 30);
  assert.equal(germanNumberWord('dreißig'), 30);
  assert.equal(germanNumberWord('Kutsche'), null);
  assert.equal(germanOrdinalWord('sechzehnten'), 16);
  assert.equal(germanOrdinalWord('dritten'), 3);
});

test('Altersmuster: Ziffer, Zahlwort, Ordinal-Geburtstag, Englisch', () => {
  const alter = s => extractAgeSignals(s).filter(x => x.art === 'alter').map(x => x.wert);
  assert.deepEqual(alter('Die 12-jährige Anna.'), [12]);
  assert.deepEqual(alter('Die zwölfjährige Anna.'), [12]);
  assert.ok(alter('Er war vierzig Jahre alt.').includes(40));
  assert.ok(alter('Mit 63 Jahren ging er.').includes(63));
  assert.ok(alter('An ihrem sechzehnten Geburtstag.').includes(16));
  assert.ok(alter('She was 34 years old.').includes(34));
  assert.ok(alter('Im Alter von neunzehn verliess sie die Stadt.').includes(19));
});

test('Geburtsjahr in beiden Leserichtungen', () => {
  const geb = s => extractAgeSignals(s).filter(x => x.art === 'geburtsjahr').map(x => x.wert);
  assert.deepEqual(geb('Geboren 1850 in Prag.'), [1850]);
  assert.deepEqual(geb('Sie wurde 1850 geboren.'), [1850]);
  assert.ok(geb('Jahrgang 1903, Sohn eines Schmieds.').includes(1903));
});

test('Unplausible Werte fallen heraus', () => {
  // 300 Jahre ist keine Altersangabe, 12 keine Jahreszahl.
  assert.equal(extractAgeSignals('Der 300-jährige Baum.').filter(x => x.art === 'alter').length, 0);
  assert.equal(extractAgeSignals('Seite 12 des Berichts.').filter(x => x.art === 'jahr').length, 0);
});

test('numbersIn erkennt Ziffer, Zahlwort UND Kompositum — die Pruefgroesse gegen erfundene Werte', () => {
  assert.ok(numbersIn('sie war zwölf').has(12));
  assert.ok(numbersIn('mit 63 Jahren').has(63));
  // Kompositum: das Zahlwort steckt IM Wort. Ohne diesen Fall verwirft die
  // Zahl-Pruefung des Jobs genau die woertlich belegten Angaben.
  assert.ok(numbersIn('Die neunzehnjährige Anna Berg').has(19));
  assert.ok(numbersIn('an ihrem sechzehnten Geburtstag').has(16));
  assert.ok(!numbersIn('sie war ein Kind').has(12));
});

test('splitSentences: Datum in Ziffern bleibt ein Satz — Geburtsjahr samt Name', () => {
  for (const t of ['Anna wurde am 12.03.1950 geboren.', 'Anna, geboren am 12. 3. 1950, lachte.', 'Anna (geb. 12.3.1950) lachte.']) {
    const s = splitSentences(t);
    assert.equal(s.length, 1, t);
    assert.ok(extractAgeSignals(s[0].text).some(x => x.art === 'geburtsjahr' && x.wert === 1950), t);
  }
  // Eine Jahreszahl am Satzende bleibt eine Grenze.
  assert.equal(splitSentences('Anna kam 1912. Sie war zwölf.').length, 2);
});

test('deutsches „am <Zahl>" ist keine englische Kopula', () => {
  assert.equal(extractAgeSignals('Sie traf ihn am 12. Mai.').filter(x => x.art === 'alter').length, 0);
  assert.deepEqual(extractAgeSignals("I am twelve").map(x => x.wert), [12]);
  assert.deepEqual(extractAgeSignals("I'm 12").map(x => x.wert), [12]);
});

test('numbersIn: Ordinalwort nur vor Geburtstag/Lebensjahr', () => {
  const n = numbersIn('Sie war erst zwölf und musste achten');
  assert.ok(!n.has(1), '„erst" ist keine Eins');
  assert.ok(!n.has(8), '„achten" ist keine Acht');
  assert.ok(numbersIn('im neunzehnten Lebensjahr').has(19));
});

test('splitSentences: Zeile ohne Schlusspunkt bleibt eigener Satz', () => {
  const s = splitSentences('Erster Satz. Zweiter Satz!\nDialogzeile ohne Punkt\nDritter Satz.');
  assert.equal(s.length, 4);
  assert.ok(s[2].text.includes('Dialogzeile'));
});

test('scanPage bindet die Angabe an die Figur — auch ueber den Pronomen-Anschluss', () => {
  const idx = buildNameIndex([
    { id: 1, patterns: [{ text: 'Anna Berg' }, { text: 'Anna' }] },
    { id: 2, patterns: [{ text: 'Konrad' }] },
  ]);
  const hits = scanPage(
    'Anna Berg trat ein. Sie war damals zwölf Jahre alt. Konrad, geboren 1888, schwieg.',
    idx, { page_id: 7, chapter: 'K1', ordinal: 3 },
  );
  const anna = hits.find(h => h.figure_id === 1);
  const konrad = hits.find(h => h.figure_id === 2);
  assert.ok(anna, 'Anna gefunden');
  assert.equal(anna.indirekt, true, 'Angabe steht im Folgesatz');
  assert.ok(anna.satz.includes('Anna Berg'), 'Vorsatz mit im Fenster');
  assert.ok(konrad && !konrad.indirekt);
  assert.equal(konrad.page_id, 7);
});

test('scanPage: Zahl ohne Figur im Fenster ergibt keinen Kandidaten', () => {
  const idx = buildNameIndex([{ id: 1, patterns: [{ text: 'Anna' }] }]);
  assert.equal(scanPage('Der Zug fuhr 1912 ab. Es regnete.', idx, {}).length, 0);
});

// ── Nachrichtenverlauf ──────────────────────────────────────────────────────
// Derselbe Weg wie routes/jobs/figur-alter.js: Erzaehltext ohne Verlauf durch
// scanPage, die Nachrichten zeilenweise mit Absender durch scanMsgUtterances.
const { htmlToPlainText, hasMsgThread, msgThreadLines, msgUtterances, stripMsgThreads } = require('../../lib/html-text');

function scanHtml(html) {
  const idx = buildNameIndex([
    { id: 1, patterns: [{ text: 'Anna Berg' }, { text: 'Anna' }] },
    { id: 2, patterns: [{ text: 'Lena' }] },
  ]);
  const prose = htmlToPlainText(stripMsgThreads(html));
  const hits = scanPage(prose, idx, { page_id: 1 });
  if (hasMsgThread(html)) hits.push(...scanMsgUtterances(msgUtterances(msgThreadLines(html)), idx, { page_id: 1, offset: prose.length }));
  const who = { 1: 'Anna', 2: 'Lena' };
  return hits.map(h => `${who[h.figure_id]}:${h.signale[0].wert}:${h.indirekt ? 'indirekt' : 'direkt'}`).sort();
}
const T = (inner) => `<div class="msg-thread">${inner}</div>`;

test('Verlauf: Nachricht am Ende klebt nicht an der Erzählung danach', () => {
  const html = T('<p class="msg-in">bin jetzt 18 jahre alt</p>') + '<p>Anna legte das Handy weg. Sie war 42 Jahre alt und müde.</p>';
  assert.deepEqual(scanHtml(html), ['Anna:42:indirekt'], 'keine 18 für Anna');
});

test('Verlauf: Absenderzeile macht den Sprecher, nicht die Erzählung davor', () => {
  const html = '<p>Anna starrte aufs Handy.</p>' + T('<p class="msg-name">Lena</p><p class="msg-in">werd morgen 30 jahre alt lol</p>');
  assert.deepEqual(scanHtml(html), ['Lena:30:indirekt']);
});

test('Verlauf: im Text genannte Figur ist direkt gemeint, der Absender nur indirekt', () => {
  const html = T('<p class="msg-name">Lena</p><p class="msg-in">Anna wird am Samstag 40 Jahre alt, kommst du?</p>');
  assert.deepEqual(scanHtml(html), ['Anna:40:direkt', 'Lena:40:indirekt']);
});

test('Verlauf: ausgehende Nachricht greift nicht auf die Erzählung davor zurück', () => {
  const html = '<p>Lena schrieb Anna.</p>' + T('<p class="msg-out">ich bin 16 jahre alt und darf das</p>');
  assert.deepEqual(scanHtml(html), []);
});

test('Verlauf: Gruppenchat — jede Absenderzeile gilt für ihre Nachrichten', () => {
  const html = T('<p class="msg-name">Lena</p><p class="msg-in">ich werd 30 jahre alt</p><p class="msg-out">ich bin 25 jahre alt</p><p class="msg-name">Anna</p><p class="msg-in">ich auch 30 jahre alt haha</p><p class="msg-meta">12.03.2019</p>');
  assert.deepEqual(scanHtml(html), ['Anna:30:indirekt', 'Lena:30:indirekt']);
});

test('Verlauf: Satz zeigt den Absender, Geburtsjahr wird erkannt', () => {
  const idx = buildNameIndex([{ id: 2, patterns: [{ text: 'Lena' }] }]);
  const [hit] = scanMsgUtterances([{ sender: 'Lena', text: 'jahrgang 1998 wieso' }], idx, { page_id: 3, offset: 99 });
  assert.equal(hit.satz, 'Lena: jahrgang 1998 wieso');
  assert.equal(hit.signale[0].art, 'geburtsjahr');
  assert.equal(hit.offset, 99);
});

test('selectCandidates deckt den Buchbogen ab und meldet den Deckel', () => {
  const mk = (ord, strong) => ({
    ordinal: ord, offset: 0,
    signale: [{ art: strong ? 'alter' : 'jahr', wert: strong ? 20 : 1900, weak: !strong }],
  });
  const list = Array.from({ length: 20 }, (_, i) => mk(i, i % 5 === 0));
  const { picked, dropped } = selectCandidates(list, 6);
  assert.equal(picked.length, 6);
  assert.equal(dropped, 14);
  assert.equal(picked[0].ordinal, 0, 'Anfang drin');
  assert.ok(picked[picked.length - 1].ordinal >= 15, 'Ende drin');
});

test('consolidateFigure: Textangabe gewinnt, Spanne bleibt Spanne', () => {
  const r = consolidateFigure({
    funde: [
      { art: 'alter', wert: 12, zitat: 'zwölf Jahre alt', ordinal: 1, offset: 0 },
      { art: 'alter', wert: 19, zitat: 'neunzehn Jahre alt', ordinal: 9, offset: 0 },
    ],
    kuratiert: { geburtstag: '1900' },
    zeitstrahl: { jahr_im_roman: 1919, geburtsjahr: 1900, alter_im_roman: 19 },
  });
  assert.equal(r.quelle, 'text');
  assert.equal(r.alter_von, 12);
  assert.equal(r.alter_bis, 19);
  assert.equal(r.geburtsjahr, 1900);
  assert.equal(r.geburtsjahr_quelle, 'kuratiert');
  // Der gerechnete Wert liegt IN der belegten Spanne → kein Widerspruch.
  assert.equal(r.gerechnet, 19);
  assert.equal(r.widerspruch, null);
  assert.equal(r.konfidenz, 0.9);
});

test('consolidateFigure: Rechnung greift ohne Textangabe', () => {
  const r = consolidateFigure({
    funde: [],
    kuratiert: { geburtstag: 'Frühling 1880' },
    zeitstrahl: { jahr_im_roman: 1910, geburtsjahr: 1880, alter_im_roman: 30 },
  });
  assert.equal(r.quelle, 'geburtsjahr');
  assert.equal(r.alter_von, 30);
  assert.equal(r.alter_bis, 30);
  assert.equal(r.bezugsjahr_von, 1910);
  assert.equal(r.konfidenz, 0.75);
});

test('consolidateFigure: Rechnung am ANKERJAHR der Figur, nicht am Buchende', () => {
  // Die Figur verschwindet 1987 aus der Geschichte; das Buch endet 2003. Ihr
  // Alter ist 5, nicht 21 — genau der Fehler, den eine buchweite Spanne machte.
  const r = consolidateFigure({
    funde: [],
    kuratiert: { geburtstag: null },
    zeitstrahl: { jahr_im_roman: 1987, geburtsjahr: 1982, alter_im_roman: 5 },
  });
  assert.equal(r.alter_von, 5);
  assert.equal(r.gerechnet, 5);
  assert.equal(r.quelle, 'zeitstrahl');
});

test('consolidateFigure: im Text gefundenes Geburtsjahr traegt die Rechnung', () => {
  // `alter_im_roman` kennt nur das KURATIERTE Geburtsjahr — fehlt das, muss der
  // Textfund die Rechnung tragen, sonst bleibt die Spalte leer, obwohl beide
  // Zahlen bekannt sind.
  const r = consolidateFigure({
    funde: [{ art: 'geburtsjahr', wert: 1950, zitat: 'geboren 1950', ordinal: 1, offset: 0 }],
    kuratiert: { geburtstag: null },
    zeitstrahl: { jahr_im_roman: 1980, geburtsjahr: null, alter_im_roman: null },
  });
  assert.equal(r.geburtsjahr, 1950);
  assert.equal(r.geburtsjahr_quelle, 'text');
  assert.equal(r.gerechnet, 30);
  assert.equal(r.alter_von, 30);
  assert.equal(r.quelle, 'geburtsjahr');
});

test('consolidateFigure: ohne Alter kein Bezugsjahr', () => {
  // `jahr_im_roman` faellt fuer eine undatierte Figur auf das Buchende zurueck.
  // Neben „unbekannt" waere diese Jahreszahl eine Scheinantwort.
  const r = consolidateFigure({
    funde: [],
    kuratiert: { geburtstag: null },
    zeitstrahl: { jahr_im_roman: 2003, geburtsjahr: null, alter_im_roman: null },
  });
  assert.equal(r.alter_von, null);
  assert.equal(r.bezugsjahr_von, null);
  assert.equal(r.bezugsjahr_bis, null);
});

test('consolidateFigure: Widerspruch Steckbrief vs. Text', () => {
  const r = consolidateFigure({
    funde: [{ art: 'geburtsjahr', wert: 1875, zitat: 'geboren 1875', ordinal: 2, offset: 0 }],
    kuratiert: { geburtstag: '1880' },
  });
  assert.equal(r.geburtsjahr, 1880, 'Steckbrief gewinnt');
  assert.ok(r.widerspruch.some(w => w.typ === 'geburtsjahr'));
});

test('consolidateFigure: Alter sinkt im Buchverlauf → Hinweis', () => {
  const r = consolidateFigure({
    funde: [
      { art: 'alter', wert: 30, zitat: 'dreissig', ordinal: 1, offset: 0 },
      { art: 'alter', wert: 12, zitat: 'zwölf', ordinal: 8, offset: 0 },
    ],
  });
  assert.ok(r.widerspruch.some(w => w.typ === 'reihenfolge'));
  // Rueckblende ist ein Hinweis, kein Zweifel an der Angabe: die Konfidenz bleibt.
  assert.equal(r.konfidenz, 0.9);
  assert.equal(r.alter_von, 12);
  assert.equal(r.alter_bis, 30);
});

test('consolidateFigure: Textangabe gegen Rechnung', () => {
  const r = consolidateFigure({
    funde: [{ art: 'alter', wert: 40, zitat: 'vierzig Jahre alt', ordinal: 5, offset: 0 }],
    kuratiert: { geburtstag: '1900' },
    zeitstrahl: { jahr_im_roman: 1920, geburtsjahr: 1900, alter_im_roman: 20 },
  });
  assert.ok(r.widerspruch.some(w => w.typ === 'rechnung'), 'Text sagt 40, Rechnung 20');
});

test('consolidateFigure: Textalter frueh im Buch ist kein Widerspruch zum Ankerjahr', () => {
  // Geboren 1900, „zwoelf" im Jahr 1912, letztes Ereignis der Figur 1940. Text
  // und Steckbrief stimmen ueberein — die 40 gilt am Anker, nicht an der Stelle.
  const ohneJahr = consolidateFigure({
    funde: [{ art: 'alter', wert: 12, zitat: 'zwölf Jahre alt', ordinal: 0, offset: 0 }],
    kuratiert: { geburtstag: '1900' },
    zeitstrahl: { jahr_im_roman: 1940, geburtsjahr: 1900 },
  });
  assert.equal(ohneJahr.gerechnet, 40);
  assert.equal(ohneJahr.widerspruch, null);
  assert.equal(ohneJahr.konfidenz, 0.9);
  const mitJahr = consolidateFigure({
    funde: [{ art: 'alter', wert: 12, bezugsjahr: 1912, zitat: '1912, zwölf Jahre alt', ordinal: 0, offset: 0 }],
    kuratiert: { geburtstag: '1900' },
    zeitstrahl: { jahr_im_roman: 1940, geburtsjahr: 1900 },
  });
  assert.equal(mitJahr.widerspruch, null);
});

test('consolidateFigure: Rechnung am Bezugsjahr des Belegs', () => {
  // „1912 war sie zwanzig" bei Geburtsjahr 1900 → dort waere sie zwoelf.
  const r = consolidateFigure({
    funde: [{ art: 'alter', wert: 20, bezugsjahr: 1912, zitat: '1912 war sie zwanzig', ordinal: 0, offset: 0, page_id: 3 }],
    kuratiert: { geburtstag: '1900' },
  });
  assert.deepEqual(r.widerspruch.map(w => [w.typ, w.a, w.b, w.page_id]), [['rechnung', 20, 12, 3]]);
  assert.ok(r.konfidenz < 0.9);
});

test('consolidateFigure: Textalter ohne eigenes Jahr bekommt nicht das Ankerjahr', () => {
  const r = consolidateFigure({
    funde: [{ art: 'alter', wert: 12, zitat: 'zwölf Jahre alt', ordinal: 0, offset: 0 }],
    zeitstrahl: { jahr_im_roman: 1940, geburtsjahr: null },
  });
  assert.equal(r.bezugsjahr_von, null);
  assert.equal(r.bezugsjahr_bis, null);
});

test('consolidateFigure: sicherer Geburtsjahr-Fund geht einem unsicheren vor', () => {
  const r = consolidateFigure({
    funde: [
      { art: 'geburtsjahr', wert: 1890, zitat: 'wohl um 1890 geboren', unsicher: true, ordinal: 0, offset: 0 },
      { art: 'geburtsjahr', wert: 1891, zitat: 'geboren 1891', ordinal: 2, offset: 0 },
    ],
  });
  assert.equal(r.geburtsjahr, 1891);
});

test('consolidateFigure: nichts bekannt → keine Aussage', () => {
  const r = consolidateFigure({ funde: [], kuratiert: { geburtstag: null } });
  assert.equal(r.alter_von, null);
  assert.equal(r.quelle, null);
  assert.equal(r.konfidenz, 0);
});

test('consolidateFigure: unsichere Funde bekommen niedrige Konfidenz', () => {
  const r = consolidateFigure({
    funde: [{ art: 'alter', wert: 14, zitat: 'vierzehn', ordinal: 1, offset: 0, unsicher: true }],
  });
  assert.equal(r.quelle, 'text');
  assert.ok(r.konfidenz < 0.6);
});
