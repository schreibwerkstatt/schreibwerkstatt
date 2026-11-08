'use strict';
// Autorenprofil (lib/author-profile.js + db/author-profile.js).
//
// Zwei Eigenschaften sind hier die eigentlichen Testgegenstaende:
//   1. Ein Buch, das nicht mitgerechnet wird, muss BENANNT werden. Still
//      weggelassen sieht das Profil vollstaendig aus und ist es nicht — genau
//      der Fehler, den die Karte nicht machen darf.
//   2. Die Satzbau-Werte entstehen aus SUMMEN ueber die Seiten. Als Mittel der
//      Seitenmittelwerte gerechnet zaehlte eine Zwei-Satz-Seite so viel wie eine
//      mit achtzig Saetzen, und der Buchwert wanderte zu den kurzen Seiten
//      (Simpson). Das prueft der DB-Teil gegen echtes SQL, nicht gegen ein Mock —
//      die Aggregation liegt dort und nicht in der puren Engine.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { useTmpDb } = require('./_helpers/tmp-db');
const tmp = useTmpDb('author-profile');

const { computeAuthorProfile, authorProfileBasisSig, renderAuthorProfileMeasurement,
        AUTHOR_PROFILE_THRESHOLDS: T } = require('../../lib/author-profile');
const { db } = require('../../db/connection');
// Migrationen vor jedem Domaenen-Modul — sonst fehlen deren Prepared Statements
// die Tabellen (die Module bereiten beim Laden vor).
require('../../db/migrations');
const appUsers = require('../../db/app-users');
const { getAuthorProfile, getAuthorProfileRow,
        saveAuthorProfileRun, saveAuthorProfileText } = require('../../db/author-profile');

// ── Pure Engine ────────────────────────────────────────────────────────────────

const LONG = T.MIN_TOKENS + 1;

/** Eingabe-Form der Engine, mit brauchbaren Vorgaben je Buch. */
function mk(specs) {
  const books = [], lexicon = [], pageStats = [];
  specs.forEach((s, i) => {
    const id = s.book_id ?? 100 + i;
    books.push({ book_id: id, created_at: `2020-0${i + 1}-01T00:00:00Z`, excluded: s.excluded ? 1 : 0,
                 language: s.language ?? null });
    if (s.noLexicon) return;
    lexicon.push({
      book_id: id, tokens: s.tokens ?? LONG, pages: 10, scanned_at: '2026-01-01T00:00:00Z',
      mattr: s.mattr ?? 0.5, mattr_window: s.mattr_window ?? 1000,
      mtld: s.mtld ?? 100, hapax_ratio: 0.5, yule_k: 40, heaps_beta: 0.78, lex_density: 0.6,
    });
    pageStats.push({
      book_id: id, pages: 10,
      words: s.words ?? 1000, chars: 6000, sentences: s.sentences ?? 100,
      dialog_chars: s.dialog_chars ?? 1200, adverb_count: 20, passive_count: 5, filler_count: 10,
      lix_w: 40 * 1000, lix_wsum: 1000, flesch_w: 60 * 1000, flesch_wsum: 1000,
    });
  });
  return { books, lexicon, pageStats };
}

/** Kennzahl `key` im Abschnitt `kind` (Default: der einzige eines einsprachigen Werks). */
function metric(r, key, kind = 'all', language) {
  const sec = r.sections.find(s => s.kind === kind && (language === undefined || s.language === language));
  return sec?.metrics.find(m => m.key === key);
}

test('Satzbau kommt aus den Summen, nicht aus Seitenmittelwerten', () => {
  const r = computeAuthorProfile(mk([{ words: 1000, sentences: 100 }]));
  assert.equal(r.books[0].metrics.satzlaenge, 10);
});

test('Nenner 0 ergibt null, nicht 0 — „keine Saetze" ist keine Satzlaenge 0', () => {
  const r = computeAuthorProfile(mk([{ sentences: 0 }]));
  assert.equal(r.books[0].metrics.satzlaenge, null);
});

