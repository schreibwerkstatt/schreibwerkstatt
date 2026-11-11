// Plot-Werkstatt, Struktur-Integrität im DB-Layer: Reorder-Validierung (alles
// oder nichts), Hybrid-Invariante actFitsThread, lückenlose Nummerierung nach
// Delete/Zellwechsel/Strang-Löschung, Akt-Reorder-Scope, Stale-Heuristik der
// Beat-Verankerung, Score-Wahl des Anchor-Jobs (semScore statt RRF).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('plot-integrity');

const schema = require('../../db/schema');
const appUsers = require('../../db/app-users');
const plot = require('../../db/plot');
const { db } = require('../../db/connection');

const USER = 'integ@x.test';
const OTHER = 'fremd@x.test';
const BOOK = 771001;
let bookSeq = 771100;

appUsers.createUser({ email: USER, displayName: 'Integ' });
appUsers.createUser({ email: OTHER, displayName: 'Fremd' });
schema.upsertBookByName(BOOK, 'Integritäts-Buch');

// Jeder Test bekommt ein eigenes Buch — keine Kopplung über Positionen.
function freshBook() {
  const id = ++bookSeq;
  schema.upsertBookByName(id, `Buch ${id}`);
  return id;
}
const orders = (bookId, actId, threadId = null) => db.prepare(
  'SELECT id, sort_order FROM plot_beats WHERE book_id = ? AND act_id = ? AND thread_id IS ? ORDER BY sort_order, id'
).all(bookId, actId, threadId);
const seq = rows => rows.map(r => r.sort_order);
const throwsCode = (fn, code) => assert.throws(fn, e => e.code === code, `erwartet ${code}`);

test('reorderBeats: ungültiger Payload wirft ORDER_INVALID und schreibt nichts', () => {
  const B = freshBook();
  const a = plot.createAct(B, USER, { name: 'A' });
  const b1 = plot.createBeat(B, a.id, USER, { titel: '1' });
  const b2 = plot.createBeat(B, a.id, USER, { titel: '2' });
  const before = orders(B, a.id);
  throwsCode(() => plot.reorderBeats(B, USER, [null]), 'ORDER_INVALID');
  throwsCode(() => plot.reorderBeats(B, USER, [{ actId: 'x', beatIds: [] }]), 'ORDER_INVALID');
  throwsCode(() => plot.reorderBeats(B, USER, [{ actId: a.id, beatIds: 'nope' }]), 'ORDER_INVALID');
  throwsCode(() => plot.reorderBeats(B, USER, [{ actId: a.id, beatIds: [b2.id, 'zwei'] }]), 'ORDER_INVALID');
  throwsCode(() => plot.reorderBeats(B, USER, [{ actId: a.id, beatIds: [b2.id, b2.id] }]), 'ORDER_INVALID');
  throwsCode(() => plot.reorderBeats(B, USER, [{ actId: a.id, threadId: 999999, beatIds: [b2.id] }]), 'ORDER_INVALID');
  assert.deepEqual(orders(B, a.id), before);
  assert.deepEqual(before.map(r => r.id), [b1.id, b2.id]);
});

test('reorderBeats: fremder Akt / fremder Beat → Abbruch der ganzen Transaktion', () => {
  const B = freshBook();
  const a1 = plot.createAct(B, USER, { name: 'A1' });
  const a2 = plot.createAct(B, USER, { name: 'A2' });
  const foreignAct = plot.createAct(B, OTHER, { name: 'Fremd' });
  const b1 = plot.createBeat(B, a1.id, USER, { titel: '1' });
  const fb = plot.createBeat(B, foreignAct.id, OTHER, { titel: 'fremd' });
  // Erste Gruppe gültig, zweite verletzt → auch die erste darf nicht geschrieben sein.
  throwsCode(() => plot.reorderBeats(B, USER, [
    { actId: a2.id, beatIds: [b1.id] },
    { actId: foreignAct.id, beatIds: [] },
  ]), 'ACT_MISMATCH');
  assert.equal(plot.getBeat(b1.id).act_id, a1.id);
  throwsCode(() => plot.reorderBeats(B, USER, [{ actId: a2.id, beatIds: [b1.id, fb.id] }]), 'ORDER_INVALID');
  assert.equal(plot.getBeat(b1.id).act_id, a1.id);
  assert.equal(plot.getBeat(fb.id).act_id, foreignAct.id);
});

