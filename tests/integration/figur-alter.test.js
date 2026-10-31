'use strict';
// Integration: Alters-Analyse der Figuren (routes/jobs/figur-alter.js) mit Mock-AI.
//
// Testgegenstand ist die Naht zwischen den drei Schichten — Kandidatensuche →
// Modell → Verifikation/Verdichtung → abgeleiteter Index. Die reinen Schichten
// sind separat gegated (tests/unit/figure-age.test.js); hier zaehlt, dass ein
// erfundenes Zitat und eine im Zitat nicht vorkommende Zahl WIRKLICH herausfallen
// und dass nur verifizierte Angaben in figure_ages/figure_age_belege landen.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx;
test.before(() => { ctx = bootstrap(); });
test.after(() => { ctx.cleanup(); });

test.beforeEach(() => {
  ctx.mockAi.reset();
  ctx.dbSeed.reset();
});

const USER = 'tester@test.dev';

function seedFiguren(bookId, figuren) {
  ctx.dbSchema.saveFigurenToDb(bookId, figuren, USER, null);
  return ctx.dbSchema.db.prepare(
    'SELECT id, fig_id FROM figures WHERE book_id = ? AND user_email = ?'
  ).all(bookId, USER);
}

function runJob(bookId, opts = {}) {
  const jobId = ctx.shared.createJob('figur-alter', bookId, USER, 'job.label.figurAlter');
  ctx.shared.enqueueJob(jobId, () => ctx.figurAlter.runFigurAlterJob(jobId, bookId, USER, opts));
  return waitForJob(ctx.shared, jobId, { timeoutMs: 15000 });
}