test('MATTR faellt weg, wenn das Fenster zu klein war (sonst ist es die simple TTR)', () => {
  const r = computeAuthorProfile(mk([{ mattr: 0.9, mattr_window: T.MIN_MATTR_WINDOW - 1 }]));
  assert.equal(r.books[0].metrics.mattr, null);
  // Die uebrigen Wortschatz-Masse bleiben — nur MATTR haengt am Fenster.
  assert.equal(r.books[0].metrics.mtld, 100);
});

test('Nicht gerechnete Buecher werden benannt, nicht verschwiegen', () => {
  const r = computeAuthorProfile(mk([
    { book_id: 1 },
    { book_id: 2, tokens: T.MIN_TOKENS - 1 },
    { book_id: 3, noLexicon: true },
    { book_id: 4, excluded: true },
  ]));
  assert.equal(r.counts.total, 4);
  assert.equal(r.counts.measured, 1);
  assert.deepEqual(r.skipped.tooShort, [2]);
  assert.deepEqual(r.skipped.unscanned, [3]);
  assert.deepEqual(r.skipped.excluded, [4]);
});

test('Ein Buch: Werte ja, Median und Abweichung nein', () => {
  const r = computeAuthorProfile(mk([{ words: 1000, sentences: 100 }]));
  assert.equal(r.comparable, false);
  assert.equal(metric(r, 'satzlaenge').median, null);
  assert.equal(r.books[0].deviation.satzlaenge, null);
  // Der Messwert selbst bleibt stehen — „kein Vergleich" ist nicht „kein Wert".
  assert.equal(r.books[0].metrics.satzlaenge, 10);
});

test('Ab zwei Buechern gibt es Median und Abweichung', () => {
  const r = computeAuthorProfile(mk([
    { words: 800, sentences: 100 },   // 8
    { words: 1200, sentences: 100 },  // 12
  ]));
  assert.equal(r.comparable, true);
  assert.equal(metric(r, 'satzlaenge').median, 10);
  assert.equal(r.books[0].deviation.satzlaenge, -20);
  assert.equal(r.books[1].deviation.satzlaenge, 20);
});

test('Richtung erst ab drei Buechern — und das mittlere zaehlt in keiner Haelfte', () => {
  const two = computeAuthorProfile(mk([{ words: 800, sentences: 100 }, { words: 1200, sentences: 100 }]));
  assert.equal(two.trendAvailable, false);
  assert.equal(metric(two, 'satzlaenge').trend, null);

  // Werte 10 / 100 / 20: erste Haelfte [10], zweite [20] ⇒ +100 %.
  // Zaehlte das mittlere Buch mit, kaeme etwas voellig anderes heraus.
  const three = computeAuthorProfile(mk([
    { words: 1000, sentences: 100 },
    { words: 10000, sentences: 100 },
    { words: 2000, sentences: 100 },
  ]));
  assert.equal(three.trendAvailable, true);
  const tr = metric(three, 'satzlaenge').trend;
  assert.equal(tr.first, 10);
  assert.equal(tr.second, 20);
  assert.equal(tr.pct, 100);
});

test('Konto ohne Buecher: leere Form statt null — die Karte unterscheidet das von einem Fehler', () => {
  const r = computeAuthorProfile({ books: [], lexicon: [], pageStats: [] });
  assert.equal(r.counts.total, 0);
  assert.equal(r.comparable, false);
  assert.deepEqual(r.books, []);
  assert.equal(r.sections.length, 1);
  assert.ok(r.sections[0].metrics.length > 0, 'Kennzahlen-Katalog steht auch ohne Daten');
});

// ── Mehrsprachiges Werk ────────────────────────────────────────────────────────
// Flesch nach Amstad und nach Flesch sind zwei Formeln, Füllwort-/Adverb-/Passiv-
// listen zwei Listen. Ein deutsches und ein englisches Buch nebeneinander gemittelt
// liessen einen Sprachwechsel wie eine Stilentwicklung aussehen.