test('actFitsThread: geforkter Strang nur auf eigenen Akten, sonst nur geteilte', () => {
  const B = freshBook();
  const shared = plot.createAct(B, USER, { name: 'Geteilt' });
  const tA = plot.createThread(B, USER, { name: 'A' });
  const tB = plot.createThread(B, USER, { name: 'B' });
  // Ohne Fork: Strang + „ohne Strang" auf geteilten Akten.
  assert.equal(plot.actFitsThread(shared, tA.id), true);
  assert.equal(plot.actFitsThread(shared, null), true);
  plot.forkThreadActs(B, USER, tA.id);
  const ownA = plot.listActs(B, USER).find(a => a.thread_id === tA.id);
  // Geforkt: nur eigene Akte; der geteilte Akt passt nicht mehr.
  assert.equal(plot.actFitsThread(ownA, tA.id), true);
  assert.equal(plot.actFitsThread(shared, tA.id), false);
  // Fremder Strang / „ohne Strang" nie auf A's eigenem Akt.
  assert.equal(plot.actFitsThread(ownA, tB.id), false);
  assert.equal(plot.actFitsThread(ownA, null), false);
  assert.equal(plot.actFitsThread(shared, tB.id), true);
});

test('reorderBeats: ACT_THREAD_MISMATCH für unpassendes Paar, leere Quellgruppe ohne Prüfung', () => {
  const B = freshBook();
  const shared = plot.createAct(B, USER, { name: 'Geteilt' });
  const t = plot.createThread(B, USER, { name: 'T' });
  const b = plot.createBeat(B, shared.id, USER, { titel: 'x', threadId: t.id });
  plot.forkThreadActs(B, USER, t.id);
  const own = plot.listActs(B, USER).find(a => a.thread_id === t.id);
  assert.equal(plot.getBeat(b.id).act_id, own.id);
  // In die „ohne Strang"-Lane auf einem eigenen Akt → verboten.
  throwsCode(() => plot.reorderBeats(B, USER, [{ actId: own.id, threadId: null, beatIds: [b.id] }]), 'ACT_THREAD_MISMATCH');
  // Strang-Beat zurück auf den geteilten Akt (Strang ist geforkt) → verboten.
  throwsCode(() => plot.reorderBeats(B, USER, [{ actId: shared.id, threadId: t.id, beatIds: [b.id] }]), 'ACT_THREAD_MISMATCH');
  // Leere Quellgruppe auf einer sonst unpassenden Zelle bewegt nichts → zulässig.
  plot.reorderBeats(B, USER, [
    { actId: shared.id, threadId: t.id, beatIds: [] },
    { actId: own.id, threadId: t.id, beatIds: [b.id] },
  ]);
  assert.equal(plot.getBeat(b.id).act_id, own.id);
});

test('reorderBeats: Ziel- und Quellzelle lückenlos, auch ohne mitgeschickte Quellzelle', () => {
  const B = freshBook();
  const a1 = plot.createAct(B, USER, { name: 'A1' });
  const a2 = plot.createAct(B, USER, { name: 'A2' });
  const x1 = plot.createBeat(B, a1.id, USER, { titel: 'x1' });
  const x2 = plot.createBeat(B, a1.id, USER, { titel: 'x2' });
  const x3 = plot.createBeat(B, a1.id, USER, { titel: 'x3' });
  const y1 = plot.createBeat(B, a2.id, USER, { titel: 'y1' });
  // Nur die Zielgruppe, und die nennt y1 nicht: x2 zuerst, y1 rückt dahinter.
  plot.reorderBeats(B, USER, [{ actId: a2.id, beatIds: [x2.id] }]);
  assert.deepEqual(orders(B, a2.id).map(r => r.id), [x2.id, y1.id]);
  assert.deepEqual(seq(orders(B, a2.id)), [0, 1]);
  assert.deepEqual(orders(B, a1.id).map(r => r.id), [x1.id, x3.id]);
  assert.deepEqual(seq(orders(B, a1.id)), [0, 1]);
});

