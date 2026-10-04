'use strict';
// db/ideen.js gegen das ECHTE migrierte Schema (Wegwerf-DB), nicht gegen ein
// hier nachgebautes DDL: die Aussagen dieses Tests haengen am CHECK, an den
// FK-Kanten und an den partiellen UNIQUE-Indexen — ein nachgebautes Schema
// wuerde genau die Stellen nicht pruefen, an denen es schiefgehen kann.
//
// Zwei Invarianten stehen im Mittelpunkt:
//   * Die Rueckwaerts-Lesung ist USER-SKOPIERT. `research_items` ist buchweit
//     GETEILT, `ideen` nicht — ohne den Filter zeigte die Recherche-Karte dem
//     einen Mitarbeiter die privaten Pendenzen des anderen. Das ist die
//     Sicherheitsaussage des Features.
//   * Eine Verknuepfung bleibt IM BUCH. Der FK allein liesse eine Idee aus Buch
//     A auf ein Motiv aus Buch B zeigen.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { useTmpDb } = require('./_helpers/tmp-db');
const tmpDb = useTmpDb('ideen-db');

require('../../db/migrations');
const { db } = require('../../db/connection');
const ideenDb = require('../../db/ideen');

const A = 'a@x.de';
const B = 'b@x.de';

function seed() {
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of ['idea_links', 'ideen', 'motifs', 'plot_beats', 'plot_acts', 'research_items', 'pages', 'chapters', 'books', 'app_users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.exec('PRAGMA foreign_keys = ON');
  const now = new Date().toISOString();
  for (const e of [A, B]) {
    db.prepare('INSERT INTO app_users (email, display_name, created_at) VALUES (?,?,?)').run(e, e, now);
  }
  db.prepare('INSERT INTO books (book_id, name, owner_email, created_at, updated_at) VALUES (1, ?, ?, ?, ?)').run('Buch 1', A, now, now);
  db.prepare('INSERT INTO books (book_id, name, owner_email, created_at, updated_at) VALUES (2, ?, ?, ?, ?)').run('Buch 2', A, now, now);
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position) VALUES (5, 1, ?, 0)').run('Kapitel 1');
  db.prepare('INSERT INTO pages (page_id, book_id, chapter_id, page_name, position) VALUES (10, 1, 5, ?, 0)').run('Seite A');
  db.prepare('INSERT INTO pages (page_id, book_id, chapter_id, page_name, position) VALUES (11, 1, NULL, ?, 1)').run('Solo');
  db.prepare("INSERT INTO research_items (id, book_id, user_email, kind, title) VALUES (100, 1, ?, 'note', ?)").run(A, 'Fundstueck');
  db.prepare("INSERT INTO research_items (id, book_id, user_email, kind, title) VALUES (101, 2, ?, 'note', ?)").run(A, 'Fremdes Fundstueck');
  db.prepare("INSERT INTO plot_acts (id, book_id, user_email, name, position) VALUES (200, 1, ?, 'Akt 1', 0)").run(A);
  db.prepare("INSERT INTO plot_beats (id, book_id, act_id, user_email, titel) VALUES (300, 1, 200, ?, 'Beat')").run(A);
  db.prepare("INSERT INTO motifs (id, book_id, user_email, name) VALUES (400, 1, ?, 'Wasser')").run(A);
}

function mkIdee(over = {}) {
  return ideenDb.createIdee({
    bookId: 1, pageId: null, chapterId: null, userEmail: A, content: 'Pendenz', ...over,
  });
}

test('ideen: Anlegen startet auf `offen`, Namen kommen per JOIN', () => {
  seed();
  const row = ideenDb.getIdee(mkIdee({ pageId: 10 }));
  assert.equal(row.status, 'offen');
  assert.equal(row.status_at, null);
  assert.equal(row.page_name, 'Seite A');
  assert.equal(row.chapter_name, null);       // Anker ist die Seite, nicht das Kapitel
  assert.deepEqual(row.links, []);
});