test('Mehrsprachig: sprachgebundene Kennzahlen nur innerhalb der Sprache verglichen', () => {
  const r = computeAuthorProfile(mk([
    { language: 'de', words: 1200, sentences: 100 },  // 12
    { language: 'en', words: 800, sentences: 100 },   // 8
    { language: 'de', words: 1400, sentences: 100 },  // 14
  ]));
  assert.equal(r.multiLanguage, true);
  assert.deepEqual(r.languages, ['de', 'en'], 'Hauptsprache (mehr Text) zuerst');
  assert.deepEqual(r.sections.map(s => [s.kind, s.language]),
    [['language', 'de'], ['language', 'en'], ['crossLanguage', null]]);
  // Deutscher Median nur aus den deutschen Büchern: (12 + 14) / 2.
  assert.equal(metric(r, 'satzlaenge', 'language', 'de').median, 13);
  // Ein englisches Buch allein: kein Vergleich, keine Abweichung.
  const en = r.sections.find(s => s.language === 'en');
  assert.equal(en.comparable, false);
  assert.equal(metric(r, 'satzlaenge', 'language', 'en').median, null);
  assert.equal(r.books[1].deviation.satzlaenge, null);
  // Sprachgebundene Kennzahl taucht im sprachübergreifenden Abschnitt nicht auf.
  assert.equal(metric(r, 'satzlaenge', 'crossLanguage'), undefined);
  assert.equal(metric(r, 'fleschDe', 'crossLanguage'), undefined);
});

test('Mehrsprachig: Dialoganteil ist sprachneutral und wird über alle Bücher verglichen', () => {
  const r = computeAuthorProfile(mk([
    { language: 'de', dialog_chars: 600 },   // 10 %
    { language: 'en', dialog_chars: 1800 },  // 30 %
  ]));
  const cross = r.sections.find(s => s.kind === 'crossLanguage');
  assert.deepEqual(cross.metrics.map(m => m.key), ['dialogAnteil']);
  assert.equal(cross.comparable, true);
  assert.ok(Math.abs(metric(r, 'dialogAnteil', 'crossLanguage').median - 0.2) < 1e-9);
  assert.ok(Math.abs(r.books[0].deviation.dialogAnteil - -50) < 1e-9);
  // Je Sprache nur ein Buch: Vergleich ja (Dialog), Entwicklung nein.
  assert.equal(r.comparable, true);
  assert.equal(r.developmentAvailable, false);
  assert.equal(r.sections.find(s => s.language === 'de').metrics.some(m => m.key === 'dialogAnteil'), false);
});

test('Entwicklung braucht zwei Bücher DERSELBEN Sprache', () => {
  const zwei = computeAuthorProfile(mk([{ language: 'en' }, { language: 'en' }, { language: 'de' }]));
  assert.equal(zwei.developmentAvailable, true);
  const einsprachig = computeAuthorProfile(mk([{}, {}]));
  assert.equal(einsprachig.developmentAvailable, true);
  assert.equal(einsprachig.multiLanguage, false);
  assert.equal(computeAuthorProfile(mk([{}])).developmentAvailable, false);
});

test('Unbekannte Sprachangabe gilt als Deutsch — dieselbe Regel wie die Messung', () => {
  const r = computeAuthorProfile(mk([{ language: null }, { language: 'fr' }, { language: 'de' }]));
  assert.equal(r.multiLanguage, false);
  assert.deepEqual(r.languages, ['de']);
  assert.equal(r.sections.length, 1);
  assert.equal(r.sections[0].kind, 'all');
});

