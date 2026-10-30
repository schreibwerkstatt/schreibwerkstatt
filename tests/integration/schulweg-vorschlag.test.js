'use strict';
// Integration: Job `schulweg-vorschlag` (routes/jobs/schulweg-vorschlag.js) mit Mock-AI.
// Gegenstand ist die Belegprüfung: nur ein Vorschlag mit wörtlichem Zitat aus den
// vorgelegten Stellen und erlaubtem Weg landet in vorschlag_json; ein Einschulungs-
// jahr nur, wenn es im Zitat steht; Autor-Schulwege werden nicht angefasst;
// Klassenangaben nur mit Jahr und Klasse im Zitat.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx;
test.before(() => { ctx = bootstrap(); });
test.after(() => { ctx.cleanup(); });
test.beforeEach(() => { ctx.mockAi.reset(); ctx.dbSeed.reset(); });

const USER = 'tester@test.dev';

function runJob(bookId) {
  const { runSchulwegVorschlagJob } = require('../../routes/jobs/schulweg-vorschlag');
  const jobId = ctx.shared.createJob('schulweg-vorschlag', bookId, USER, 'job.label.schulwegVorschlag');
  ctx.shared.enqueueJob(jobId, () => runSchulwegVorschlagJob(jobId, bookId, USER));
  return waitForJob(ctx.shared, jobId, { timeoutMs: 15000 });
}

async function seed(BOOK_ID) {
  ctx.dbSeed.setBook({
    chapters: [{ id: BOOK_ID * 10 + 1, book_id: BOOK_ID, name: 'Kap 1' }],
    pages: [{ id: BOOK_ID * 100 + 1, book_id: BOOK_ID, chapter_id: BOOK_ID * 10 + 1, name: 'S 1', updated_at: '' }],
    pageBodies: {
      [BOOK_ID * 100 + 1]: '<p>Anna Berg wurde 1991 in Olten eingeschult. Später ging Anna Berg an die Bez in Olten und danach an die Kanti.</p>'
        + '<p>Beat Keller machte nach der Sek eine Lehre als Mechaniker.</p><p>Carla Moser lachte.</p>',
    },
  });
  ctx.dbSchema.saveFigurenToDb(BOOK_ID, [
    { id: 'f_anna', name: 'Anna Berg', kurzname: 'Anna', geburtstag: '12.3.1985', typ: 'hauptfigur' },
    { id: 'f_beat', name: 'Beat Keller', geburtstag: '1984', typ: 'nebenfigur' },
    { id: 'f_carla', name: 'Carla Moser', typ: 'nebenfigur' },
  ], USER, null);
  const { setBookSchulsystem } = require('../../db/book-settings');
  const sp = await require('../../lib/esm-bridge').schoolPath();
  setBookSchulsystem(BOOK_ID, sp.schulsystemAusVorlage('ch_so_1990'));
  return Object.fromEntries(ctx.dbSchema.db.prepare('SELECT id, fig_id FROM figures WHERE book_id = ? AND user_email = ?')
    .all(BOOK_ID, USER).map(r => [r.fig_id, r.id]));
}

test('belegte Vorschläge landen in vorschlag_json, unbelegte fallen heraus', async () => {
  const BOOK_ID = 960;
  const ids = await seed(BOOK_ID);
  let prompt = '';
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('vorschlaege'),
    (e) => {
      prompt = e.prompt || e.userPrompt || JSON.stringify(e);
      return {
        vorschlaege: [
          // belegt, Einschulungsjahr steht im Zitat
          { figur: 'Anna Berg', weg: 'bez_gym', einschulung_jahr: 1991, repetition_stufe: null, repetition_klasse: null, stelle: '1.2', zitat: 'Anna Berg an die Bez in Olten und danach an die Kanti', begruendung: 'Bez, dann Kanti' },
          // erfundenes Zitat → verworfen
          { figur: 'Beat Keller', weg: 'sek_lehre', einschulung_jahr: null, repetition_stufe: null, repetition_klasse: null, stelle: '2.1', zitat: 'Beat ging nie zur Schule und lernte Bäcker', begruendung: '' },
          // Figur ohne Stellen/Geburtsjahr → verworfen
          { figur: 'Carla Moser', weg: 'bez', einschulung_jahr: null, repetition_stufe: null, repetition_klasse: null, stelle: '3.1', zitat: 'Carla Moser lachte.', begruendung: '' },
        ],
      };
    },
  );
  const job = await runJob(BOOK_ID);
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.result.vorschlaege, 1);
  assert.equal(job.result.verworfen.zitat, 1);
  assert.equal(job.result.verworfen.figur, 1);
  assert.equal(job.result.ohneJahr, 1, 'Carla ohne Geburtsjahr wird nicht gefragt');
  assert.match(prompt, /Bezirksschule/, 'Wege mit Bezeichnung im Prompt');

  const { getSchoolPath } = require('../../db/figure-school-paths');
  const anna = getSchoolPath(ids.f_anna);
  assert.equal(anna.vorschlag.weg, 'bez_gym');
  assert.equal(anna.weg, null, 'Autor-Feld bleibt leer bis zum Übernehmen');
  assert.equal(anna.source, null);
  assert.equal(getSchoolPath(ids.f_beat)?.vorschlag ?? null, null);
});

