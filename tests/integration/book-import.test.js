'use strict';

// Integration: Buch-Migration Round-Trip. Quell-Buch seeden -> Bundle bauen
// (wie routes/book-migration.js) -> Import-Job laufen lassen -> Ziel-Buch
// vergleichen. Deckt den realen Import-Pfad (JSZip + Validate + Content-Store-
// Anlage) gegen die Test-DB ab.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctxBoot;
let contentStore, bookBundle, bookImport, shared;

const OWNER = 'autor@test.dev';
const reqCtx = { session: { user: { email: OWNER } } };

before(() => {
  ctxBoot = bootstrap();
  contentStore = require('../../lib/content-store');
  bookBundle = require('../../lib/book-bundle');
  bookImport = require('../../routes/jobs/book-import');
  shared = ctxBoot.shared;
});

after(() => { ctxBoot.cleanup(); });

beforeEach(() => { ctxBoot.dbSeed.reset(); });

async function buildBundleBuffer(bookId, includes = null, opts = {}) {
  const tree = await contentStore.bookTree(bookId, reqCtx);
  const book = await contentStore.loadBook(bookId, reqCtx);
  const metas = [];
  for (const p of (tree.topPages || [])) metas.push(p);
  (function walk(chs) { for (const c of chs) { for (const p of (c.pages || [])) metas.push(p); walk(c.subchapters || []); } })(tree.chapters || []);
  const details = await contentStore.loadPagesBatch(metas, reqCtx, { batchSize: 15, onError: () => null });
  const htmlById = new Map();
  for (const d of details) if (d && d.id) htmlById.set(d.id, d.html || '');
  const nodes = bookBundle.treeToNodes(tree, htmlById);
  const norm = bookBundle.normalizeIncludes(includes);
  const manifest = bookBundle.buildManifest({ sourceBookId: bookId, exportedAt: '2026-05-30T00:00:00Z', includes: norm });
  const bookJson = bookBundle.buildBookJson({ book, settings: { language: 'de', region: 'CH', buchtyp: 'roman' }, nodes });
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest));
  zip.file('book.json', JSON.stringify(bookJson));
  if (norm.analysis || norm.lektorat || norm.chats || norm.research) {
    const { collectExtras } = require('../../db/book-migration-data');
    const extras = collectExtras(bookId, norm, opts.scopeEmail ?? null);
    // `analysisOverride` baut ein Alt-Bundle nach: vor der Scope-Regel sammelte
    // der Export den Analyse-Block ungefiltert, also die Analysen ALLER User.
    const analysis = opts.analysisOverride || extras.analysis;
    if (analysis) zip.file('analysis.json', JSON.stringify(analysis));
    if (extras.lektorat) zip.file('lektorat.json', JSON.stringify(extras.lektorat));
    if (extras.chats)    zip.file('chats.json', JSON.stringify(extras.chats));
    if (extras.research) zip.file('research.json', JSON.stringify(extras.research));
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function runImport(buffer) {
  const jobId = shared.createJob('book-import', 0, OWNER, 'job.label.bookImport', {}, `t:${Math.random()}`);
  bookImport.importBuffers.set(jobId, { buffer });
  await bookImport.runBookImportJob(jobId, { userEmail: OWNER });
  return shared.jobs.get(jobId);
}

test('Round-Trip: Export-Bundle -> Import erzeugt strukturgleiches Buch', async () => {
  ctxBoot.dbSeed.setBook({
    books: [{ id: 900, name: 'Quellbuch' }],
    chapters: [
      { id: 9001, book_id: 900, name: 'Kapitel A', position: 0 },
      { id: 9002, book_id: 900, name: 'Kapitel B', position: 1 },
    ],
    pages: [
      { id: 90001, book_id: 900, name: 'Intro', chapter_id: null, position: 0 },
      { id: 90002, book_id: 900, name: 'A1', chapter_id: 9001, position: 0 },
      { id: 90003, book_id: 900, name: 'A2', chapter_id: 9001, position: 1 },
      { id: 90004, book_id: 900, name: 'B1', chapter_id: 9002, position: 0 },
    ],
    pageBodies: {
      90001: '<p>Vorwort-Text</p>',
      90002: '<p>Erste Seite</p>',
      90003: '<p>Zweite Seite</p>',
      90004: '<p>Kapitel B Seite</p>',
    },
  });

  const buffer = await buildBundleBuffer(900);
  const job = await runImport(buffer);

  assert.equal(job.status, 'done', job.error || '');
  const newBookId = job.result.bookId;
  assert.ok(newBookId && newBookId !== 900);
  assert.equal(job.result.pagesCreated, 4);
  assert.equal(job.result.chaptersCreated, 2);

  // Ziel-Buch laden + Struktur vergleichen.
  const tree = await contentStore.bookTree(newBookId, reqCtx);
  const flat = contentStore.flattenTree(tree);
  const names = flat.map(f => f.page.name).sort();
  assert.deepEqual(names, ['A1', 'A2', 'B1', 'Intro']);

  const chapterNames = (tree.chapters || []).map(c => c.name).sort();
  assert.deepEqual(chapterNames, ['Kapitel A', 'Kapitel B']);

  // HTML einer Seite verifizieren (durch _cleanHtmlSafe gelaufen -> data-bid,
  // aber Textinhalt erhalten).
  const a1 = flat.find(f => f.page.name === 'A1');
  const full = await contentStore.loadPage(a1.page.id, reqCtx);
  assert.match(full.html, /Erste Seite/);

  // Owner gesetzt.
  const { db } = require('../../db/connection');
  const owner = db.prepare('SELECT owner_email FROM books WHERE book_id = ?').get(newBookId);
  assert.equal(owner.owner_email, OWNER);

  // Settings uebernommen.
  const settings = ctxBoot.dbSchema.getBookSettings(newBookId);
  assert.equal(settings.buchtyp, 'roman');
});

test('Re-Import erzeugt ein zweites unabhaengiges Buch', async () => {
  ctxBoot.dbSeed.setBook({
    books: [{ id: 901, name: 'Quelle2' }],
    chapters: [{ id: 9011, book_id: 901, name: 'K', position: 0 }],
    pages: [{ id: 90011, book_id: 901, name: 'S', chapter_id: 9011, position: 0 }],
    pageBodies: { 90011: '<p>Inhalt</p>' },
  });
  const buffer = await buildBundleBuffer(901);
  const j1 = await runImport(buffer);
  const j2 = await runImport(buffer);
  assert.equal(j1.status, 'done');
  assert.equal(j2.status, 'done');
  assert.notEqual(j1.result.bookId, j2.result.bookId);
});

test('Extra-Round-Trip: Analyse/Lektorat/Chats werden mit remappten IDs uebernommen', async () => {
  ctxBoot.dbSeed.setBook({
    books: [{ id: 950, name: 'AnalyseQuelle' }],
    chapters: [{ id: 9501, book_id: 950, name: 'Kap', position: 0 }],
    pages: [{ id: 95001, book_id: 950, name: 'Seite1', chapter_id: 9501, position: 0 }],
    pageBodies: { 95001: '<p>Text</p>' },
  });

  const { db } = require('../../db/connection');
  const iso = '2026-05-30T10:00:00.000Z';
  // Figur mit Page-Referenz
  db.prepare(`INSERT INTO figures (book_id,fig_id,name,updated_at,user_email,erste_erwaehnung_page_id)
              VALUES (?,?,?,?,?,?)`).run(950, 'fig-held', 'Held', iso, OWNER, 95001);
  // Szene mit Chapter+Page-Referenz
  db.prepare(`INSERT INTO figure_scenes (book_id,user_email,titel,chapter_id,page_id,updated_at)
              VALUES (?,?,?,?,?,?)`).run(950, OWNER, 'Showdown', 9501, 95001, iso);
  // Lektorat-Check
  db.prepare(`INSERT INTO page_checks (page_id,book_id,checked_at,error_count,fazit,user_email,chapter_id)
              VALUES (?,?,?,?,?,?,?)`).run(95001, 950, iso, 2, 'solide', OWNER, 9501);
  // Chat-Session (page) + Nachricht
  const sess = db.prepare(`INSERT INTO chat_sessions (book_id,kind,page_id,user_email,created_at,last_message_at)
              VALUES (?,?,?,?,?,?)`).run(950, 'page', 95001, OWNER, iso, iso);
  db.prepare(`INSERT INTO chat_messages (session_id,role,content,created_at)
              VALUES (?,?,?,?)`).run(sess.lastInsertRowid, 'user', 'Hallo', iso);

  const buffer = await buildBundleBuffer(950, { analysis: true, lektorat: true, chats: true });
  const job = await runImport(buffer);
  assert.equal(job.status, 'done', job.error || '');
  const newBookId = job.result.bookId;

  assert.equal(job.result.extras.analysis.figures, 1);
  assert.equal(job.result.extras.lektorat.pageChecks, 1);
  assert.equal(job.result.extras.chats.sessions, 1);
  assert.equal(job.result.extras.chats.messages, 1);

  // Neue Page-/Chapter-IDs ermitteln.
  const tree = await contentStore.bookTree(newBookId, reqCtx);
  const flat = contentStore.flattenTree(tree);
  const newPageId = flat.find(f => f.page.name === 'Seite1').page.id;
  const newChapterId = (tree.chapters || [])[0].id;
  assert.ok(newPageId && newPageId !== 95001);

  const fig = db.prepare('SELECT * FROM figures WHERE book_id = ?').get(newBookId);
  assert.equal(fig.name, 'Held');
  assert.equal(fig.user_email, OWNER);
  assert.equal(fig.erste_erwaehnung_page_id, newPageId); // Page-Referenz remapped

  const scene = db.prepare('SELECT * FROM figure_scenes WHERE book_id = ?').get(newBookId);
  assert.equal(scene.titel, 'Showdown');
  assert.equal(scene.page_id, newPageId);
  assert.equal(scene.chapter_id, newChapterId); // Chapter-Referenz remapped

  const pc = db.prepare('SELECT * FROM page_checks WHERE book_id = ?').get(newBookId);
  assert.equal(pc.page_id, newPageId);
  assert.equal(pc.fazit, 'solide');
  assert.equal(pc.user_email, OWNER);

  const cs = db.prepare('SELECT * FROM chat_sessions WHERE book_id = ?').get(newBookId);
  assert.equal(cs.kind, 'page');
  assert.equal(cs.page_id, newPageId);
  const msgCount = db.prepare('SELECT COUNT(*) AS c FROM chat_messages WHERE session_id = ?').get(cs.id);
  assert.equal(msgCount.c, 1);
});

test('Recherche-Round-Trip: Fundstuecke samt Anhang, URLs, Tags und Verknuepfungen; buchweite Chat-Sessions', async () => {
  ctxBoot.dbSeed.setBook({
    books: [{ id: 960, name: 'RechercheQuelle' }],
    chapters: [{ id: 9601, book_id: 960, name: 'Kap', position: 0 }],
    pages: [{ id: 96001, book_id: 960, name: 'Seite1', chapter_id: 9601, position: 0 }],
    pageBodies: { 96001: '<p>Text</p>' },
  });
  const { db } = require('../../db/connection');
  const iso = '2026-05-30T10:00:00.000Z';
  const fig = db.prepare(`INSERT INTO figures (book_id,fig_id,name,updated_at,user_email) VALUES (?,?,?,?,?)`)
    .run(960, 'fig-a', 'Anna', iso, OWNER).lastInsertRowid;
  const item = db.prepare(`INSERT INTO research_items (book_id,user_email,kind,title,body,image,image_mime,status)
              VALUES (?,?,?,?,?,?,?,?)`).run(960, OWNER, 'fact', 'Mondlandung', '1969', Buffer.from([1, 2, 3]), 'image/png', 'eingearbeitet').lastInsertRowid;
  db.prepare('INSERT INTO research_item_urls (item_id,url,label,position) VALUES (?,?,?,?)').run(item, 'https://example.org/a', 'A', 0);
  db.prepare('INSERT INTO research_item_tags (item_id,tag) VALUES (?,?)').run(item, 'raumfahrt');
  db.prepare("INSERT INTO research_item_links (item_id,target_kind,page_id) VALUES (?,'page',?)").run(item, 96001);
  db.prepare("INSERT INTO research_item_links (item_id,target_kind,figure_id) VALUES (?,'figure',?)").run(item, fig);
  db.prepare(`INSERT INTO chat_sessions (book_id,kind,page_id,user_email,created_at,last_message_at)
              VALUES (?,?,?,?,?,?)`).run(960, 'research', null, OWNER, iso, iso);

  // Ohne Analyse: die Figuren-Verknuepfung hat kein Gegenueber und faellt weg.
  let job = await runImport(await buildBundleBuffer(960, { research: true, chats: true }));
  assert.equal(job.status, 'done', job.error || '');
  assert.deepEqual(job.result.extras.research, { items: 1, links: 1, linksDropped: 1 });
  assert.equal(job.result.extras.chats.sessions, 1);
  let nb = job.result.bookId;
  const ri = db.prepare('SELECT * FROM research_items WHERE book_id = ?').get(nb);
  assert.equal(ri.title, 'Mondlandung');
  assert.equal(ri.status, 'eingearbeitet');
  assert.deepEqual([...ri.image], [1, 2, 3]);
  assert.equal(db.prepare('SELECT url FROM research_item_urls WHERE item_id = ?').get(ri.id).url, 'https://example.org/a');
  assert.equal(db.prepare('SELECT tag FROM research_item_tags WHERE item_id = ?').get(ri.id).tag, 'raumfahrt');
  const flat = contentStore.flattenTree(await contentStore.bookTree(nb, reqCtx));
  const newPage = flat.find(f => f.page.name === 'Seite1').page.id;
  assert.equal(db.prepare("SELECT page_id FROM research_item_links WHERE item_id = ? AND target_kind='page'").get(ri.id).page_id, newPage);
  assert.equal(db.prepare('SELECT kind FROM chat_sessions WHERE book_id = ?').get(nb).kind, 'research');

  // Mit Analyse: die Figuren-Verknuepfung zeigt auf die neu angelegte Figur.
  job = await runImport(await buildBundleBuffer(960, { research: true, analysis: true }, { scopeEmail: OWNER }));
  assert.equal(job.status, 'done', job.error || '');
  assert.deepEqual(job.result.extras.research, { items: 1, links: 2, linksDropped: 0 });
  nb = job.result.bookId;
  const newFig = db.prepare('SELECT id FROM figures WHERE book_id = ?').get(nb).id;
  const ri2 = db.prepare('SELECT id FROM research_items WHERE book_id = ?').get(nb).id;
  assert.equal(db.prepare("SELECT figure_id FROM research_item_links WHERE item_id = ? AND target_kind='figure'").get(ri2).figure_id, newFig);
});

test('Content-only-Export (keine includes) laesst Extra-Tabellen leer', async () => {
  ctxBoot.dbSeed.setBook({
    books: [{ id: 951, name: 'NurInhalt' }],
    chapters: [{ id: 9511, book_id: 951, name: 'K', position: 0 }],
    pages: [{ id: 95101, book_id: 951, name: 'S', chapter_id: 9511, position: 0 }],
    pageBodies: { 95101: '<p>x</p>' },
  });
  const { db } = require('../../db/connection');
  db.prepare(`INSERT INTO figures (book_id,fig_id,name,updated_at,user_email) VALUES (?,?,?,?,?)`)
    .run(951, 'f1', 'X', '2026-05-30T10:00:00.000Z', OWNER);

  const buffer = await buildBundleBuffer(951); // keine includes
  const job = await runImport(buffer);
  assert.equal(job.status, 'done', job.error || '');
  assert.equal(job.result.extras, null);
  const fig = db.prepare('SELECT COUNT(*) AS c FROM figures WHERE book_id = ?').get(job.result.bookId);
  assert.equal(fig.c, 0);
});

test('Kaputtes Manifest -> Job-Error badManifest', async () => {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({ format: 'andere-app', version: 1 }));
  zip.file('book.json', JSON.stringify({ book: { name: 'X' }, tree: [{ type: 'page', name: 'p' }] }));
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const job = await runImport(buffer);
  assert.equal(job.status, 'error');
});