test('Lückenlos: deleteBeat und PATCH-Zellwechsel (Beat ans Zielzellen-Ende)', () => {
  const B = freshBook();
  const a1 = plot.createAct(B, USER, { name: 'A1' });
  const a2 = plot.createAct(B, USER, { name: 'A2' });
  const p = plot.createBeat(B, a1.id, USER, { titel: 'p' });
  const q = plot.createBeat(B, a1.id, USER, { titel: 'q' });
  const r = plot.createBeat(B, a1.id, USER, { titel: 'r' });
  const z = plot.createBeat(B, a2.id, USER, { titel: 'z' });
  plot.deleteBeat(p.id);
  assert.deepEqual(seq(orders(B, a1.id)), [0, 1]);
  const moved = plot.updateBeat(q.id, { act_id: a2.id });
  assert.equal(moved.act_id, a2.id);
  assert.deepEqual(orders(B, a2.id).map(x => x.id), [z.id, q.id]);
  assert.deepEqual(seq(orders(B, a2.id)), [0, 1]);
  assert.deepEqual(orders(B, a1.id).map(x => x.id), [r.id]);
  assert.deepEqual(seq(orders(B, a1.id)), [0]);
});

test('Lückenlos: deleteThread hängt Strang-Beats hinter die „ohne Strang"-Beats', () => {
  const B = freshBook();
  const a = plot.createAct(B, USER, { name: 'A' });
  const t = plot.createThread(B, USER, { name: 'T' });
  const n1 = plot.createBeat(B, a.id, USER, { titel: 'n1' });
  const n2 = plot.createBeat(B, a.id, USER, { titel: 'n2' });
  const s1 = plot.createBeat(B, a.id, USER, { titel: 's1', threadId: t.id });
  const s2 = plot.createBeat(B, a.id, USER, { titel: 's2', threadId: t.id });
  plot.deleteThread(t.id);
  assert.deepEqual(orders(B, a.id).map(x => x.id), [n1.id, n2.id, s1.id, s2.id]);
  assert.deepEqual(seq(orders(B, a.id)), [0, 1, 2, 3]);
});

test('Lückenlos: deleteThread eines geforkten Strangs (eigene Akte → geteilte)', () => {
  const B = freshBook();
  const a1 = plot.createAct(B, USER, { name: 'A1' });
  const t = plot.createThread(B, USER, { name: 'T' });
  const n = plot.createBeat(B, a1.id, USER, { titel: 'n' });
  const s = plot.createBeat(B, a1.id, USER, { titel: 's', threadId: t.id });
  plot.forkThreadActs(B, USER, t.id);
  plot.deleteThread(t.id);
  assert.equal(plot.getBeat(s.id).act_id, a1.id);
  assert.deepEqual(orders(B, a1.id).map(x => x.id), [n.id, s.id]);
  assert.deepEqual(seq(orders(B, a1.id)), [0, 1]);
});

test('Akte: deleteAct nummeriert den Scope neu; reorderActs prüft Besitz + Scope', () => {
  const B = freshBook();
  const a = plot.createAct(B, USER, { name: 'a' });
  const b = plot.createAct(B, USER, { name: 'b' });
  const c = plot.createAct(B, USER, { name: 'c' });
  plot.deleteAct(a.id);
  assert.deepEqual(plot.listActs(B, USER).map(x => [x.name, x.position]), [['b', 0], ['c', 1]]);

  const t = plot.createThread(B, USER, { name: 'T' });
  plot.forkThreadActs(B, USER, t.id);
  const own = plot.listActs(B, USER).filter(x => x.thread_id === t.id);
  throwsCode(() => plot.reorderActs(B, USER, [c.id, own[0].id]), 'ACT_SCOPE_MIXED');
  const foreign = plot.createAct(B, OTHER, { name: 'fremd' });
  throwsCode(() => plot.reorderActs(B, USER, [c.id, foreign.id]), 'ACT_MISMATCH');
  throwsCode(() => plot.reorderActs(B, USER, [c.id, 'x']), 'ORDER_INVALID');
  // Nichts geschrieben.
  assert.deepEqual(plot.listActs(B, USER).filter(x => x.thread_id == null).map(x => x.name), ['b', 'c']);
  // Teil-Liste: genannter Akt zuerst, der Rest lückenlos dahinter.
  plot.reorderActs(B, USER, [c.id]);
  assert.deepEqual(plot.listActs(B, USER).filter(x => x.thread_id == null).map(x => [x.name, x.position]), [['c', 0], ['b', 1]]);
});

