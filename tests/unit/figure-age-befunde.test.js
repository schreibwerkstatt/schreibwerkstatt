'use strict';
// Alters-Analyse: konkrete Fehlfälle der reinen Schichten (lib/figure-age/).
//   * selectCandidates mit genau einem freien Platz (n = 1) liefert keine Lücke.
//   * Ordinal-Geburtstage mit unregelmässigem Stamm und auf -zigsten werden erkannt.
//   * „geboren am 3. Mai 1850" ist ein Geburtsjahr (Punkt im Datum bricht nicht ab).
//   * „war ein/eine …" ist kein Alterssignal und keine Prüfzahl.
//   * Die semantische Nachlese gibt den Satz MIT der Angabe weiter, nicht den
//     Anfang der Passage.
//   * Unplausible Modellwerte (Geburtsjahr 12, Alter 400) fallen heraus.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractAgeSignals, numbersIn, selectCandidates, buildNameIndex,
  passageStellen, isPlausibleWert,
} = require('../../lib/figure-age');

const mk = (i, strong) => ({ ordinal: i, offset: 0, satz: 's' + i, signale: [{ art: strong ? 'alter' : 'jahr', weak: !strong }] });

test('selectCandidates: 9 harte + 3 schwache bei max 10 → 10 echte Kandidaten', () => {
  const list = [];
  for (let i = 0; i < 9; i++) list.push(mk(i, true));
  for (let i = 9; i < 12; i++) list.push(mk(i, false));
  const { picked, dropped } = selectCandidates(list, 10);
  assert.equal(picked.length, 10);
  assert.ok(picked.every(Boolean), 'kein undefined in der Auswahl');
  assert.equal(dropped, 2);
});

test('selectCandidates: ein einziger Platz für viele Kandidaten', () => {
  const list = [mk(0, false), mk(1, false), mk(2, false)];
  const { picked } = selectCandidates(list, 1);
  assert.equal(picked.length, 1);
  assert.ok(picked[0]);
});

test('Ordinal-Geburtstag: unregelmässige Stämme und -zigsten', () => {
  const alter = s => extractAgeSignals(s).filter(x => x.art === 'alter' && !x.weak).map(x => x.wert);
  assert.deepEqual(alter('an ihrem dritten Geburtstag'), [3]);
  assert.deepEqual(alter('an ihrem ersten Geburtstag'), [1]);
  assert.deepEqual(alter('zum siebten Geburtstag'), [7]);
  assert.deepEqual(alter('zum achten Geburtstag'), [8]);
  assert.deepEqual(alter('zum zwanzigsten Geburtstag'), [20]);
  assert.deepEqual(alter('zum einundzwanzigsten Geburtstag'), [21]);
  assert.deepEqual(alter('zum dreißigsten Geburtstag'), [30]);
  assert.deepEqual(alter('zum fünfzigsten Geburtstag'), [50]);
  assert.deepEqual(alter('zum sechzehnten Geburtstag'), [16]);
});

test('Geburtsjahr hinter einem Datum mit Punkt', () => {
  const geb = s => extractAgeSignals(s).filter(x => x.art === 'geburtsjahr').map(x => x.wert);
  assert.deepEqual(geb('Konrad, geboren am 3. Mai 1850, schwieg.'), [1850]);
  assert.deepEqual(geb('Konrad (geb. am 3. Mai 1850) schwieg.'), [1850]);
  assert.deepEqual(geb('Er war 1850 geboren.'), [1850]);
});

test('«war ein/eine» ist kein Alterssignal und keine Prüfzahl', () => {
  assert.deepEqual(extractAgeSignals('Sie war eine von vielen.').filter(x => x.art === 'alter'), []);
  assert.deepEqual(extractAgeSignals('Es war ein Tag im Mai 1912.').filter(x => x.art === 'alter'), []);
  assert.ok(!numbersIn('Sie war eine von vielen.').has(1));
  // echte Einsen bleiben
  assert.ok(numbersIn('ein Jahr alt').has(1));
  assert.ok(numbersIn('der einjährige Sohn').has(1));
  assert.ok(numbersIn('an ihrem ersten Geburtstag').has(1));
  assert.ok(extractAgeSignals('Er ist acht.').some(x => x.art === 'alter' && x.wert === 8));
});