// Zwei Leute am selben Buch heisst zwei Analysen: `figures`/`locations`/`scenes`/
// … sind pro `user_email` skopiert, jede Analyse hat ihren eigenen `fig_1`-Raum.
// Beim Restore bekommen alle Zeilen die E-Mail des Importierenden — nimmt das
// Bundle beide Analysen mit, verschmelzen sie zu EINEM Katalog, in dem jede
// Figur zweimal steht (mit umbenanntem Schluessel `fig_1__2`). Genau das war im
// Figuren-Katalog und im Referenz-Slot zu sehen.
const MITARBEIT = 'mitarbeit@test.dev';

function _seedZweiAnalysen(bookId) {
  const { db } = require('../../db/connection');
  const iso = '2026-06-01T10:00:00.000Z';
  const insFig = db.prepare('INSERT INTO figures (book_id,fig_id,name,updated_at,user_email) VALUES (?,?,?,?,?)');
  // Analyse des Owners: drei Figuren. Analyse der Mitarbeiterin: zwei — mit
  // denselben fig_ids, was innerhalb einer Analyse unmoeglich ist.
  insFig.run(bookId, 'fig_1', 'Held', iso, OWNER);
  insFig.run(bookId, 'fig_2', 'Gegenspieler', iso, OWNER);
  insFig.run(bookId, 'fig_3', 'Nebenfigur', iso, OWNER);
  insFig.run(bookId, 'fig_1', 'Held', iso, MITARBEIT);
  insFig.run(bookId, 'fig_2', 'Gegenspieler', iso, MITARBEIT);
  db.prepare('INSERT INTO figure_scenes (book_id,user_email,titel,updated_at) VALUES (?,?,?,?)')
    .run(bookId, MITARBEIT, 'Szene der Mitarbeiterin', iso);
  return db;
}