// ── Stale-Heuristik ───────────────────────────────────────────────────────────
function recordAnchorRun(bookId, userEmail, startedAt) {
  db.prepare(`INSERT INTO job_runs (job_id, type, book_id, user_email, status, queued_at, started_at, ended_at)
              VALUES (?, 'beat-anchor', ?, ?, 'done', ?, ?, ?)`)
    .run(`anchor-${bookId}-${Math.random()}`, bookId, userEmail, startedAt, startedAt, startedAt);
}
const iso = offsetMs => new Date(Date.now() + offsetMs).toISOString();

test('beatAnchorStale: Lauf mit 0 Fundstellen beendet „stale" (job_runs zählt)', () => {
  const B = freshBook();
  const a = plot.createAct(B, USER, { name: 'A' });
  plot.createBeat(B, a.id, USER, { titel: 'im Buch', status: 'im_buch' });
  assert.equal(plot.beatAnchorStale(B, USER), true, 'nie gelaufen');
  recordAnchorRun(B, USER, iso(+1000));
  assert.equal(plot.beatAnchorStale(B, USER), false, 'Lauf ohne Treffer zählt als gelaufen');
});

test('beatAnchorStale: nur Inhalts-Änderungen machen stale, nicht DnD/Kapitel/Intensität', () => {
  const B = freshBook();
  const a1 = plot.createAct(B, USER, { name: 'A1' });
  const a2 = plot.createAct(B, USER, { name: 'A2' });
  const b = plot.createBeat(B, a1.id, USER, { titel: 'T', status: 'im_buch' });
  recordAnchorRun(B, USER, iso(+1000));
  // Positions-/Meta-Änderungen in der „Zukunft" relativ zum Lauf simulieren: wir
  // setzen den Lauf in die Zukunft und vergleichen nur content_updated_at.
  plot.reorderBeats(B, USER, [{ actId: a2.id, beatIds: [b.id] }]);
  plot.updateBeat(b.id, { intensitaet: 4, zeit: '1990' });
  plot.updateBeat(b.id, { titel: 'T' }); // gleicher Wert → keine Inhaltsänderung
  assert.equal(plot.beatAnchorStale(B, USER), false);
  // Lauf in die Vergangenheit legen → jetzt zählt der Inhaltszeitstempel.
  db.prepare("UPDATE job_runs SET started_at = ? WHERE book_id = ?").run(iso(-60000), B);
  db.prepare('UPDATE plot_beats SET content_updated_at = ? WHERE id = ?').run(iso(-120000), b.id);
  plot.reorderBeats(B, USER, [{ actId: a1.id, beatIds: [b.id] }]);
  plot.updateBeat(b.id, { intensitaet: 2 });
  assert.equal(plot.beatAnchorStale(B, USER), false, 'DnD + Intensität nach dem Lauf: nicht stale');
  plot.updateBeat(b.id, { beschreibung: 'neu' });
  assert.equal(plot.beatAnchorStale(B, USER), true, 'Beschreibung nach dem Lauf: stale');
});

test('beatAnchorStale: geplanter Beat zählt nur mit Promotion-Status-Set', () => {
  const B = freshBook();
  const a = plot.createAct(B, USER, { name: 'A' });
  plot.createBeat(B, a.id, USER, { titel: 'geplant' });
  assert.equal(plot.beatAnchorStale(B, USER, ['im_buch']), false);
  assert.equal(plot.beatAnchorStale(B, USER, ['im_buch', 'geplant']), true);
});