test('passageStellen: Satz mit der Angabe, nicht der Passagen-Anfang', () => {
  const index = buildNameIndex([{ id: 7, patterns: [{ text: 'Mara Lenz' }, { text: 'Mara' }] }]);
  const fuell = 'Der Regen hörte nicht auf, und die Strasse glänzte im Licht der Laternen. '.repeat(8);
  const text = `Mara Lenz stand am Fenster. ${fuell}Sie war damals vierzehn Jahre alt.`;
  const stellen = passageStellen(text, index, 7);
  assert.equal(stellen.length, 1);
  assert.match(stellen[0].satz, /vierzehn Jahre alt/);
  assert.ok(numbersIn(stellen[0].satz).has(14));
  assert.equal(stellen[0].indirekt, true);
});

test('passageStellen: ohne Nennung der Figur in der Passage kein Fund', () => {
  const index = buildNameIndex([{ id: 7, patterns: [{ text: 'Mara' }] }]);
  assert.deepEqual(passageStellen('Der Alte war achtzig Jahre alt.', index, 7), []);
});

test('isPlausibleWert: Alter 0–130, Jahre 1000–2999', () => {
  assert.equal(isPlausibleWert('alter', 12), true);
  assert.equal(isPlausibleWert('alter', 400), false);
  assert.equal(isPlausibleWert('alter', -3), false);
  assert.equal(isPlausibleWert('geburtsjahr', 12), false);
  assert.equal(isPlausibleWert('geburtsjahr', 1850), true);
  assert.equal(isPlausibleWert('todesjahr', 3500), false);
});

test('consolidateFigure: zwei verschiedene Geburtsjahre im Text sind ein Widerspruch', () => {
  const { consolidateFigure } = require('../../lib/figure-age');
  const row = consolidateFigure({ funde: [
    { art: 'geburtsjahr', wert: 1850, ordinal: 0, offset: 0, zitat: 'geboren 1850' },
    { art: 'geburtsjahr', wert: 1856, ordinal: 3, offset: 0, zitat: '1856 geboren', page_id: 9 },
  ] });
  assert.equal(row.geburtsjahr, 1850);
  assert.deepEqual(row.widerspruch.map(w => [w.typ, w.a, w.b, w.page_id]), [['geburtsjahrText', 1850, 1856, 9]]);
});

// ── Zahlwort ohne „Jahre", Englisch, Fenster um die Angabe ─────────────────
const { scanPage, clipSatz, consolidateFigure } = require('../../lib/figure-age');

const annaIdx = () => buildNameIndex([{ id: 1, patterns: [{ text: 'Anna Berg' }, { text: 'Anna' }] }]);
const werte = (text) => scanPage(text, annaIdx(), {}).flatMap(c => c.signale.filter(s => s.art === 'alter').map(s => s.wert));

test('Grobfilter laesst das blosse Zahlwort durch: „Sie war damals zwölf", „im Alter von vierzig"', () => {
  assert.deepEqual(werte('Anna kam nach Hause. Sie war damals zwölf.'), [12]);
  assert.deepEqual(werte('Im Alter von vierzig heiratete Anna.'), [40]);
});

test('Kopula: „wird", zwei Adverbien, Ziffer — aber keine Mengen, Uhrzeiten, Jahreszahlen', () => {
  assert.deepEqual(werte('Anna wird morgen vierzig.'), [40]);
  assert.deepEqual(werte('Anna war damals erst zwölf.'), [12]);
  assert.deepEqual(werte('Anna war 12.'), [12]);
  assert.deepEqual(werte('Anna war 12 Minuten zu spät.'), []);
  assert.deepEqual(werte('Anna war um 12.30 da.'), []);
  assert.deepEqual(werte('Anna war 1912 in Wien.'), []);
});