test('Kandidatensaetze werden gefunden, verifizierte Funde landen im Index', async () => {
  const BOOK_ID = 900;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9010, book_id: BOOK_ID, name: 'Kap 1' }],
    pages: [
      { id: 9020, book_id: BOOK_ID, chapter_id: 9010, name: 'S 1', updated_at: '' },
      { id: 9021, book_id: BOOK_ID, chapter_id: 9010, name: 'S 2', updated_at: '' },
    ],
    pageBodies: {
      9020: '<p>Anna Berg betrat den Saal. Sie war damals zwölf Jahre alt und trug ein blaues Kleid.</p>',
      9021: '<p>Konrad, geboren 1888, schwieg. Die neunzehnjährige Anna Berg widersprach ihm.</p>',
    },
  });
  seedFiguren(BOOK_ID, [
    { id: 'f_anna', name: 'Anna Berg', kurzname: 'Anna', typ: 'hauptfigur' },
    { id: 'f_konrad', name: 'Konrad', typ: 'nebenfigur' },
  ]);

  // Das Modell bekommt die Kandidatensaetze und meldet, was darin steht.
  // Bewusst dabei: ein FREI ERFUNDENES Zitat und eine Zahl, die im (echten)
  // Zitat nicht vorkommt — beides muss herausfallen.
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('funde'),
    () => ({
      funde: [
        { figur: 'Anna Berg', art: 'alter', wert: 12, bezugsjahr: null, unsicher: false, zitat: 'Sie war damals zwölf Jahre alt', begruendung: 'wörtlich' },
        { figur: 'Anna', art: 'alter', wert: 19, bezugsjahr: null, unsicher: false, zitat: 'Die neunzehnjährige Anna Berg', begruendung: 'wörtlich' },
        { figur: 'Konrad', art: 'geburtsjahr', wert: 1888, bezugsjahr: null, unsicher: false, zitat: 'Konrad, geboren 1888', begruendung: 'wörtlich' },
        // erfundenes Zitat → Zitat-Pruefung
        { figur: 'Konrad', art: 'alter', wert: 55, bezugsjahr: null, unsicher: false, zitat: 'Konrad war fünfundfünfzig Jahre alt', begruendung: 'erfunden' },
        // echtes Zitat, aber die Zahl steht nicht darin → Zahl-Pruefung
        { figur: 'Anna Berg', art: 'alter', wert: 30, bezugsjahr: null, unsicher: false, zitat: 'Sie war damals zwölf Jahre alt', begruendung: 'gerechnet' },
        // unbekannte Figur → Namens-Zuordnung
        { figur: 'Niemand', art: 'alter', wert: 40, bezugsjahr: null, unsicher: false, zitat: 'egal', begruendung: '' },
      ],
    }),
  );

  const job = await runJob(BOOK_ID);
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.result.verworfen.zitat, 1, 'erfundenes Zitat verworfen');
  assert.equal(job.result.verworfen.zahl, 1, 'Zahl nicht im Zitat → verworfen');
  assert.equal(job.result.verworfen.figur, 1, 'unbekannte Figur verworfen');

  const rows = require('../../db/figure-ages').listFigureAges(BOOK_ID, USER);
  const anna = rows.find(r => r.fig_id === 'f_anna');
  const konrad = rows.find(r => r.fig_id === 'f_konrad');

  // Anna: Spanne aus zwei verifizierten Angaben, Quelle Text.
  assert.ok(anna, 'Anna hat eine Zeile');
  assert.equal(anna.alter_von, 12);
  assert.equal(anna.alter_bis, 19);
  assert.equal(anna.quelle, 'text');
  assert.equal(anna.belege.length, 2, 'nur die verifizierten Belege');
  assert.ok(anna.belege.every(b => b.page_id != null), 'Beleg hat ein Sprungziel');

  // Konrad: Geburtsjahr aus dem Text, kein Alter (das erfundene fiel heraus).
  assert.ok(konrad, 'Konrad hat eine Zeile');
  assert.equal(konrad.geburtsjahr, 1888);
  assert.equal(konrad.geburtsjahr_quelle, 'text');
  assert.equal(konrad.alter_von, null, 'kein erfundenes Alter');
  // Das belegte Textjahr traegt die Plot-Zeit, auch ohne Alter und ohne Zeitlinie
  // (die Alters-Konfidenz der Zeile ist dann 0 — sie gehoert zum Alter, nicht zum Jahr).
  const konradId = ctx.dbSchema.db.prepare("SELECT id FROM figures WHERE book_id = ? AND fig_id = 'f_konrad'").get(BOOK_ID).id;
  assert.equal(require('../../db/figure-ages').listAnalysedBirthYears(BOOK_ID, USER).get(konradId), 1888);

  // Lauf-Kopf für „Stand vom" + Delta-Skip.
  const scan = require('../../db/figure-ages').getFigureAgeScan(BOOK_ID, USER);
  assert.ok(scan?.content_sig, 'content_sig gesetzt');
  assert.equal(scan.figuren_total, 2);
  assert.equal(scan.mit_alter, 1);
});

test('Delta-Skip: unveraenderter Buchstand ohne force laeuft nicht erneut durchs Modell', async () => {
  const BOOK_ID = 901;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9110, book_id: BOOK_ID, name: 'Kap 1' }],
    pages: [{ id: 9120, book_id: BOOK_ID, chapter_id: 9110, name: 'S 1', updated_at: '' }],
    pageBodies: { 9120: '<p>Mara war vierzig Jahre alt, als sie ging.</p>' },
  });
  seedFiguren(BOOK_ID, [{ id: 'f_mara', name: 'Mara', typ: 'hauptfigur' }]);
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('funde'),
    () => ({ funde: [{ figur: 'Mara', art: 'alter', wert: 40, bezugsjahr: null, unsicher: false, zitat: 'Mara war vierzig Jahre alt', begruendung: '' }] }),
  );

  const first = await runJob(BOOK_ID, { force: true });
  assert.equal(first.status, 'done');
  const callsAfterFirst = ctx.mockAi.log.length;
  assert.ok(callsAfterFirst >= 1);

  const second = await runJob(BOOK_ID, { force: false });
  assert.equal(second.status, 'done');
  assert.equal(second.result.skipped, true, 'zweiter Lauf uebersprungen');
  assert.equal(ctx.mockAi.log.length, callsAfterFirst, 'kein weiterer KI-Call');

  // Mit force laeuft er trotzdem — „ich will jetzt eine Zahl sehen".
  const third = await runJob(BOOK_ID, { force: true });
  assert.equal(third.status, 'done');
  assert.notEqual(third.result.skipped, true);
  assert.ok(ctx.mockAi.log.length > callsAfterFirst);
});