test('replaceBeatOccurrences: gelöschter Beat → false, kein FK-Fehler', () => {
  const B = freshBook();
  const a = plot.createAct(B, USER, { name: 'A' });
  const b = plot.createBeat(B, a.id, USER, { titel: 'weg', status: 'im_buch' });
  plot.deleteBeat(b.id);
  assert.equal(plot.replaceBeatOccurrences(b.id, B, [{ kind: 'page', pageId: 1, score: 0.5, snippet: 's', source: 'semantic' }]), false);
});

test('beatOccurrenceEntry: Einzel-Beat-Aggregat wie im Board (Score-Floor wirkt auf Cosinus)', () => {
  const B = freshBook();
  const a = plot.createAct(B, USER, { name: 'A' });
  const b = plot.createBeat(B, a.id, USER, { titel: 'x', status: 'im_buch' });
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name, updated_at) VALUES (?, ?, 'S1', '2026-01-01T00:00:00.000Z')`).run(B * 10, B);
  plot.replaceBeatOccurrences(b.id, B, [
    { kind: 'page', pageId: B * 10, score: 0.72, snippet: 'stark', source: 'semantic' },
  ]);
  assert.deepEqual(plot.beatOccurrenceEntry(b.id, { navigableOnly: true }).count, 1);
  assert.equal(plot.beatOccurrenceEntry(b.id, { minScore: 0.8 }).count, 0);
  assert.deepEqual(plot.beatOccurrenceEntry(999999), { count: 0, top: [] });
});

// ── Anchor-Job: Score-Wahl ────────────────────────────────────────────────────
test('_anchorBeat: speichert semScore (Cosinus), überspringt FTS-Fusions-Kandidaten, Floor auf Cosinus', async () => {
  const retrieval = require('../../lib/semantic-retrieval');
  const orig = retrieval.semanticQuery;
  // Hybrid-Form: score = RRF (~0.03), semScore = Cosinus bzw. null.
  retrieval.semanticQuery = async () => ([
    { kind: 'page', entity_id: 11, text: 'stark', score: 0.032, semScore: 0.71 },
    { kind: 'page', entity_id: 12, text: 'schwach', score: 0.031, semScore: 0.30 },
    { kind: 'scene', entity_id: 13, text: 'nur FTS', score: 0.03, semScore: null },
  ]);
  try {
    delete require.cache[require.resolve('../../routes/jobs/beat-anchor')];
    const { _anchorBeat } = require('../../routes/jobs/beat-anchor');
    const beat = { id: 1, titel: 'Titel', beschreibung: 'Text', status: 'im_buch' };
    const all = await _anchorBeat(1, beat, true, () => undefined, 0, { promote: false });
    assert.deepEqual(all.map(r => [r.pageId ?? r.sceneId, r.score]), [[11, 0.71], [12, 0.30]]);
    const floored = await _anchorBeat(1, beat, true, () => undefined, 0.45, { promote: false });
    assert.deepEqual(floored.map(r => r.pageId), [11]);
    // Mit RRF-Score hätte der 0.45-Floor ALLES verworfen — genau der behobene Fehler.
    assert.ok(floored.every(r => r.score > 0.45));
  } finally {
    retrieval.semanticQuery = orig;
    delete require.cache[require.resolve('../../routes/jobs/beat-anchor')];
  }
});

// ── Anchor-Job: Figuren-Scope + Rerank-Tor ────────────────────────────────────
test('listBeatsForAnchor: figure_ids = geerbte Strang-Hauptfigur + verlinkte Figuren', () => {
  const B = freshBook();
  const now = new Date().toISOString();
  const ins = db.prepare('INSERT INTO figures (book_id, fig_id, name, updated_at, user_email) VALUES (?, ?, ?, ?, ?)');
  const stefan = Number(ins.run(B, 'fs', 'Stefan', now, USER).lastInsertRowid);
  const renate = Number(ins.run(B, 'fr', 'Renate', now, USER).lastInsertRowid);
  const t = plot.createThread(B, USER, { name: 'Stefan', figureId: stefan });
  const a = plot.createAct(B, USER, { name: 'A' });
  const b1 = plot.createBeat(B, a.id, USER, { titel: 'Im Strang', threadId: t.id, figureIds: [renate] });
  const b2 = plot.createBeat(B, a.id, USER, { titel: 'Ohne Strang' });
  const rows = new Map(plot.listBeatsForAnchor(B, USER).map(r => [r.id, r]));
  assert.deepEqual([...rows.get(b1.id).figure_ids].sort(), [stefan, renate].sort());
  assert.deepEqual(rows.get(b2.id).figure_ids, []);
  // Figuren ohne Eintrag in einem Erwähnungs-Index → kein Scope (nicht «nirgends»).
  assert.equal(plot.anchorFigureScope([stefan]), null);
  assert.equal(plot.anchorFigureScope([]), null);
});

test('_anchorBeat: restrictTo geht an die Suche, Treffer ausserhalb des Figuren-Scopes fallen weg', async () => {
  const retrieval = require('../../lib/semantic-retrieval');
  const orig = retrieval.semanticQuery;
  let seen = null;
  retrieval.semanticQuery = async (_b, _q, opts) => {
    seen = opts.restrictTo;
    return [
      { kind: 'page', entity_id: 11, text: 'mit Figur', semScore: 0.6, rerankScore: 0.9 },
      { kind: 'page', entity_id: 99, text: 'andere Figur', semScore: 0.7, rerankScore: 0.9 },
      { kind: 'scene', entity_id: 5, text: 'Szene mit Figur', semScore: 0.6, rerankScore: 0.9 },
    ];
  };
  try {
    delete require.cache[require.resolve('../../routes/jobs/beat-anchor')];
    const { _anchorBeat } = require('../../routes/jobs/beat-anchor');
    const beat = { id: 1, titel: 'Banklehre', beschreibung: '', status: 'im_buch' };
    const restrictTo = { page: [11], scene: [5] };
    const rows = await _anchorBeat(1, beat, true, () => undefined, 0.45, { promote: false, restrictTo });
    assert.deepEqual(seen, restrictTo);
    assert.deepEqual(rows.map(r => r.pageId ?? r.sceneId).sort(), [11, 5].sort());
  } finally {
    retrieval.semanticQuery = orig;
    delete require.cache[require.resolve('../../routes/jobs/beat-anchor')];
  }
});

test('_anchorBeat: Promotion braucht zusätzlich den Rerank-Wert; ohne Rerank-Wert gilt das Cosinus-Tor', async () => {
  const retrieval = require('../../lib/semantic-retrieval');
  const orig = retrieval.semanticQuery;
  retrieval.semanticQuery = async () => ([
    { kind: 'page', entity_id: 1, text: 'gleiches Thema', semScore: 0.66, rerankScore: 0.69 },
    { kind: 'page', entity_id: 2, text: 'das Ereignis', semScore: 0.60, rerankScore: 0.75 },
    { kind: 'page', entity_id: 3, text: 'Reranker aus', semScore: 0.58, rerankScore: null },
  ]);
  try {
    delete require.cache[require.resolve('../../routes/jobs/beat-anchor')];
    const { _anchorBeat } = require('../../routes/jobs/beat-anchor');
    const beat = { id: 1, titel: 'Renate scheidet sich', beschreibung: '', status: 'geplant' };
    const promo = await _anchorBeat(1, beat, true, () => undefined, 0.55, { promote: true, rerankFloor: 0.7 });
    assert.deepEqual(promo.map(r => r.pageId), [2, 3]);
    // Bestätigung (im_buch) kennt kein Rerank-Tor — echte Belege liegen dort auch bei 0.01–0.05.
    const confirm = await _anchorBeat(1, { ...beat, status: 'im_buch' }, true, () => undefined, 0.45, { promote: false, rerankFloor: 0.7 });
    assert.deepEqual(confirm.map(r => r.pageId), [1, 2, 3]);
  } finally {
    retrieval.semanticQuery = orig;
    delete require.cache[require.resolve('../../routes/jobs/beat-anchor')];
  }
});
