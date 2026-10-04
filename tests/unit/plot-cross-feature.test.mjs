// Plot-Werkstatt, Gegenrichtung der Verknüpfungen: was die anderen Features vom
// Board zurückbekommen.
//   · plotEntityLinks   — Figuren-/Orte-/Szenen-Detail („Im Plot")
//   · get_plot_board    — Buch-Chat sieht Orte, Motive, Zeit, Spannung, Kanten
//   · loadChapterPlanContext + _buildPlanContextBlock — Kapitelbewertung

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('plot-cross-feature');

const schema = require('../../db/schema');
const appUsers = require('../../db/app-users');
const plot = require('../../db/plot');
const { db } = require('../../db/connection');
const { tool_get_plot_board } = require('../../routes/jobs/book-chat-tools/tools-plot');
const { loadChapterPlanContext } = require('../../routes/jobs/review-context');
const { _buildPlanContextBlock, _planAchse } = await import('../../public/js/prompts/review/context.js');
const { buildChapterReviewPrompt } = await import('../../public/js/prompts/review/builders.js');
const { chapterReviewAxes } = await import('../../public/js/prompts/review-typen.js');

const USER = 'xfeat@x.test';
const OTHER = 'fremd-xfeat@x.test';
let bookSeq = 772100;

appUsers.createUser({ email: USER, displayName: 'X' });
appUsers.createUser({ email: OTHER, displayName: 'Fremd' });

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
function freshBook() {
  const id = ++bookSeq;
  schema.upsertBookByName(id, `Buch ${id}`);
  return id;
}
const seedFigur = (B, figId, name, user = USER) => db.prepare(
  `INSERT INTO figures (book_id, user_email, fig_id, name, kurzname, updated_at) VALUES (?, ?, ?, ?, ?, ${NOW})`
).run(B, user, figId, name, name).lastInsertRowid;
const seedOrt = (B, locId, name) => db.prepare(
  `INSERT INTO locations (book_id, loc_id, name, user_email, updated_at) VALUES (?, ?, ?, ?, ${NOW})`
).run(B, locId, name, USER).lastInsertRowid;
const seedSzene = (B, titel) => db.prepare(
  'INSERT INTO figure_scenes (book_id, user_email, titel) VALUES (?, ?, ?)'
).run(B, USER, titel).lastInsertRowid;
const seedKapitel = (B, name) => db.prepare(
  'INSERT INTO chapters (book_id, chapter_name) VALUES (?, ?)'
).run(B, name).lastInsertRowid;

test('plotEntityLinks figure: direkt + vom Strang geerbt, verworfen und fremde User raus', () => {
  const B = freshBook();
  const anna = seedFigur(B, 'fig_anna', 'Anna');
  const carl = seedFigur(B, 'fig_carl', 'Carl');
  const a1 = plot.createAct(B, USER, { name: 'A1' });
  const a2 = plot.createAct(B, USER, { name: 'A2' });
  const strang = plot.createThread(B, USER, { name: 'Annas Strang', figureId: anna });
  const spaet = plot.createBeat(B, a2.id, USER, { titel: 'Spät', figureIds: [anna] });
  const frueh = plot.createBeat(B, a1.id, USER, { titel: 'Früh', figureIds: [carl] });
  const geerbt = plot.createBeat(B, a1.id, USER, { titel: 'Lane', threadId: strang.id });
  // Direkt UND geerbt → zählt als direkt.
  const beides = plot.createBeat(B, a2.id, USER, { titel: 'Beides', threadId: strang.id, figureIds: [anna] });
  plot.createBeat(B, a1.id, USER, { titel: 'Weg', figureIds: [anna], verworfen: 1 });
  const fremdAkt = plot.createAct(B, OTHER, { name: 'F' });
  plot.createBeat(B, fremdAkt.id, OTHER, { titel: 'Fremd', figureIds: [anna] });

  const links = plot.plotEntityLinks(B, USER, 'figure');
  assert.deepEqual(links.fig_anna.map(b => [b.titel, b.inherited]),
    [['Lane', true], ['Spät', false], ['Beides', false]]);
  assert.deepEqual(links.fig_carl.map(b => b.id), [frueh.id]);
  assert.ok(!Object.values(links).flat().some(b => b.titel === 'Weg' || b.titel === 'Fremd'));
  assert.ok([spaet, geerbt, beides].every(b => links.fig_anna.some(x => x.id === b.id)));
});

test('plotEntityLinks location + scene: Brücke bzw. Verankerung, Score-Floor nur auf Szenen', () => {
  const B = freshBook();
  const hafen = seedOrt(B, 'loc_hafen', 'Hafen');
  const a = plot.createAct(B, USER, { name: 'A' });
  const b1 = plot.createBeat(B, a.id, USER, { titel: 'Ankunft', status: 'im_buch', locationIds: [hafen] });
  const b2 = plot.createBeat(B, a.id, USER, { titel: 'Abschied', status: 'im_buch' });
  const s1 = seedSzene(B, 'Am Kai');
  plot.replaceBeatOccurrences(b1.id, B, [{ kind: 'scene', sceneId: s1, score: 0.7, snippet: 'x', source: 'semantic' }]);
  plot.replaceBeatOccurrences(b2.id, B, [{ kind: 'scene', sceneId: s1, score: 0.3, snippet: 'y', source: 'semantic' }]);

  assert.deepEqual(plot.plotEntityLinks(B, USER, 'location').loc_hafen.map(b => b.titel), ['Ankunft']);
  assert.deepEqual(plot.plotEntityLinks(B, USER, 'scene')[String(s1)].map(b => b.titel), ['Ankunft', 'Abschied']);
  assert.deepEqual(plot.plotEntityLinks(B, USER, 'scene', { minScore: 0.5 })[String(s1)].map(b => b.titel), ['Ankunft']);
  assert.deepEqual(plot.plotEntityLinks(B, USER, 'quatsch'), {});
});