test('Export nimmt genau EINE Analyse mit — die des exportierenden Users', async () => {
  ctxBoot.dbSeed.setBook({
    books: [{ id: 952, name: 'ZweiAnalysen' }],
    pages: [{ id: 95201, book_id: 952, name: 'S', chapter_id: null, position: 0 }],
    pageBodies: { 95201: '<p>x</p>' },
  });
  _seedZweiAnalysen(952);

  const { collectExtras } = require('../../db/book-migration-data');
  const extras = collectExtras(952, { analysis: true }, OWNER);
  assert.deepEqual(extras.analysis.figures.map(f => f.fig_id).sort(), ['fig_1', 'fig_2', 'fig_3']);
  assert.ok(extras.analysis.figures.every(f => f.user_email === OWNER));
  assert.equal(extras.analysis.scenes.length, 0, 'die Szene gehoert zur anderen Analyse');
  assert.equal(extras.analysisScope.email, OWNER);
  assert.equal(extras.analysisScope.skippedScopes, 1);
  assert.equal(extras.analysisScope.skippedRows, 3, '2 Figuren + 1 Szene der Mitarbeiterin');

  // Und aus der Sicht der Mitarbeiterin genau umgekehrt.
  const mit = collectExtras(952, { analysis: true }, MITARBEIT);
  assert.deepEqual(mit.analysis.figures.map(f => f.fig_id).sort(), ['fig_1', 'fig_2']);
  assert.equal(mit.analysis.scenes.length, 1);
});

