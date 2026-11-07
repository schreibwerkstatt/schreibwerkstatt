'use strict';
// Integration: Job `stationen-vorschlag` (routes/jobs/stationen-vorschlag.js) mit Mock-AI.
// Gegenstand ist die Belegprüfung: nur Einträge mit wörtlichem Zitat aus den
// vorgelegten Stellen und einem Wort der Tätigkeit im Zitat landen als Vorschlag;
// Jahre nur, wenn sie im Zitat stehen; aktive Zeilen fasst der Job nie an, und
// was schon erfasst ist, schlägt er nicht noch einmal vor.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx;
test.before(() => { ctx = bootstrap(); });
test.after(() => { ctx.cleanup(); });
test.beforeEach(() => { ctx.mockAi.reset(); ctx.dbSeed.reset(); });

const USER = 'tester@test.dev';

function runJob(bookId) {
  const { runStationenVorschlagJob } = require('../../routes/jobs/stationen-vorschlag');
  const jobId = ctx.shared.createJob('stationen-vorschlag', bookId, USER, 'job.label.stationenVorschlag');
  ctx.shared.enqueueJob(jobId, () => runStationenVorschlagJob(jobId, bookId, USER));
  return waitForJob(ctx.shared, jobId, { timeoutMs: 15000 });
}

function seed(BOOK_ID) {
  ctx.dbSeed.setBook({
    chapters: [{ id: BOOK_ID * 10 + 1, book_id: BOOK_ID, name: 'Kap 1' }],
    pages: [{ id: BOOK_ID * 100 + 1, book_id: BOOK_ID, chapter_id: BOOK_ID * 10 + 1, name: 'S 1', updated_at: '' }],
    pageBodies: {
      [BOOK_ID * 100 + 1]: '<p>Seit 2003 arbeitet Anna Berg als Pflegefachfrau im Kantonsspital Olten.</p>'
        + '<p>Am Wochenende spielt Anna Berg Unihockey im Verein.</p>'
        + '<p>Beat Keller machte eine Lehre als Mechaniker.</p><p>Carla Moser lachte.</p>',
    },
  });
  ctx.dbSchema.saveFigurenToDb(BOOK_ID, [
    { id: 'f_anna', name: 'Anna Berg', kurzname: 'Anna', geburtstag: '1985', typ: 'hauptfigur' },
    { id: 'f_beat', name: 'Beat Keller', geburtstag: '1984', typ: 'nebenfigur' },
    { id: 'f_carla', name: 'Carla Moser', typ: 'nebenfigur' },
  ], USER, null);
  return Object.fromEntries(ctx.dbSchema.db.prepare('SELECT id, fig_id FROM figures WHERE book_id = ? AND user_email = ?')
    .all(BOOK_ID, USER).map(r => [r.fig_id, r.id]));
}

const _z = { von_monat: null, bis_jahr: null, bis_monat: null };