test('Figur ohne Altersangabe im Text bekommt keine Zeile', async () => {
  const BOOK_ID = 902;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9210, book_id: BOOK_ID, name: 'Kap 1' }],
    pages: [{ id: 9220, book_id: BOOK_ID, chapter_id: 9210, name: 'S 1', updated_at: '' }],
    pageBodies: { 9220: '<p>Jonas ging zum Fluss und schwieg lange.</p>' },
  });
  seedFiguren(BOOK_ID, [{ id: 'f_jonas', name: 'Jonas', typ: 'hauptfigur' }]);
  // Kein Kandidatensatz → gar kein KI-Call.
  const job = await runJob(BOOK_ID, { force: true });
  assert.equal(job.status, 'done', job.error || '');
  assert.equal(ctx.mockAi.log.length, 0, 'ohne Kandidaten kein KI-Call');
  assert.equal(require('../../db/figure-ages').listFigureAges(BOOK_ID, USER).length, 0);
});

test('Ohne Figuren bricht der Job mit sprechendem Fehler ab', async () => {
  const BOOK_ID = 903;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9310, book_id: BOOK_ID, name: 'Kap 1' }],
    pages: [{ id: 9320, book_id: BOOK_ID, chapter_id: 9310, name: 'S 1', updated_at: '' }],
    pageBodies: { 9320: '<p>Irgendwer war zwölf Jahre alt.</p>' },
  });
  const job = await runJob(BOOK_ID, { force: true });
  assert.equal(job.status, 'error');
  assert.match(String(job.error), /figurAlterNoFiguren/);
});

test('Ein mehrdeutiger Kurzname wird nicht geraten', async () => {
  const BOOK_ID = 904;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9410, book_id: BOOK_ID, name: 'Kap 1' }],
    pages: [{ id: 9420, book_id: BOOK_ID, chapter_id: 9410, name: 'S 1', updated_at: '' }],
    pageBodies: { 9420: '<p>Anna Berg war zwölf Jahre alt. Anna Meier war vierzig Jahre alt.</p>' },
  });
  // Beide tragen den Kurznamen «Anna» — eine Antwort mit «Anna» ist nicht zuordenbar.
  seedFiguren(BOOK_ID, [
    { id: 'f_ab', name: 'Anna Berg', kurzname: 'Anna', typ: 'hauptfigur' },
    { id: 'f_am', name: 'Anna Meier', kurzname: 'Anna', typ: 'nebenfigur' },
  ]);
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('funde'),
    () => ({
      funde: [
        { figur: 'Anna', art: 'alter', wert: 12, bezugsjahr: null, unsicher: false, zitat: 'Anna Berg war zwölf Jahre alt', begruendung: '' },
        { figur: 'Anna Meier', art: 'alter', wert: 40, bezugsjahr: null, unsicher: false, zitat: 'Anna Meier war vierzig Jahre alt', begruendung: '' },
      ],
    }),
  );

  const job = await runJob(BOOK_ID, { force: true });
  assert.equal(job.status, 'done', job.error || '');
  assert.equal(job.result.verworfen.figur, 1, 'mehrdeutiger Kurzname verworfen');

  const rows = require('../../db/figure-ages').listFigureAges(BOOK_ID, USER);
  assert.equal(rows.length, 1, 'nur die eindeutig benannte Figur');
  assert.equal(rows[0].fig_id, 'f_am');
  assert.equal(rows[0].alter_von, 40);
});