test('Alt-Bundle mit zwei Analysen: der Import spielt nur eine ein, keine Dubletten', async () => {
  ctxBoot.dbSeed.setBook({
    books: [{ id: 953, name: 'AltBundle' }],
    pages: [{ id: 95301, book_id: 953, name: 'S', chapter_id: null, position: 0 }],
    pageBodies: { 95301: '<p>x</p>' },
  });
  const db = _seedZweiAnalysen(953);

  // Analyse-Block wie ihn der Export VOR der Scope-Regel gebaut hat: ungefiltert.
  const analysisOverride = {
    figures: db.prepare('SELECT * FROM figures WHERE book_id = ?').all(953),
    scenes: db.prepare('SELECT * FROM figure_scenes WHERE book_id = ?').all(953),
  };
  assert.equal(analysisOverride.figures.length, 5, 'Vorbedingung: beide Analysen im Bundle');

  const buffer = await buildBundleBuffer(953, { analysis: true }, { analysisOverride });
  const job = await runImport(buffer);
  assert.equal(job.status, 'done', job.error || '');
  const newBookId = job.result.bookId;

  const figs = db.prepare('SELECT fig_id, name FROM figures WHERE book_id = ? ORDER BY fig_id').all(newBookId);
  assert.deepEqual(figs.map(f => f.fig_id), ['fig_1', 'fig_2', 'fig_3'],
    'die vollstaendigste Analyse gewinnt, die andere bleibt draussen');
  assert.equal(figs.filter(f => f.fig_id.includes('__')).length, 0,
    'kein umbenannter Schluessel — der Kollisions-Rename ist nur noch letzte Absicherung');
  assert.equal(new Set(figs.map(f => f.name)).size, figs.length, 'keine Namens-Dublette im Katalog');

  // Der Import sagt, dass er nicht alles eingespielt hat.
  assert.equal(job.result.extras.analysis.skippedScopes, 1);
  assert.equal(job.result.extras.analysis.skippedRows, 3);
});