test('belegte Einträge werden Vorschläge, unbelegte und erfundene fallen heraus', async () => {
  const BOOK_ID = 970;
  const ids = seed(BOOK_ID);
  let prompt = '';
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('berufe'),
    (e) => {
      prompt = e.prompt || e.userPrompt || JSON.stringify(e);
      return {
        berufe: [
          // belegt, Jahr im Zitat
          { figur: 'Anna Berg', art: 'beruf', taetigkeit: 'Pflegefachfrau', arbeitgeber: 'Kantonsspital Olten', ort: 'Olten', von_jahr: 2003, ..._z, stelle: '1.1', zitat: 'Seit 2003 arbeitet Anna Berg als Pflegefachfrau', begruendung: 'arbeitet als' },
          // belegt, Jahr erfunden → Eintrag bleibt, Jahr fällt
          { figur: 'Beat Keller', art: 'ausbildung', taetigkeit: 'Lehre als Mechaniker', arbeitgeber: '', ort: '', von_jahr: 2000, ..._z, stelle: '2.1', zitat: 'Beat Keller machte eine Lehre als Mechaniker', begruendung: '' },
          // Tätigkeit steht nicht im Zitat → verworfen
          { figur: 'Anna Berg', art: 'beruf', taetigkeit: 'Chirurgin', arbeitgeber: '', ort: '', von_jahr: null, ..._z, stelle: '1.1', zitat: 'Seit 2003 arbeitet Anna Berg als Pflegefachfrau', begruendung: '' },
          // erfundenes Zitat → verworfen
          { figur: 'Carla Moser', art: 'beruf', taetigkeit: 'Bäckerin', arbeitgeber: '', ort: '', von_jahr: null, ..._z, stelle: '3.1', zitat: 'Carla Moser backte jeden Tag Brot', begruendung: '' },
        ],
        hobbys: [
          { figur: 'Anna', hobby: 'Unihockey', ort: '', von_jahr: null, ..._z, stelle: '1.2', zitat: 'spielt Anna Berg Unihockey im Verein', begruendung: '' },
        ],
      };
    },
  );
  const job = await runJob(BOOK_ID);
  assert.equal(job.status, 'done', `expected done, got ${job.status}: ${job.error || ''}`);
  assert.equal(job.result.berufe, 2);
  assert.equal(job.result.hobbys, 1);
  assert.equal(job.result.verworfen.feld, 1);
  assert.ok(job.result.verworfen.zitat + job.result.verworfen.figur >= 1);
  assert.equal(job.result.verworfen.jahr, 1);
  assert.match(prompt, /Pflegefachfrau/);

  const { listStationenForFigure } = require('../../db/figure-stationen');
  const anna = listStationenForFigure('berufe', ids.f_anna);
  assert.equal(anna.length, 1);
  assert.equal(anna[0].status, 'vorschlag');
  assert.equal(anna[0].von_jahr, 2003);
  assert.equal(anna[0].arbeitgeber, 'Kantonsspital Olten');
  assert.ok(anna[0].page_id, 'Beleg-Sprungziel gesetzt');
  const beat = listStationenForFigure('berufe', ids.f_beat);
  assert.equal(beat[0].art, 'ausbildung');
  assert.equal(beat[0].von_jahr, null, '2000 steht nicht im Zitat');
  assert.equal(listStationenForFigure('hobbys', ids.f_anna)[0].hobby, 'Unihockey');
});

test('aktive Zeilen bleiben, Gleiches wird nicht erneut vorgeschlagen, alter Vorschlag wird ersetzt', async () => {
  const BOOK_ID = 971;
  const ids = seed(BOOK_ID);
  const st = require('../../db/figure-stationen');
  st.createStation('berufe', ids.f_anna, { taetigkeit: 'Pflegefachfrau', art: 'beruf', von_jahr: 2003 }, { status: 'aktiv', source: 'autor' });
  st.createStation('hobbys', ids.f_anna, { hobby: 'Schach' }, { status: 'vorschlag', source: 'ki' });
  ctx.mockAi.on(
    (e) => e.schemaKeys.includes('berufe'),
    () => ({
      berufe: [
        { figur: 'Anna Berg', art: 'beruf', taetigkeit: 'Pflegefachfrau', arbeitgeber: '', ort: '', von_jahr: 2003, ..._z, stelle: '1.1', zitat: 'Seit 2003 arbeitet Anna Berg als Pflegefachfrau', begruendung: '' },
      ],
      hobbys: [],
    }),
  );
  const job = await runJob(BOOK_ID);
  assert.equal(job.status, 'done', job.error || '');
  assert.equal(job.result.schonVorhanden, 1);
  const berufe = st.listStationenForFigure('berufe', ids.f_anna);
  assert.deepEqual(berufe.map(s => [s.status, s.source]), [['aktiv', 'autor']]);
  assert.equal(st.listStationenForFigure('hobbys', ids.f_anna).length, 0, 'alter Vorschlag durch den Stand dieses Laufs ersetzt');
});
