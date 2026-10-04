// Ideen-Chat: Vorschlags-Werkzeuge (routes/jobs/ideen-chat-tools.js) + Kontext
// (routes/jobs/ideen-chat-context.js) gegen eine Wegwerf-DB.
//  - propose_* validieren gegen den Ideen-Stand und sammeln in ctx.proposals,
//    schreiben aber NICHTS (der User übernimmt jeden Vorschlag einzeln).
//  - «erledigt» braucht einen Beleg, und der Beleg muss wörtlich im Abschnitt stehen.
//  - Anker-, Stufen- und Buch-Regeln spiegeln routes/ideen.js.
//  - Fremde Ideen (anderer User) sind unsichtbar.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('ideen-chat-tools');

const schema = require('../../db/schema');
const appUsers = require('../../db/app-users');
const ideenDb = require('../../db/ideen');
const plot = require('../../db/plot');
const { setBookIdeenStages } = require('../../db/book-settings');
const { db } = require('../../db/connection');
const { loadOrderedBookContents } = require('../../routes/jobs/shared');
const { executeIdeenChatTool, MAX_PROPOSALS } = require('../../routes/jobs/ideen-chat-tools');
const { collectClassicProposals } = require('../../routes/jobs/ideen-chat-classic');
const {
  loadIdeenState, ideenOutline, gliederungOutline, targetsOutline, sessionIdeenProposalMemory,
} = require('../../routes/jobs/ideen-chat-context');

const USER = 'ideenchat@x.test';
const OTHER = 'fremd@x.test';
const BOOK = 770201;
const OTHER_BOOK = 770202;

appUsers.createUser({ email: USER, displayName: 'Ideen Chat' });
appUsers.createUser({ email: OTHER, displayName: 'Fremd' });
schema.upsertBookByName(BOOK, 'Ideen-Chat-Testbuch');
schema.upsertBookByName(OTHER_BOOK, 'Anderes Buch');

const NOW = '2026-01-01T00:00:00.000Z';
const ch1 = db.prepare('INSERT INTO chapters (book_id, chapter_name) VALUES (?, ?)').run(BOOK, 'Aufbruch').lastInsertRowid;
const ch2 = db.prepare('INSERT INTO chapters (book_id, chapter_name) VALUES (?, ?)').run(BOOK, 'Heimkehr').lastInsertRowid;
const chForeign = db.prepare('INSERT INTO chapters (book_id, chapter_name) VALUES (?, ?)').run(OTHER_BOOK, 'Fremd').lastInsertRowid;
const P1 = 7702011;
const P2 = 7702012;
const P_FOREIGN = 7702021;
const insPage = db.prepare(`INSERT INTO pages (page_id, book_id, chapter_id, page_name, body_html, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
insPage.run(P1, BOOK, ch1, 'Der Brief', '<p>Anna öffnet den Brief. Darin steht: «Komm nach Hause, Vater ist krank.»</p>', NOW);
insPage.run(P2, BOOK, ch2, 'Am Bahnhof', '<p>Der Zug fährt ein.</p>', NOW);
insPage.run(P_FOREIGN, OTHER_BOOK, chForeign, 'Fremd', '<p>x</p>', NOW);

const iBook = ideenDb.createIdee({ bookId: BOOK, userEmail: USER, content: 'Die Schwester sollte am Bahnhof warten' });
const iPage = ideenDb.createIdee({ bookId: BOOK, pageId: P1, userEmail: USER, content: 'Brief: Grund der Heimkehr nennen' });
const iChapter = ideenDb.createIdee({ bookId: BOOK, chapterId: ch2, userEmail: USER, content: 'Zeitangabe prüfen' });
const iDone = ideenDb.createIdee({ bookId: BOOK, pageId: P2, userEmail: USER, content: 'Erledigte Sache' });
ideenDb.updateIdee(iDone, USER, { status: 'erledigt' });
const iForeign = ideenDb.createIdee({ bookId: BOOK, userEmail: OTHER, content: 'Private Pendenz von jemand anderem' });

const act = plot.createAct(BOOK, USER, { name: 'Akt 1' });
const beat = plot.createBeat(BOOK, act.id, USER, { titel: 'Heimkehr' });

const tree = await loadOrderedBookContents(BOOK, { includeExcluded: true });
const ideenCount = () => db.prepare('SELECT COUNT(*) AS n FROM ideen WHERE book_id = ?').get(BOOK).n;
const mkCtx = () => ({
  bookId: BOOK, userEmail: USER, tree, proposals: [],
  readToolNames: new Set(['get_pages']), logger: { info() {}, warn() {} },
});

test('Kontext: nur eigene Ideen, gruppiert nach Ort, mit ids', () => {
  const state = loadIdeenState(BOOK, USER, tree);
  assert.equal(state.ideen.length, 4);
  assert.ok(!state.ideeById.has(iForeign));
  const out = ideenOutline(state);
  assert.match(out, /^BUCH \(ohne Ort/);
  assert.match(out, new RegExp(`KAPITEL \\[chapter#${ch1}\\] «Aufbruch»`));
  assert.match(out, new RegExp(`ABSCHNITT \\[page#${P1}\\] «Der Brief»`));
  assert.match(out, new RegExp(`\\[#${iPage}\\] \\(offen\\)`));
  assert.ok(!out.includes('Private Pendenz'));
  const glied = gliederungOutline(state);
  assert.match(glied, new RegExp(`Abschnitt \\[page#${P2}\\] «Am Bahnhof»`));
  assert.match(targetsOutline(state), new RegExp(`\\[beat#${beat.id}\\] «Heimkehr»`));
});