test('Fremdes Bundle: MIME-Typen der Recherche-Anhaenge laufen durch die Allowlist', async () => {
  ctxBoot.dbSeed.setBook({
    books: [{ id: 970, name: 'MimeQuelle' }],
    chapters: [{ id: 9701, book_id: 970, name: 'Kap', position: 0 }],
    pages: [{ id: 97001, book_id: 970, name: 'Seite1', chapter_id: 9701, position: 0 }],
    pageBodies: { 97001: '<p>Text</p>' },
  });
  const { db } = require('../../db/connection');
  const ins = db.prepare(`INSERT INTO research_items (book_id,user_email,kind,title,image,image_mime,doc,doc_mime,status)
              VALUES (?,?,?,?,?,?,?,?,?)`);
  ins.run(970, OWNER, 'image', 'boese', Buffer.from('<script>x</script>'), 'text/html',
    Buffer.from('alert(1)'), 'text/javascript', 'offen');
  ins.run(970, OWNER, 'image', 'gut', Buffer.from([1, 2, 3]), 'image/png',
    Buffer.from('%PDF'), 'application/pdf', 'offen');

  const job = await runImport(await buildBundleBuffer(970, { research: true }));
  assert.equal(job.status, 'done', job.error || '');
  const rows = db.prepare('SELECT title, image_mime, doc_mime FROM research_items WHERE book_id = ? ORDER BY title')
    .all(job.result.bookId);
  assert.deepEqual(rows.map(r => ({ ...r })), [
    { title: 'boese', image_mime: null, doc_mime: null },
    { title: 'gut', image_mime: 'image/png', doc_mime: 'application/pdf' },
  ]);
});