test('Abbruch waehrend des Laufs: Status cancelled, der vorige Index bleibt stehen', async () => {
  const BOOK_ID = 905;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9510, book_id: BOOK_ID, name: 'Kap 1' }],
    pages: [{ id: 9520, book_id: BOOK_ID, chapter_id: 9510, name: 'S 1', updated_at: '' }],
    pageBodies: { 9520: '<p>Mara war vierzig Jahre alt, als sie ging.</p>' },
  });
  seedFiguren(BOOK_ID, [{ id: 'f_mara', name: 'Mara', typ: 'hauptfigur' }]);
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('funde'),
    () => ({ funde: [{ figur: 'Mara', art: 'alter', wert: 40, bezugsjahr: null, unsicher: false, zitat: 'Mara war vierzig Jahre alt', begruendung: '' }] }),
  );
  const first = await runJob(BOOK_ID, { force: true });
  assert.equal(first.status, 'done', first.error || '');
  const ages = require('../../db/figure-ages');
  assert.equal(ages.listFigureAges(BOOK_ID, USER).length, 1);

  // Zweiter Lauf: der Job wird abgebrochen, waehrend das Modell antwortet. Der Mock
  // ignoriert das Signal (wie ein Provider, dessen Antwort schon unterwegs war) und
  // liefert eine LEERE Fundliste — schriebe der Job danach weiter, waere Maras Zeile weg.
  ctx.mockAi.reset();
  const jobId = ctx.shared.createJob('figur-alter', BOOK_ID, USER, 'job.label.figurAlter');
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('funde'),
    () => { ctx.shared.cancelJob(jobId, USER); return { funde: [] }; },
  );
  ctx.shared.enqueueJob(jobId, () => ctx.figurAlter.runFigurAlterJob(jobId, BOOK_ID, USER, { force: true }));
  const second = await waitForJob(ctx.shared, jobId, { timeoutMs: 15000 });
  assert.equal(second.status, 'cancelled');
  const rows = ages.listFigureAges(BOOK_ID, USER);
  assert.equal(rows.length, 1, 'vorheriger Index unveraendert');
  assert.equal(rows[0].alter_von, 40);
});

test('Nachrichtenverlauf: Chat-Zeile klebt nicht an der Erzählung, Absenderzeile macht den Sprecher', async () => {
  const BOOK_ID = 960;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9610, book_id: BOOK_ID, name: 'Kap 1' }],
    pages: [{ id: 9620, book_id: BOOK_ID, chapter_id: 9610, name: 'S 1', updated_at: '' }],
    pageBodies: {
      9620: '<p>Anna Berg starrte aufs Handy.</p>'
        + '<div class="msg-thread"><p class="msg-name">Lena</p><p class="msg-in">werd morgen 30 jahre alt lol</p>'
        + '<p class="msg-out">bin jetzt 18 jahre alt</p></div>'
        + '<p>Anna legte das Handy weg. Sie war 42 Jahre alt und müde.</p>',
    },
  });
  seedFiguren(BOOK_ID, [
    { id: 'f_anna', name: 'Anna Berg', kurzname: 'Anna', typ: 'hauptfigur' },
    { id: 'f_lena', name: 'Lena', typ: 'nebenfigur' },
  ]);
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('funde'),
    () => ({
      funde: [
        { figur: 'Anna Berg', art: 'alter', wert: 42, bezugsjahr: null, unsicher: false, zitat: 'Sie war 42 Jahre alt und müde', begruendung: 'wörtlich' },
        // Die ausgehende Nachricht ist keine Stelle von Anna → Zitat-Pruefung
        { figur: 'Anna Berg', art: 'alter', wert: 18, bezugsjahr: null, unsicher: false, zitat: 'bin jetzt 18 jahre alt', begruendung: 'Nachricht' },
        { figur: 'Lena', art: 'alter', wert: 30, bezugsjahr: null, unsicher: false, zitat: 'werd morgen 30 jahre alt', begruendung: 'Absenderzeile' },
      ],
    }),
  );

  const job = await runJob(BOOK_ID);
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.result.verworfen.zitat, 1, 'Annas 18 aus der ausgehenden Nachricht ist nicht belegt');

  const rows = require('../../db/figure-ages').listFigureAges(BOOK_ID, USER);
  const anna = rows.find(r => r.fig_id === 'f_anna');
  const lena = rows.find(r => r.fig_id === 'f_lena');
  assert.equal(anna.alter_von, 42);
  assert.equal(anna.alter_bis, 42, 'kein Widerspruch 18 vs. 42');
  assert.equal(lena.alter_von, 30, 'Nachricht über die Absenderzeile Lena zugeordnet');
});