test('ideen: Status setzen stempelt status_at, Content-Update nicht', () => {
  seed();
  const id = mkIdee({ pageId: 10 });
  ideenDb.updateIdee(id, A, { status: 'in_arbeit' });
  const after = ideenDb.getIdee(id);
  assert.equal(after.status, 'in_arbeit');
  assert.ok(after.status_at, 'status_at muss beim Stufenwechsel gesetzt werden');

  ideenDb.updateIdee(id, A, { content: 'Neuer Text' });
  const again = ideenDb.getIdee(id);
  assert.equal(again.content, 'Neuer Text');
  assert.equal(again.status_at, after.status_at, 'Content-Update darf status_at nicht bewegen');
});

test('ideen: ein ungueltiger Status kommt nicht durch den CHECK', () => {
  seed();
  const id = mkIdee({ pageId: 10 });
  assert.throws(() => ideenDb.updateIdee(id, A, { status: 'quatsch' }), /CHECK constraint failed/);
});

test('Zaehler: `verworfen` zaehlt NICHT als offen', () => {
  seed();
  ideenDb.updateIdee(mkIdee({ pageId: 10 }), A, { status: 'verworfen' });
  ideenDb.updateIdee(mkIdee({ pageId: 10 }), A, { status: 'erledigt' });
  const inArbeit = mkIdee({ pageId: 10 });
  ideenDb.updateIdee(inArbeit, A, { status: 'in_arbeit' });
  mkIdee({ chapterId: 5 });

  assert.deepEqual(ideenDb.openIdeenCounts(1, A, 'page'), { 10: 1 });
  assert.deepEqual(ideenDb.openIdeenCounts(1, A, 'chapter'), { 5: 1 });
});

test('Board: lane_chapter_id ist bei einer Seiten-Idee das Kapitel IHRER Seite', () => {
  seed();
  mkIdee({ pageId: 10 });     // Seite in Kapitel 5
  mkIdee({ pageId: 11 });     // Solo-Seite, kein Kapitel
  mkIdee({ chapterId: 5 });   // direkt am Kapitel

  const rows = ideenDb.listBoardIdeen(1, A);
  const byAnchor = Object.fromEntries(rows.map(r => [r.page_id != null ? `p${r.page_id}` : `c${r.chapter_id}`, r]));
  assert.equal(byAnchor.p10.lane_chapter_id, 5);
  assert.equal(byAnchor.p10.lane_chapter_name, 'Kapitel 1');
  assert.equal(byAnchor.p11.lane_chapter_id, null);
  assert.equal(byAnchor.c5.lane_chapter_id, 5);
  assert.equal(byAnchor.c5.lane_chapter_name, 'Kapitel 1');
});

test('Board: liefert nur die Ideen des anfragenden Users', () => {
  seed();
  mkIdee({ pageId: 10 });
  ideenDb.createIdee({ bookId: 1, pageId: 10, chapterId: null, userEmail: B, content: 'Fremd' });
  assert.equal(ideenDb.listBoardIdeen(1, A).length, 1);
  assert.equal(ideenDb.listBoardIdeen(1, B).length, 1);
  assert.equal(ideenDb.listBoardIdeen(1, A)[0].content, 'Pendenz');
});

test('Verknuepfung: alle drei Ziel-Arten, Label per JOIN', () => {
  seed();
  const id = mkIdee({ pageId: 10 });
  assert.deepEqual(ideenDb.addIdeaLink(id, 1, 'research', 100), { ok: true });
  assert.deepEqual(ideenDb.addIdeaLink(id, 1, 'beat', 300), { ok: true });
  assert.deepEqual(ideenDb.addIdeaLink(id, 1, 'motif', 400), { ok: true });

  const links = ideenDb.getIdee(id).links;
  assert.deepEqual(links.map(l => l.target_kind).sort(), ['beat', 'motif', 'research']);
  assert.equal(links.find(l => l.target_kind === 'motif').label, 'Wasser');

  // Label ist kein Snapshot: umbenannt heisst es sofort ueberall neu.
  db.prepare('UPDATE motifs SET name = ? WHERE id = 400').run('Feuer');
  assert.equal(ideenDb.getIdee(id).links.find(l => l.target_kind === 'motif').label, 'Feuer');
});