test('collectReferencedImages: Bild-Referenz auf ein fremdes Buch wird nicht eingesammelt', () => {
  ctxBoot.dbSeed.setBook({
    books: [{ id: 980, name: 'Eigen' }, { id: 981, name: 'Fremd' }],
    chapters: [{ id: 9801, book_id: 980, name: 'K', position: 0 }, { id: 9811, book_id: 981, name: 'K', position: 0 }],
    pages: [
      { id: 98001, book_id: 980, name: 'Eigene', chapter_id: 9801, position: 0 },
      { id: 98101, book_id: 981, name: 'Fremde', chapter_id: 9811, position: 0 },
    ],
    pageBodies: { 98001: '<p>a</p>', 98101: '<p>b</p>' },
  });
  const { insertPageImage, collectReferencedImages } = require('../../db/page-images');
  const own = insertPageImage({ pageId: 98001, mime: 'image/png', image: Buffer.from([1]) });
  const foreign = insertPageImage({ pageId: 98101, mime: 'image/png', image: Buffer.from([2]) });
  const html = `<img src="/content/page-image/${own}"><img src="/content/page-image/${foreign}">`;
  const got = collectReferencedImages(new Map([[98001, html]]), 980).get(98001);
  assert.deepEqual(got.map(i => i.oldId), [Number(own)]);
});