test('Absatzgrenzen: eine Ueberschrift mit Figurennamen ist keine direkte Nennung', async () => {
  const BOOK_ID = 970;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9710, book_id: BOOK_ID, name: 'Kap 1' }],
    pages: [{ id: 9720, book_id: BOOK_ID, chapter_id: 9710, name: 'S 1', updated_at: '' }],
    pageBodies: { 9720: '<h2>Anna</h2><p>Die Frau am Fenster war 70 Jahre alt.</p>' },
  });
  seedFiguren(BOOK_ID, [{ id: 'f_anna', name: 'Anna', typ: 'hauptfigur' }]);
  let prompt = '';
  ctx.mockAi.on((e) => e.schemaKeys.includes('funde'), (e) => { prompt = e.prompt || ''; return { funde: [] }; });

  const job = await runJob(BOOK_ID, { force: true });
  assert.equal(job.status, 'done', job.error || '');
  assert.match(prompt, /\[Figur steht im Satz davor\] Anna Die Frau am Fenster war 70 Jahre alt\./);
});

test('Mehrdeutiges Zitat: die genannte Stellennummer bestimmt das Sprungziel', async () => {
  const BOOK_ID = 980;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9810, book_id: BOOK_ID, name: 'Kap 1' }],
    pages: [
      { id: 9820, book_id: BOOK_ID, chapter_id: 9810, name: 'S 1', updated_at: '' },
      { id: 9821, book_id: BOOK_ID, chapter_id: 9810, name: 'S 2', updated_at: '' },
    ],
    pageBodies: {
      9820: '<p>Mara war vierzig Jahre alt, sagte man.</p>',
      9821: '<p>Mara war vierzig Jahre alt, sagte sie selbst.</p>',
    },
  });
  seedFiguren(BOOK_ID, [{ id: 'f_mara', name: 'Mara', typ: 'hauptfigur' }]);
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('funde'),
    () => ({ funde: [{ figur: 'Mara', art: 'alter', wert: 40, bezugsjahr: null, unsicher: false, stelle: '1.2', zitat: 'Mara war vierzig Jahre alt', begruendung: '' }] }),
  );

  const job = await runJob(BOOK_ID, { force: true });
  assert.equal(job.status, 'done', job.error || '');
  const [row] = require('../../db/figure-ages').listFigureAges(BOOK_ID, USER);
  assert.equal(row.belege[0].page_id, 9821, 'Stelle 1.2 = zweite Seite, nicht die erste Fundstelle');
});

test('Bezugsjahr nur, wenn es in der vorgelegten Stelle steht', async () => {
  const BOOK_ID = 990;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9910, book_id: BOOK_ID, name: 'Kap 1' }],
    pages: [{ id: 9920, book_id: BOOK_ID, chapter_id: 9910, name: 'S 1', updated_at: '' }],
    pageBodies: { 9920: '<p>Im Sommer 1912 war Mara zwölf Jahre alt. Lena war vierzig Jahre alt.</p>' },
  });
  seedFiguren(BOOK_ID, [
    { id: 'f_mara', name: 'Mara', typ: 'hauptfigur' },
    { id: 'f_lena', name: 'Lena', typ: 'nebenfigur' },
  ]);
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('funde'),
    () => ({
      funde: [
        { figur: 'Mara', art: 'alter', wert: 12, bezugsjahr: 1912, unsicher: false, zitat: 'Mara zwölf Jahre alt', begruendung: '' },
        // 1930 steht nirgends in Lenas Stelle — aus dem Kontext erschlossen
        { figur: 'Lena', art: 'alter', wert: 40, bezugsjahr: 1930, unsicher: false, zitat: 'Lena war vierzig Jahre alt', begruendung: '' },
      ],
    }),
  );

  const job = await runJob(BOOK_ID, { force: true });
  assert.equal(job.status, 'done', job.error || '');
  assert.equal(job.result.verworfen.bezugsjahr, 1);
  const rows = require('../../db/figure-ages').listFigureAges(BOOK_ID, USER);
  const mara = rows.find(r => r.fig_id === 'f_mara');
  const lena = rows.find(r => r.fig_id === 'f_lena');
  assert.equal(mara.belege[0].bezugsjahr, 1912);
  assert.equal(lena.alter_von, 40, 'der Fund bleibt');
  assert.equal(lena.belege[0].bezugsjahr, null, 'nur das erschlossene Jahr faellt');
});