test('Verknuepfung: ein Ziel aus einem anderen Buch wird abgelehnt', () => {
  seed();
  const id = mkIdee({ pageId: 10 });
  assert.deepEqual(ideenDb.addIdeaLink(id, 1, 'research', 101), { error_code: 'BOOK_MISMATCH' });
  assert.deepEqual(ideenDb.addIdeaLink(id, 1, 'research', 999), { error_code: 'LINK_TARGET_NOT_FOUND' });
  assert.deepEqual(ideenDb.addIdeaLink(id, 1, 'unsinn', 100), { error_code: 'INVALID_LINK_KIND' });
  assert.deepEqual(ideenDb.getIdee(id).links, []);
});

test('Verknuepfung: dieselbe Kante nur einmal', () => {
  seed();
  const id = mkIdee({ pageId: 10 });
  ideenDb.addIdeaLink(id, 1, 'beat', 300);
  ideenDb.addIdeaLink(id, 1, 'beat', 300);
  assert.equal(ideenDb.getIdee(id).links.length, 1);
});

test('Verknuepfung: eine fremde link_id trifft nichts', () => {
  seed();
  const mine = mkIdee({ pageId: 10 });
  const other = mkIdee({ pageId: 10 });
  ideenDb.addIdeaLink(mine, 1, 'beat', 300);
  const linkId = ideenDb.getIdee(mine).links[0].link_id;
  assert.equal(ideenDb.removeIdeaLink(other, linkId), 0);
  assert.equal(ideenDb.getIdee(mine).links.length, 1);
  assert.equal(ideenDb.removeIdeaLink(mine, linkId), 1);
});

test('Rueckwaerts-Lesung: NUR die eigenen Ideen — das geteilte Fundstueck leckt nicht', () => {
  seed();
  const mine = mkIdee({ pageId: 10 });
  const foreign = ideenDb.createIdee({ bookId: 1, pageId: 10, chapterId: null, userEmail: B, content: 'Fremde Pendenz' });
  ideenDb.addIdeaLink(mine, 1, 'research', 100);
  ideenDb.addIdeaLink(foreign, 1, 'research', 100);

  const forA = ideenDb.ideaLinksByTarget('research', 1, A).get(100);
  assert.equal(forA.length, 1);
  assert.equal(forA[0].content, 'Pendenz');
  assert.equal(forA[0].page_name, 'Seite A');

  const forB = ideenDb.ideaLinksByTarget('research', 1, B).get(100);
  assert.equal(forB.length, 1);
  assert.equal(forB[0].content, 'Fremde Pendenz');
});

test('Rueckwaerts-Lesung: attachIdeasTo setzt auf jeder Zeile ein Array, auch leer', () => {
  seed();
  const id = mkIdee({ pageId: 10 });
  ideenDb.addIdeaLink(id, 1, 'beat', 300);
  const rows = [{ id: 300 }, { id: 301 }];
  ideenDb.attachIdeasTo(rows, 'beat', 1, A);
  assert.equal(rows[0].ideas.length, 1);
  assert.deepEqual(rows[1].ideas, []);
});

test('Link-Ziele: verworfene Beats und archivierte Fundstuecke sind keine NEUEN Ziele', () => {
  seed();
  db.prepare('UPDATE plot_beats SET verworfen = 1 WHERE id = 300').run();
  db.prepare('UPDATE research_items SET archived = 1 WHERE id = 100').run();
  const targets = ideenDb.listIdeaLinkTargets(1, A);
  assert.deepEqual(targets.beat, []);
  assert.deepEqual(targets.research, []);
  assert.deepEqual(targets.motif.map(m => m.label), ['Wasser']);
});

test('Link-Ziele: Beats und Motive sind user-skopiert, Fundstuecke buchweit geteilt', () => {
  seed();
  assert.deepEqual(ideenDb.listIdeaLinkTargets(1, B).beat, []);
  assert.deepEqual(ideenDb.listIdeaLinkTargets(1, B).motif, []);
  assert.deepEqual(ideenDb.listIdeaLinkTargets(1, B).research.map(r => r.label), ['Fundstueck']);
});