test('propose_idee: neue Idee mit Ort wird gesammelt, nicht geschrieben', async () => {
  const ctx = mkCtx();
  const before = ideenCount();
  const out = await executeIdeenChatTool('propose_idee', { content: 'Vater im Spital zeigen', chapter_id: ch2, begruendung: 'Lücke' }, ctx);
  assert.equal(out.ok, true);
  assert.equal(ideenCount(), before);
  const p = ctx.proposals[0];
  assert.equal(p.type, 'idee_create');
  assert.deepEqual(p.fields, { content: 'Vater im Spital zeigen', chapter_id: ch2 });
  assert.equal(p.labels.anchor, 'Heimkehr');
  assert.equal(p.begruendung, 'Lücke');
});

test('propose_idee: Anker im fremden Buch, beide Anker, status bei neuer Idee → error', async () => {
  const ctx = mkCtx();
  assert.ok((await executeIdeenChatTool('propose_idee', { content: 'x', page_id: P_FOREIGN, begruendung: 'b' }, ctx)).error);
  assert.ok((await executeIdeenChatTool('propose_idee', { content: 'x', page_id: P1, chapter_id: ch1, begruendung: 'b' }, ctx)).error);
  assert.ok((await executeIdeenChatTool('propose_idee', { content: 'x', status: 'erledigt', begruendung: 'b' }, ctx)).error);
  assert.ok((await executeIdeenChatTool('propose_idee', { content: '  ', begruendung: 'b' }, ctx)).error);
  assert.equal(ctx.proposals.length, 0);
});

test('«erledigt»: ohne Beleg abgelehnt, mit erfundenem Zitat abgelehnt, mit wörtlichem Zitat gesammelt', async () => {
  const ctx = mkCtx();
  assert.match((await executeIdeenChatTool('propose_idee', { idee_id: iPage, status: 'erledigt', begruendung: 'b' }, ctx)).error, /beleg/);
  assert.match((await executeIdeenChatTool('propose_idee', {
    idee_id: iPage, status: 'erledigt', beleg: 'Vater liegt im Sterben', beleg_page_id: P1, begruendung: 'b',
  }, ctx)).error, /steht so nicht/);
  // Toleranz gegenüber Anführungszeichen und Whitespace (lib/quote-verify.js).
  const ok = await executeIdeenChatTool('propose_idee', {
    idee_id: iPage, status: 'erledigt', beleg: '"Komm nach Hause,  Vater ist krank."', beleg_page_id: P1, begruendung: 'eingelöst',
  }, ctx);
  assert.equal(ok.ok, true);
  const p = ctx.proposals[0];
  assert.equal(p.type, 'idee_update');
  assert.deepEqual(p.fields, { status: 'erledigt' });
  assert.deepEqual(p.before, { status: 'offen' });
  assert.equal(p.beleg.page_id, P1);
  assert.equal(p.labels.beleg_page, 'Der Brief');
});

test('Stufe: abgeschaltete Stufe und No-Op werden abgelehnt', async () => {
  setBookIdeenStages(BOOK, ['offen', 'erledigt']);
  try {
    const ctx = mkCtx();
    assert.match((await executeIdeenChatTool('propose_idee', { idee_id: iChapter, status: 'verworfen', begruendung: 'b' }, ctx)).error, /abgeschaltet/);
    assert.match((await executeIdeenChatTool('propose_idee', { idee_id: iChapter, status: 'offen', begruendung: 'b' }, ctx)).error, /ändert/);
  } finally {
    setBookIdeenStages(BOOK, ['offen', 'in_arbeit', 'erledigt', 'verworfen']);
  }
});