test('Basis-Signatur: die Sprache zählt nur im mehrsprachigen Werk', () => {
  const ein = mk([{ book_id: 910, language: 'de' }, { book_id: 911, language: 'de' }]);
  ein.lexicon.forEach((l, i) => { l.content_sig = `s${i}`; });
  assert.equal(authorProfileBasisSig(computeAuthorProfile(ein)), '910:s0|911:s1',
    'einsprachige Signaturen bleiben unverändert — kein Profil wird grundlos veraltet');
  const misch = mk([{ book_id: 910, language: 'de' }, { book_id: 911, language: 'en' }]);
  misch.lexicon.forEach((l, i) => { l.content_sig = `s${i}`; });
  assert.equal(authorProfileBasisSig(computeAuthorProfile(misch)), '910:de:s0|911:en:s1');
});

test('Prompt-Messung: mehrsprachig je Sprache getrennt, mit Hinweis auf die Vergleichbarkeit', () => {
  const r = computeAuthorProfile(mk([
    { book_id: 100, language: 'en' }, { book_id: 101, language: 'de' }, { book_id: 102, language: 'en' },
  ]));
  const txt = renderAuthorProfileMeasurement(r, {
    nameById: { 100: 'Erstling', 101: 'Zweitwerk', 102: 'Drittes' },
    labels: { satzlaenge: 'Satzlaenge', dialogAnteil: 'Dialoganteil' },
    languageNames: { de: 'Deutsch', en: 'Englisch' },
  });
  assert.match(txt, /Sprachen: Englisch: Erstling, Drittes; Deutsch: Zweitwerk\./);
  assert.match(txt, /nur innerhalb einer Sprache vergleichbar/);
  assert.match(txt, /== Englisch ==/);
  assert.match(txt, /== Ueber alle Sprachen ==/);
  // Im deutschen Abschnitt steht kein englisches Buch.
  const de = txt.split('== Deutsch ==')[1].split('==')[0];
  assert.match(de, /Satzlaenge: Zweitwerk/);
  assert.ok(!/Erstling/.test(de));
});

// ── DB-Schicht: die Aggregation im SQL ─────────────────────────────────────────

const AUTOR = 'autor@x.test';
const FREMD = 'fremd@x.test';