test('Loeschen: die Idee nimmt ihre Kanten mit (CASCADE)', () => {
  seed();
  const id = mkIdee({ pageId: 10 });
  ideenDb.addIdeaLink(id, 1, 'beat', 300);
  ideenDb.deleteIdee(id, A);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM idea_links').get().n, 0);
});

test('Loeschen: das Ziel nimmt die Kante mit, die Idee bleibt', () => {
  seed();
  const id = mkIdee({ pageId: 10 });
  ideenDb.addIdeaLink(id, 1, 'motif', 400);
  db.prepare('DELETE FROM motifs WHERE id = 400').run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM idea_links').get().n, 0);
  assert.ok(ideenDb.getIdee(id), 'die Pendenz selbst darf nicht mit dem Motiv verschwinden');
});

test('Loeschen: die Seite nimmt ihre Ideen mit (CASCADE, kein CHECK-Bruch)', () => {
  seed();
  mkIdee({ pageId: 10 });
  db.prepare('DELETE FROM pages WHERE page_id = 10').run();
  assert.equal(ideenDb.listBoardIdeen(1, A).length, 0);
});


test('Buch-Idee: ohne Anker anlegbar, im Board ohne Bahn-Kapitel, in keinem Zaehler', () => {
  seed();
  const id = mkIdee();
  const row = ideenDb.getIdee(id);
  assert.equal(row.page_id, null);
  assert.equal(row.chapter_id, null);
  const board = ideenDb.listBoardIdeen(1, A);
  assert.equal(board.length, 1);
  assert.equal(board[0].lane_chapter_id, null);
  // Die Plaketten haengen an Seite/Kapitel — eine Buch-Idee setzt keine.
  assert.deepEqual(ideenDb.openIdeenCounts(1, A, 'page'), {});
  assert.deepEqual(ideenDb.openIdeenCounts(1, A, 'chapter'), {});
});

test('Buch-Idee: zuordnen auf Seite oder Kapitel setzt genau einen Anker', () => {
  seed();
  const a = mkIdee();
  const b = mkIdee();
  ideenDb.updateIdee(a, A, { page_id: 10 });
  ideenDb.updateIdee(b, A, { chapter_id: 5 });
  assert.equal(ideenDb.getIdee(a).page_name, 'Seite A');
  assert.equal(ideenDb.getIdee(a).chapter_id, null);
  assert.equal(ideenDb.getIdee(b).chapter_name, 'Kapitel 1');
  assert.equal(ideenDb.getIdee(b).page_id, null);
  // Beide Anker zugleich laesst der CHECK nicht zu.
  assert.throws(() => ideenDb.updateIdee(a, A, { chapter_id: 5 }), /CHECK constraint failed/);
});

test('Manuelle Reihenfolge: neu = 0, reorderIdeen schreibt 1..n', () => {
  seed();
  const a = mkIdee({ pageId: 10 });
  const b = mkIdee({ pageId: 10 });
  const c = mkIdee({ pageId: 10 });
  assert.equal(ideenDb.getIdee(a).sort_order, 0);
  assert.equal(ideenDb.reorderIdeen(1, A, [c, a, b]), true);
  const byId = new Map(ideenDb.listBoardIdeen(1, A).map(r => [r.id, r.sort_order]));
  assert.deepEqual([byId.get(c), byId.get(a), byId.get(b)], [1, 2, 3]);
});

test('Manuelle Reihenfolge: fremde oder buchfremde ID kippt alles', () => {
  seed();
  const a = mkIdee({ pageId: 10 });
  const fremd = mkIdee({ pageId: 10, userEmail: B });
  assert.equal(ideenDb.reorderIdeen(1, A, [fremd, a]), false);
  assert.equal(ideenDb.getIdee(a).sort_order, 0);
  assert.equal(ideenDb.getIdee(fremd).sort_order, 0);
  assert.equal(ideenDb.reorderIdeen(2, A, [a]), false);
  assert.equal(ideenDb.getIdee(a).sort_order, 0);
});