test('Zwei Figuren mit gleichem Vollnamen: Funde werden nicht geraten', async () => {
  const BOOK_ID = 991;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9911, book_id: BOOK_ID, name: 'Kap 1' }],
    pages: [{ id: 9921, book_id: BOOK_ID, chapter_id: 9911, name: 'S 1', updated_at: '' }],
    pageBodies: { 9921: '<p>Tom war zwölf Jahre alt.</p>' },
  });
  seedFiguren(BOOK_ID, [
    { id: 'f_t1', name: 'Tom', typ: 'hauptfigur' },
    { id: 'f_t2', name: 'Tom', typ: 'nebenfigur' },
  ]);
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('funde'),
    () => ({ funde: [{ figur: 'Tom', art: 'alter', wert: 12, bezugsjahr: null, unsicher: false, zitat: 'Tom war zwölf Jahre alt', begruendung: '' }] }),
  );

  const job = await runJob(BOOK_ID, { force: true });
  assert.equal(job.status, 'done', job.error || '');
  assert.equal(job.result.verworfen.figur, 1);
  assert.equal(require('../../db/figure-ages').listFigureAges(BOOK_ID, USER).length, 0);
});

test('Veraltet-Hinweis: Analyse-Version, spaeterer Text, spaeterer Figurenstamm', async () => {
  const BOOK_ID = 912;
  ctx.dbSeed.setBook({
    chapters: [{ id: 9910, book_id: BOOK_ID, name: 'Kap 1' }],
    pages: [{ id: 9920, book_id: BOOK_ID, chapter_id: 9910, name: 'S 1', updated_at: '' }],
    pageBodies: { 9920: '<p>Mara war vierzig Jahre alt, als sie ging.</p>' },
  });
  seedFiguren(BOOK_ID, [{ id: 'f_mara', name: 'Mara', typ: 'hauptfigur' }]);
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('funde'),
    () => ({ funde: [{ figur: 'Mara', art: 'alter', wert: 40, bezugsjahr: null, unsicher: false, zitat: 'Mara war vierzig Jahre alt', begruendung: '' }] }),
  );
  const job = await runJob(BOOK_ID, { force: true });
  assert.equal(job.status, 'done');

  const { staleReasons } = require('../../routes/figures-alter');
  const { getFigureAgeScan } = require('../../db/figure-ages');
  const { db } = ctx.dbSchema;
  const scan = getFigureAgeScan(BOOK_ID, USER);
  assert.deepEqual(staleReasons(BOOK_ID, USER, scan), [], 'frischer Lauf ist aktuell');

  assert.deepEqual(staleReasons(BOOK_ID, USER, { ...scan, age_version: scan.age_version - 1 }), ['version']);

  const later = new Date(Date.parse(scan.scanned_at) + 60_000).toISOString();
  db.prepare('UPDATE figures SET updated_at = ? WHERE book_id = ?').run(later, BOOK_ID);
  assert.deepEqual(staleReasons(BOOK_ID, USER, scan), ['figuren'], 'Komplettanalyse nach dem Lauf');

  db.prepare('UPDATE pages SET updated_at = ?, local_updated_at = ? WHERE page_id = ?').run(later, later, 9920);
  assert.deepEqual(staleReasons(BOOK_ID, USER, scan), ['text', 'figuren']);
});