test('Anker: Buch-Idee zuordnen ja; Art-Wechsel, abgeschlossene Idee, fremde Idee nein', async () => {
  const ctx = mkCtx();
  const ok = await executeIdeenChatTool('propose_idee', { idee_id: iBook, page_id: P2, begruendung: 'Bahnhof' }, ctx);
  assert.equal(ok.ok, true);
  assert.deepEqual(ctx.proposals[0].fields, { page_id: P2 });
  assert.equal(ctx.proposals[0].labels.anchor, 'Am Bahnhof');
  assert.equal(ctx.proposals[0].labels.anchor_before, null);
  // Kapitel-Idee → Abschnitt: Art-Wechsel (KIND_MISMATCH in der Route).
  assert.match((await executeIdeenChatTool('propose_idee', { idee_id: iChapter, page_id: P1, begruendung: 'b' }, ctx)).error, /Kapitel/);
  assert.match((await executeIdeenChatTool('propose_idee', { idee_id: iDone, page_id: P1, begruendung: 'b' }, ctx)).error, /abgeschlossen/);
  assert.match((await executeIdeenChatTool('propose_idee', { idee_id: iForeign, content: 'gekapert', begruendung: 'b' }, ctx)).error, /gibt es nicht/);
});

test('propose_idee_link: gegen Zielliste, idee_ref auf neue Idee, Dublette abgelehnt', async () => {
  const ctx = mkCtx();
  assert.equal((await executeIdeenChatTool('propose_idee_link', { idee_id: iBook, target_kind: 'beat', target_id: beat.id, begruendung: 'b' }, ctx)).ok, true);
  assert.equal(ctx.proposals[0].labels.target, 'Heimkehr');
  assert.ok((await executeIdeenChatTool('propose_idee_link', { idee_id: iBook, target_kind: 'beat', target_id: 999999, begruendung: 'b' }, ctx)).error);
  assert.ok((await executeIdeenChatTool('propose_idee_link', { idee_id: iBook, target_kind: 'figur', target_id: 1, begruendung: 'b' }, ctx)).error);
  await executeIdeenChatTool('propose_idee', { content: 'Neu', begruendung: 'b' }, ctx);
  const refOut = await executeIdeenChatTool('propose_idee_link', { idee_ref: 2, target_kind: 'beat', target_id: beat.id, begruendung: 'b' }, ctx);
  assert.equal(refOut.ok, true);
  assert.equal(ctx.proposals[2].idee_ref, 2);
  assert.ok((await executeIdeenChatTool('propose_idee_link', { idee_ref: 1, target_kind: 'beat', target_id: beat.id, begruendung: 'b' }, ctx)).error);

  ideenDb.addIdeaLink(iChapter, BOOK, 'beat', beat.id);
  const ctx2 = mkCtx();
  assert.match((await executeIdeenChatTool('propose_idee_link', { idee_id: iChapter, target_kind: 'beat', target_id: beat.id, begruendung: 'b' }, ctx2)).error, /schon verknüpft/);
});

test('Deckel und unbekannte Lese-Werkzeuge', async () => {
  const ctx = mkCtx();
  for (let i = 0; i < MAX_PROPOSALS; i++) ctx.proposals.push({ type: 'idee_create' });
  assert.match((await executeIdeenChatTool('propose_idee', { content: 'x', begruendung: 'b' }, ctx)).error, /Höchstens/);
  await assert.rejects(() => executeIdeenChatTool('get_stil_metrics', {}, mkCtx()), /Unbekanntes Werkzeug/);
});

test('klassischer Pfad: gültige Vorschläge durch dieselben Handler, Rest gezählt', async () => {
  const ctx = mkCtx();
  const { proposals, rejected } = await collectClassicProposals([
    { werkzeug: 'propose_idee', content: 'Klassisch neu', page_id: 0, chapter_id: null, begruendung: 'b' },
    { werkzeug: 'propose_idee', idee_id: iPage, status: 'erledigt', begruendung: 'ohne Beleg' },
    { werkzeug: 'gibts_nicht', begruendung: 'b' },
  ], ctx, null);
  assert.equal(proposals.length, 1);
  assert.deepEqual(proposals[0].fields, { content: 'Klassisch neu' });
  assert.equal(rejected, 2);
});

test('Gedächtnis: frühere Vorschläge der Session mit Status', () => {
  const sid = db.prepare(`INSERT INTO chat_sessions (book_id, kind, user_email, created_at, last_message_at) VALUES (?, 'ideen', ?, ?, ?)`)
    .run(BOOK, USER, NOW, NOW).lastInsertRowid;
  const ci = { proposals: [
    { type: 'idee_create', fields: { content: 'Eins' }, applied_at: NOW },
    { type: 'idee_update', idee_id: iPage, fields: { status: 'erledigt' }, labels: { idee: 'Brief' }, status: 'discarded' },
  ] };
  db.prepare(`INSERT INTO chat_messages (session_id, role, content, context_info, created_at) VALUES (?, 'assistant', 'a', ?, ?)`)
    .run(sid, JSON.stringify(ci), NOW);
  const mem = sessionIdeenProposalMemory(sid);
  assert.deepEqual(mem.map(m => m.state), ['applied', 'discarded']);
  assert.match(mem[1].label, /→ erledigt/);
});