test('Englisch: Zahlwoerter in Mustern und in der Zahl-Pruefung, „one" ist kein Alter', () => {
  assert.deepEqual(werte('Anna was twelve years old.'), [12]);
  assert.deepEqual(werte('Anna turned forty-two.'), [42]);
  assert.deepEqual(werte('Anna was one of them.'), []);
  assert.ok(numbersIn('she turned forty-two').has(42));
  assert.ok(!numbersIn('one of them').has(1));
});

test('Langer Satz: das Fenster behaelt die Angabe statt sie abzuschneiden', () => {
  const vorsatz = 'Anna ging ' + 'sehr langsam und nachdenklich durch die verschneiten Gassen der Altstadt, '.repeat(5) + 'bis sie ankam.';
  const [ind] = scanPage(`${vorsatz} Sie war damals 12 Jahre alt.`, annaIdx(), {});
  assert.ok(ind.indirekt);
  assert.ok(ind.satz.length <= 320);
  assert.match(ind.satz, /12 Jahre alt\.$/);

  const [dir] = scanPage('Anna, die an diesem Morgen ' + 'lange und ausführlich über alles Mögliche nachgedacht hatte, '.repeat(5) + 'war 12 Jahre alt.', annaIdx(), {});
  assert.match(dir.satz, /12 Jahre alt/);
  // Woertliches Stueck des Texts, ohne Auslassungszeichen — die Zitat-Pruefung
  // sucht das Zitat darin.
  assert.ok(!dir.satz.includes('…'));
});

test('clipSatz nimmt die Nennung der Figur mit, wenn sie ins Fenster passt', () => {
  const text = 'Vorspann '.repeat(40) + 'Anna Berg sagte, sie sei 33 Jahre alt' + ' und Nachspann'.repeat(30);
  const out = clipSatz(text, annaIdx(), [1]);
  assert.ok(out.length <= 320);
  assert.match(out, /Anna Berg sagte, sie sei 33 Jahre alt/);
});

test('Absatzende ist eine Satzgrenze: Ueberschrift klebt nicht am naechsten Absatz', () => {
  const [c] = scanPage('Anna\n\nDie Frau am Fenster war 70 Jahre alt.', annaIdx(), {});
  assert.equal(c.indirekt, true, 'Ueberschrift nur als Satz davor, nicht als direkte Nennung');
});

// ── Verdichtung: Geburtsjahr der Zeile traegt die Rechnung ─────────────────
test('consolidateFigure: Text-Geburtsjahr gegen Zeitstrahl-Geburtsereignis → Rechnung passt zur Zeile + Befund', () => {
  const row = consolidateFigure({
    funde: [{ art: 'geburtsjahr', wert: 1960, ordinal: 0, offset: 0, zitat: 'Anna, 1960 geboren', page_id: 4 }],
    kuratiert: { geburtstag: null },
    zeitstrahl: { jahr_im_roman: 2000, geburtsjahr: 1955, alter_im_roman: 45 },
  });
  assert.equal(row.geburtsjahr, 1960);
  assert.equal(row.gerechnet, 40, 'gerechnet mit dem angezeigten Geburtsjahr, nicht mit 1955');
  assert.deepEqual(row.widerspruch.map(w => [w.typ, w.a, w.b]), [['geburtsjahrZeitstrahl', 1955, 1960]]);
});

test('consolidateFigure: Todesjahr im Text deckelt das Ankerjahr', () => {
  const row = consolidateFigure({
    funde: [{ art: 'todesjahr', wert: 1950, ordinal: 0, offset: 0, zitat: 'Er starb 1950 in Bern', page_id: 4 }],
    kuratiert: { geburtstag: '1900' },
    zeitstrahl: { jahr_im_roman: 1990, geburtsjahr: 1900, alter_im_roman: 90 },
  });
  assert.equal(row.gerechnet, 50);
  assert.equal(row.bezugsjahr_von, 1950);
});