test('get_plot_board: Orte, Motive-Feld, Zeit, Spannung und ausgehende Kanten am Beat', () => {
  const B = freshBook();
  const hafen = seedOrt(B, 'loc_h', 'Hafen');
  const a = plot.createAct(B, USER, { name: 'A' });
  const setup = plot.createBeat(B, a.id, USER, { titel: 'Gewehr an der Wand', intensitaet: 2, zeit: 'Sommer 1987', locationIds: [hafen] });
  const payoff = plot.createBeat(B, a.id, USER, { titel: 'Schuss' });
  plot.createBeatRelation(B, USER, { fromBeatId: setup.id, toBeatId: payoff.id, typ: 'bereitet-vor' });

  const res = tool_get_plot_board({}, { bookId: B, userEmail: USER });
  const [s, p] = res.acts[0].beats;
  assert.equal(s.intensitaet, 2);
  assert.equal(s.zeit, 'Sommer 1987');
  assert.deepEqual(s.orte, ['Hafen']);
  assert.deepEqual(s.beziehungen, [{ typ: 'bereitet-vor', zu_beat_id: payoff.id, zu: 'Schuss' }]);
  // Leere optionale Felder bleiben weg (kompakter Snapshot).
  for (const k of ['intensitaet', 'zeit', 'orte', 'motive', 'beziehungen']) assert.equal(k in p, false, k);
  assert.match(res.felder_legende, /zahlt-ein/);
});

test('loadChapterPlanContext: eigenes oder vom Strang geerbtes Kapitel, Ist nur nach Verankerung', () => {
  const B = freshBook();
  const k1 = seedKapitel(B, 'Eins');
  const k2 = seedKapitel(B, 'Zwei');
  const a = plot.createAct(B, USER, { name: 'A' });
  const strang = plot.createThread(B, USER, { name: 'S', chapterId: k1 });
  plot.createBeat(B, a.id, USER, { titel: 'Eigen', chapterId: k1, status: 'im_buch' });
  plot.createBeat(B, a.id, USER, { titel: 'Geerbt', threadId: strang.id });
  plot.createBeat(B, a.id, USER, { titel: 'Anderes Kapitel', chapterId: k2 });
  plot.createBeat(B, a.id, USER, { titel: 'Verworfen', chapterId: k1, verworfen: 1 });

  const ctx = loadChapterPlanContext(B, USER, [k1]);
  assert.deepEqual(ctx.beats.map(b => b.titel).sort(), ['Eigen', 'Geerbt']);
  assert.equal(ctx.verankert, false);
  assert.ok(ctx.beats.every(b => b.im_text === null));
  assert.equal(loadChapterPlanContext(B, OTHER, [k1]), null);
  assert.equal(loadChapterPlanContext(B, USER, []), null);
});

test('Plan-Block: Rahmung Soll statt Wahrheit, unbekanntes Ist, Achse aus dem Profil', () => {
  const axes = chapterReviewAxes(null);
  assert.equal(_planAchse(axes), 'dramaturgie');
  assert.equal(_planAchse(chapterReviewAxes('sachbuch')), 'kohaerenz');
  assert.equal(_buildPlanContextBlock(null), '');
  const ctx = { gesamt: 3, verankert: false, beats: [
    { titel: 'Verrat', beschreibung: 'Carl verrät Anna', status: 'im_buch', akt: 'A1', strang: null, figuren: ['Carl', 'Anna'], orte: ['Hafen'], intensitaet: 4, im_text: null },
  ] };
  const block = _buildPlanContextBlock(ctx, { achse: 'dramaturgie' });
  assert.match(block, /KEINE Textwahrheit/);
  assert.match(block, /KEIN Fehler/);
  assert.match(block, /UNBEKANNT/);
  assert.match(block, /«Verrat» \[Akt: A1\] – Carl verrät Anna/);
  assert.match(block, /2 weitere Beats/);
  assert.doesNotMatch(block, /wiedergefunden: /);
  const mitIst = _buildPlanContextBlock({ ...ctx, verankert: true, beats: [{ ...ctx.beats[0], im_text: 0 }] }, { achse: 'dramaturgie' });
  assert.match(mitIst, /im Text wiedergefunden: 0×/);
  assert.match(mitIst, /nicht "fehlt sicher"/);

  const prompt = buildChapterReviewPrompt('K', 'B', 1, 'Text', { planContext: ctx });
  assert.match(prompt, /GEPLANTE HANDLUNG/);
  assert.doesNotMatch(buildChapterReviewPrompt('K', 'B', 1, 'Text', {}), /GEPLANTE HANDLUNG/);
});