function seedBook(bookId, owner, createdAt) {
  db.prepare(
    'INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?,?,?,?,?)'
  ).run(bookId, `Buch ${bookId}`, createdAt, createdAt, owner);
  db.prepare(`
    INSERT INTO book_lexicon (book_id, tokens, pages, mattr, mattr_window, mtld,
                              hapax_ratio, yule_k, heaps_beta, lex_density)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(bookId, LONG, 2, 0.5, 1000, 100, 0.5, 40, 0.78, 0.6);
}

/** Eine Seite mit ihren Kennzahlen. `lix`/`flesch` duerfen null sein. */
function seedPage(pageId, bookId, { words, sentences, chars = 600, lix = null, flesch = null }) {
  db.prepare('INSERT INTO pages (page_id, book_id, page_name) VALUES (?,?,?)').run(pageId, bookId, `S${pageId}`);
  db.prepare(`
    INSERT INTO page_stats (page_id, book_id, words, chars, sentences,
                            dialog_chars, adverb_count, passive_count, filler_count, lix, flesch_de)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(pageId, bookId, words, chars, sentences, 0, 0, 0, 0, lix, flesch);
}

test('DB: Satzlaenge aus Summen — die kurze Seite kippt den Buchwert nicht', () => {
  appUsers.createUser({ email: AUTOR, displayName: 'Autor' });
  seedBook(601, AUTOR, '2020-01-01T00:00:00Z');
  // Seite A: 800 Wörter / 100 Sätze = 8.  Seite B: 4 Wörter / 1 Satz = 4.
  // Summen: 804/101 ≈ 7.96. Als Mittel der Seitenwerte waeren es (8+4)/2 = 6.
  seedPage(6011, 601, { words: 800, sentences: 100 });
  seedPage(6012, 601, { words: 4, sentences: 1 });

  const r = getAuthorProfile(AUTOR);
  assert.equal(r.counts.measured, 1);
  const v = r.books[0].metrics.satzlaenge;
  assert.ok(Math.abs(v - 804 / 101) < 1e-9, `erwartet ~7.96, war ${v}`);
  assert.ok(v > 7, 'Mittel der Seitenmittelwerte (6) waere hier falsch');
});

test('DB: Lesbarkeit wird mit der Wortzahl gewichtet, Seiten ohne Messwert zaehlen nicht mit', () => {
  seedBook(602, AUTOR, '2020-02-01T00:00:00Z');
  // 900 Wörter mit LIX 50, 100 Wörter mit LIX 10 ⇒ gewichtet 46.
  // Dritte Seite hat keinen LIX-Wert und darf den Schnitt nicht gegen null ziehen.
  seedPage(6021, 602, { words: 900, sentences: 90, lix: 50 });
  seedPage(6022, 602, { words: 100, sentences: 10, lix: 10 });
  seedPage(6023, 602, { words: 500, sentences: 50, lix: null });

  const r = getAuthorProfile(AUTOR);
  const buch = r.books.find(b => b.book_id === 602);
  assert.ok(Math.abs(buch.metrics.lix - 46) < 1e-9, `erwartet 46, war ${buch.metrics.lix}`);
});

test('DB: fremde Buecher bleiben draussen — das eigene Stilbild ist das eigene Werk', () => {
  appUsers.createUser({ email: FREMD, displayName: 'Fremd' });
  seedBook(603, FREMD, '2020-03-01T00:00:00Z');
  seedPage(6031, 603, { words: 5000, sentences: 100 });

  const mein = getAuthorProfile(AUTOR);
  assert.ok(!mein.books.some(b => b.book_id === 603), 'fremdes Buch darf nicht im eigenen Profil stehen');
  assert.ok(!mein.skipped.excluded.includes(603), 'und auch nicht als „ausgelassen" auftauchen');

  const fremd = getAuthorProfile(FREMD);
  assert.deepEqual(fremd.books.map(b => b.book_id), [603]);
});

test('DB: Werk-Reihenfolge ist die Spaltenachse (aeltestes Buch zuerst)', () => {
  const r = getAuthorProfile(AUTOR);
  const ids = r.books.map(b => b.book_id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'nach created_at aufsteigend');
});

test('DB: Buchsprache kommt aus book_settings und trennt die Vergleiche', () => {
  seedBook(604, AUTOR, '2020-04-01T00:00:00Z');
  seedPage(6041, 604, { words: 900, sentences: 100 });
  db.prepare("INSERT INTO book_settings (book_id, language, updated_at) VALUES (604, 'en', '2020-04-01T00:00:00Z')").run();
  const r = getAuthorProfile(AUTOR);
  assert.equal(r.books.find(b => b.book_id === 604).language, 'en');
  assert.equal(r.books.find(b => b.book_id === 601).language, 'de', 'ohne Einstellung gilt Deutsch');
  assert.equal(r.multiLanguage, true);
  db.prepare('DELETE FROM book_settings WHERE book_id = 604').run();
  db.prepare('DELETE FROM page_stats WHERE book_id = 604').run();
  db.prepare('DELETE FROM pages WHERE book_id = 604').run();
  db.prepare('DELETE FROM book_lexicon WHERE book_id = 604').run();
  db.prepare('DELETE FROM books WHERE book_id = 604').run();
});

// ── Basis-Signatur + Deutung (Stufe 2) ────────────────────────────────────────

test('Basis-Signatur haengt am Inhalt, nicht am Scan-Zeitpunkt', () => {
  const base = mk([{ book_id: 900 }, { book_id: 901 }]);
  base.lexicon.forEach((l, i) => { l.content_sig = `sig${i}`; });
  const a = authorProfileBasisSig(computeAuthorProfile(base));

  // Erneuter Scan, gleicher Text: anderer Zeitstempel, gleiche Signatur.
  const same = JSON.parse(JSON.stringify(base));
  same.lexicon.forEach(l => { l.scanned_at = '2030-01-01T00:00:00Z'; });
  assert.equal(authorProfileBasisSig(computeAuthorProfile(same)), a);

  // Geaenderter Text: andere Signatur.
  const changed = JSON.parse(JSON.stringify(base));
  changed.lexicon[0].content_sig = 'anders';
  assert.notEqual(authorProfileBasisSig(computeAuthorProfile(changed)), a);
});

test('Ein ungescanntes Buch macht das Profil NICHT veraltet', () => {
  const before = mk([{ book_id: 910 }]);
  before.lexicon[0].content_sig = 'sig';
  const sigBefore = authorProfileBasisSig(computeAuthorProfile(before));

  const after = mk([{ book_id: 910 }, { book_id: 911, noLexicon: true }]);
  after.lexicon[0].content_sig = 'sig';
  // Nur der gemessene Bestand geht ein — ein neu angelegtes, leeres Buch
  // veraendert den gedeuteten Stil nicht und darf ihn nicht entwerten.
  assert.equal(authorProfileBasisSig(computeAuthorProfile(after)), sigBefore);
});

test('Prompt-Messung nutzt die uebergebenen Labels und laesst fehlende Richtung weg', () => {
  const r = computeAuthorProfile(mk([{ words: 1000, sentences: 100 }, { words: 1200, sentences: 100 }]));
  const txt = renderAuthorProfileMeasurement(r, {
    nameById: { 100: 'Erstling', 101: 'Zweitwerk' },
    labels: { satzlaenge: 'Satzlaenge (Woerter je Satz)' },
  });
  assert.match(txt, /Satzlaenge \(Woerter je Satz\)/);
  assert.match(txt, /Erstling/);
  // Bei zwei Buechern gibt es keine Richtung — sie darf auch nicht als
  // „unbekannt" dastehen, sondern faellt weg.
  assert.ok(!/Richtung ueber die Werkhaelften/.test(txt));
  // Ein Key ohne Label faellt auf den Key zurueck, statt zu verschwinden.
  assert.match(txt, /mtld:/);
});

test('DB: Lauf speichern und lesen — edited bleibt 0, Handarbeit setzt es auf 1', () => {
  saveAuthorProfileRun(AUTOR, {
    profilText: 'Knappe Saetze, viel Dialog.',
    konstanten: [{ aspekt: 'Satzbau', beleg: 'durchgehend kurz' }],
    entwicklung: [{ aspekt: 'Dialog', richtung: 'mehr', beleg: '24 % auf 27 %' }],
    basis: [{ book_id: 601, tokens: 5000 }],
    basisSig: '601:abc',
  });
  let row = getAuthorProfileRow(AUTOR);
  assert.equal(row.profil_text, 'Knappe Saetze, viel Dialog.');
  assert.equal(row.konstanten.length, 1);
  assert.equal(row.entwicklung[0].richtung, 'mehr');
  assert.equal(row.edited, false);

  saveAuthorProfileText(AUTOR, 'Von Hand geschrieben.');
  row = getAuthorProfileRow(AUTOR);
  assert.equal(row.profil_text, 'Von Hand geschrieben.');
  assert.equal(row.edited, true);
  // Die Deutungs-Listen gehoeren zum Lauf und bleiben beim Text-Edit stehen.
  assert.equal(row.konstanten.length, 1);
});

test('DB: abweichende Basis-Signatur meldet den Text als veraltet', () => {
  const r1 = getAuthorProfile(AUTOR);
  // Oben wurde mit einer fremden Signatur gespeichert ⇒ veraltet.
  assert.equal(r1.profileStale, true);
  assert.ok(r1.profile, 'der Text bleibt trotzdem lesbar');

  saveAuthorProfileRun(AUTOR, {
    profilText: 'Frisch.', konstanten: [], entwicklung: [],
    basis: [], basisSig: r1.basisSig,
  });
  const r2 = getAuthorProfile(AUTOR);
  assert.equal(r2.profileStale, false);
});

test('DB: ohne Lauf ist das Profil null — und das ist kein Fehler', () => {
  const r = getAuthorProfile(FREMD);
  assert.equal(r.profile, null);
  assert.equal(r.profileStale, false);
  assert.ok(r.counts.measured >= 1, 'die Messung steht auch ohne Deutung');
});

// ── Vererbung an neue Buecher (Stufe 3) ───────────────────────────────────────

const { seedBookStilprofil } = require('../../db/book-settings');
const contentStore = require('../../lib/content-store');

test('seedBookStilprofil fuellt nur eine leere Stelle', () => {
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?,?,?,?)')
    .run(800, 'Seed-Buch', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z');
  const val = () => db.prepare('SELECT stilprofil FROM book_settings WHERE book_id = 800').get()?.stilprofil;

  assert.equal(seedBookStilprofil(800, 'geerbt'), true);
  assert.equal(val(), 'geerbt');

  // Handarbeit am Buch darf eine Vererbung NIE ueberschreiben.
  assert.equal(seedBookStilprofil(800, 'etwas anderes'), false);
  assert.equal(val(), 'geerbt');

  // Leerer Text ist kein Profil.
  db.prepare("UPDATE book_settings SET stilprofil = '' WHERE book_id = 800").run();
  assert.equal(seedBookStilprofil(800, '   '), false);
  assert.equal(val(), '');
});

test('Neues Buch erbt das Autorenprofil — als KOPIE, nicht als Verknuepfung', async () => {
  const ERBE = 'erbe@x.test';
  appUsers.createUser({ email: ERBE, displayName: 'Erbe' });
  saveAuthorProfileRun(ERBE, {
    profilText: 'Kurze Saetze.', konstanten: [], entwicklung: [], basis: [], basisSig: 'x',
  });

  const created = await contentStore.createBook({ name: 'Erbbuch', owner_email: ERBE }, null);
  const stp = () => db.prepare('SELECT stilprofil FROM book_settings WHERE book_id = ?').get(created.id)?.stilprofil;
  assert.equal(stp(), 'Kurze Saetze.');

  // Das Autorenprofil aendert sich — das laufende Manuskript darf NICHT mitwandern,
  // sonst wechselt die Stimme eines Buchs ohne Anlass des Autors.
  saveAuthorProfileText(ERBE, 'Ganz anders.');
  assert.equal(stp(), 'Kurze Saetze.');

  // Und ein spaeter angelegtes Buch bekommt den neuen Stand.
  const zweites = await contentStore.createBook({ name: 'Zweitbuch', owner_email: ERBE }, null);
  assert.equal(
    db.prepare('SELECT stilprofil FROM book_settings WHERE book_id = ?').get(zweites.id)?.stilprofil,
    'Ganz anders.',
  );
});

test('Ohne Autorenprofil wird nichts vorbelegt — und die Buchanlage laeuft normal', async () => {
  const OHNE = 'ohne@x.test';
  appUsers.createUser({ email: OHNE, displayName: 'Ohne' });
  const created = await contentStore.createBook({ name: 'Nacktes Buch', owner_email: OHNE }, null);
  assert.ok(created?.id, 'Buch wurde angelegt');
  const row = db.prepare('SELECT stilprofil FROM book_settings WHERE book_id = ?').get(created.id);
  assert.ok(!row || !row.stilprofil, 'keine Settings-Zeile mit Stilprofil');
});

test('Ohne erkennbaren Autor wird nicht geraten', async () => {
  // Weder `owner_email` im Body noch Session im ctx: es gibt niemanden, dessen
  // Profil gemeint sein koennte — dann lieber gar nichts vorbelegen.
  const created = await contentStore.createBook({ name: 'Herrenlos' }, null);
  const row = db.prepare('SELECT stilprofil FROM book_settings WHERE book_id = ?').get(created.id);
  assert.ok(!row || !row.stilprofil);
});