function _seedTwoPages(id) {
  ctxBoot.dbSeed.setBook({
    books: [{ id, name: `Quelle${id}` }],
    chapters: [{ id: id * 10 + 1, book_id: id, name: 'Kap', position: 0 }],
    pages: [
      { id: id * 100 + 1, book_id: id, name: 'S1', chapter_id: id * 10 + 1, position: 0 },
      { id: id * 100 + 2, book_id: id, name: 'S2', chapter_id: id * 10 + 1, position: 1 },
    ],
    pageBodies: { [id * 100 + 1]: '<p>eins</p>', [id * 100 + 2]: '<p>zwei</p>' },
  });
}
const _bookNames = async () => (await contentStore.listBooks(reqCtx)).map(b => b.name);

test('Teilimport: gescheiterte Abschnitte stehen im Ergebnis (failed / pagesInBundle)', async () => {
  _seedTwoPages(990);
  const buf = await buildBundleBuffer(990);
  const orig = contentStore.createPage;
  contentStore.createPage = async (body, ctx) => {
    if (body.name === 'S2') throw new Error('sanitize failed');
    return orig(body, ctx);
  };
  let job;
  try { job = await runImport(buf); } finally { contentStore.createPage = orig; }
  assert.equal(job.status, 'done', job.error || '');
  assert.equal(job.result.pagesCreated, 1);
  assert.equal(job.result.failed, 1);
  assert.equal(job.result.pagesInBundle, 2);
});

test('Kein Abschnitt angelegt: Job-Fehler swbookNoPagesCreated, Buch zurueckgenommen', async () => {
  _seedTwoPages(991);
  const buf = await buildBundleBuffer(991);
  const before = await _bookNames();
  const orig = contentStore.createPage;
  contentStore.createPage = async () => { throw new Error('sanitize failed'); };
  let job;
  try { job = await runImport(buf); } finally { contentStore.createPage = orig; }
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'job.error.swbookNoPagesCreated');
  assert.deepEqual(job.errorParams, { n: 2 });
  assert.deepEqual(await _bookNames(), before);
});

test('Abbruch waehrend des Anlegens: «cancelled», Buch zurueckgenommen', async () => {
  _seedTwoPages(992);
  const buf = await buildBundleBuffer(992);
  const before = await _bookNames();
  const jobId = shared.createJob('book-import', 0, OWNER, 'job.label.bookImport', {}, `t:${Math.random()}`);
  shared.jobs.get(jobId).status = 'running';
  const orig = contentStore.createPage;
  contentStore.createPage = async (body, ctx) => { shared.cancelJob(jobId, OWNER); return orig(body, ctx); };
  bookImport.importBuffers.set(jobId, { buffer: buf });
  try { await bookImport.runBookImportJob(jobId, { userEmail: OWNER }); } finally { contentStore.createPage = orig; }
  assert.equal(shared.jobs.get(jobId).status, 'cancelled');
  assert.deepEqual(await _bookNames(), before);
});