test('Einschulungsjahr ohne Jahreszahl im Zitat und unerlaubter Weg fallen weg; Autor-Weg bekommt keinen Vorschlag', async () => {
  const BOOK_ID = 961;
  const ids = await seed(BOOK_ID);
  require('../../db/figure-school-paths').setSchoolPath(ids.f_beat, { weg: 'sek_lehre' }, 'autor');
  let calls = 0;
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('vorschlaege'),
    () => {
      calls++;
      return {
        vorschlaege: [
          { figur: 'Anna', weg: 'bez', einschulung_jahr: 1990, repetition_stufe: 'primar', repetition_klasse: 2, stelle: '1.2', zitat: 'ging Anna Berg an die Bez in Olten', begruendung: '' },
          { figur: 'Anna Berg', weg: 'gymnasium', einschulung_jahr: null, repetition_stufe: null, repetition_klasse: null, stelle: '1.2', zitat: 'ging Anna Berg an die Bez in Olten', begruendung: '' },
        ],
      };
    },
  );
  const job = await runJob(BOOK_ID);
  assert.equal(job.status, 'done', job.error || '');
  assert.equal(job.result.autor, 1);
  assert.equal(calls, 1);
  const { getSchoolPath } = require('../../db/figure-school-paths');
  const v = getSchoolPath(ids.f_anna).vorschlag;
  assert.equal(v.weg, 'bez');
  assert.equal(v.einschulung_jahr, undefined, '1990 steht nicht im Zitat');
  assert.equal(v.repetition, undefined, 'kein Repetitionswort im Zitat');
  const beat = getSchoolPath(ids.f_beat);
  assert.equal(beat.weg, 'sek_lehre');
  assert.equal(beat.vorschlag, null);
});

test('ohne Schulsystem endet der Job mit Fehler', async () => {
  const BOOK_ID = 962;
  await seed(BOOK_ID);
  require('../../db/book-settings').setBookSchulsystem(BOOK_ID, null);
  const job = await runJob(BOOK_ID);
  assert.equal(job.status, 'error');
  assert.match(String(job.error), /schulwegNoSystem/);
});

test('Klassenangaben: Jahr und Klasse im Zitat, Urteil gegen die Rechnung; übernommener Weg kommt nicht wieder', async () => {
  const BOOK_ID = 963;
  const ids = await seed(BOOK_ID);
  ctx.dbSeed.setBook({
    chapters: [{ id: BOOK_ID * 10 + 1, book_id: BOOK_ID, name: 'Kap 1' }],
    pages: [{ id: BOOK_ID * 100 + 1, book_id: BOOK_ID, chapter_id: BOOK_ID * 10 + 1, name: 'S 1', updated_at: '' }],
    pageBodies: {
      [BOOK_ID * 100 + 1]: '<p>Im Herbst 1998 kam Anna Berg in die 2. Bez.</p>'
        + '<p>1993 sass Anna Berg in der fünften Klasse.</p>'
        + '<p>Anna Berg mochte die Klasse 1995 nicht.</p>'
        + '<p>Beat Keller machte nach der Sek eine Lehre als Mechaniker.</p>',
    },
  });
  // Beat hat den vorgeschlagenen Weg schon übernommen.
  require('../../db/figure-school-paths').setSchoolPath(ids.f_beat, { weg: 'sek_lehre' }, 'ki');
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('vorschlaege'),
    () => ({
      vorschlaege: [
        { figur: 'Beat Keller', weg: 'sek_lehre', einschulung_jahr: null, repetition_stufe: null, repetition_klasse: null, stelle: '2.1', zitat: 'nach der Sek eine Lehre als Mechaniker', begruendung: '' },
      ],
      klassenangaben: [
        { figur: 'Anna Berg', jahr: 1998, monat: 9, stufe: 'bez', klasse: 2, stelle: '1.1', zitat: 'Im Herbst 1998 kam Anna Berg in die 2. Bez' },
        { figur: 'Anna Berg', jahr: 1993, monat: null, stufe: 'primar', klasse: 5, stelle: '1.2', zitat: '1993 sass Anna Berg in der fünften Klasse' },
        // Klassennummer steht nicht im Zitat → verworfen
        { figur: 'Anna Berg', jahr: 1995, monat: null, stufe: 'primar', klasse: 4, stelle: '1.3', zitat: 'Anna Berg mochte die Klasse 1995 nicht' },
      ],
    }),
  );
  const job = await runJob(BOOK_ID);
  assert.equal(job.status, 'done', job.error || '');
  assert.equal(job.result.klassenangaben, 2);
  assert.equal(job.result.widersprueche, 1, '1993 war Anna in der 2./3. Primar, nicht in der 5.');
  assert.equal(job.result.verworfen.klasse, 1);
  assert.equal(job.result.schonUebernommen, 1);
  assert.equal(job.result.vorschlaege, 0);

  const { getSchoolPath } = require('../../db/figure-school-paths');
  const anna = getSchoolPath(ids.f_anna);
  assert.deepEqual(anna.klassenangaben.map(a => [a.jahr, a.stufe, a.klasse]), [[1998, 'bez', 2], [1993, 'primar', 5]]);
  assert.equal(anna.klassenangaben[0].page_id, BOOK_ID * 100 + 1);
  assert.equal(getSchoolPath(ids.f_beat).vorschlag, null);
});
