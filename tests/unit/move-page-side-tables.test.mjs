// movePage, zweite Schicht: jede Tabelle mit page_id ist bewusst eingeordnet
// (zieht mit / gekappt / Anker geloest), und ein Seiten-Share-Link, dessen
// Ersteller im Zielbuch keine Freigabe-Rolle hat, wird beim Umzug widerrufen.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('move-page-side-tables');

require('../../db/migrations');
const { db } = require('../../db/connection');
const contentStore = require('../../lib/content-store');
const { MOVE_WITH_PAGE, DELETE_BY_PAGE, DETACH } = require('../../lib/content-store/backends/localdb-move');

const now = new Date().toISOString();
const SRC = 9501, DST = 9502;
db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(SRC, 'Q', now, now);
db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(DST, 'Z', now, now);
for (const e of ['alice@x.ch', 'bob@x.ch', 'vera@x.ch']) db.prepare('INSERT INTO app_users (email) VALUES (?)').run(e);
const grant = db.prepare('INSERT INTO book_access (book_id, user_email, role) VALUES (?, ?, ?)');
grant.run(SRC, 'alice@x.ch', 'owner');
grant.run(DST, 'alice@x.ch', 'editor');
grant.run(SRC, 'bob@x.ch', 'editor');            // kein Zugriff aufs Zielbuch
grant.run(SRC, 'vera@x.ch', 'editor');
grant.run(DST, 'vera@x.ch', 'viewer');           // Zugriff, aber unter der Freigabe-Rolle

const n = (sql, ...a) => db.prepare(sql).get(...a).n;

test('movePage: seitengebundene Tabellen ziehen mit bzw. werden gekappt', async () => {
  const page = await contentStore.createPage({ book_id: SRC, name: 'S', html: '<p>x</p>' });
  const pid = page.id;
  const other = await contentStore.createPage({ book_id: SRC, name: 'T', html: '<p>y</p>' });

  // Seiten-intrinsisch.
  db.prepare("INSERT INTO page_headline (page_id, book_id, titel, updated_at) VALUES (?, ?, 'T', ?)").run(pid, SRC, now);
  db.prepare("INSERT INTO page_headline_variants (page_id, book_id, feld, text) VALUES (?, ?, 'titel', 'V')").run(pid, SRC);
  db.prepare("INSERT INTO page_editorial_status (page_id, book_id, status) VALUES (?, ?, 'roh')").run(pid, SRC);
  db.prepare("INSERT INTO page_textsorte (page_id, book_id, textsorte) VALUES (?, ?, 'bericht')").run(pid, SRC);
  db.prepare("INSERT INTO page_structure_checks (page_id, book_id, textsorte, result_json) VALUES (?, ?, 'bericht', '{}')").run(pid, SRC);
  db.prepare('INSERT INTO user_page_usage (user_email, page_id, book_id, last_used) VALUES (?, ?, ?, 1)').run('alice@x.ch', pid, SRC);

  // Buchwelt der Quelle.
  const motif = db.prepare("INSERT INTO motifs (book_id, user_email, name) VALUES (?, 'alice@x.ch', 'M')").run(SRC).lastInsertRowid;
  db.prepare("INSERT INTO motif_occurrences (motif_id, book_id, kind, page_id, source) VALUES (?, ?, 'page', ?, 'trigger')").run(motif, SRC, pid);
  const item = db.prepare("INSERT INTO research_items (book_id, user_email) VALUES (?, 'alice@x.ch')").run(SRC).lastInsertRowid;
  db.prepare("INSERT INTO research_item_findings (item_id, book_id, page_id, typ, stelle) VALUES (?, ?, ?, 'zitat', 's')").run(item, SRC, pid);
  const draft = db.prepare("INSERT INTO draft_figures (book_id, user_email, name, mindmap_json, created_at, updated_at) VALUES (?, 'alice@x.ch', 'D', '{}', ?, ?)").run(SRC, now, now).lastInsertRowid;
  db.prepare("INSERT INTO draft_figure_occurrences (draft_id, book_id, kern, kind, page_id, source) VALUES (?, ?, 'want', 'page', ?, 'trigger')").run(draft, SRC, pid);
  const fig = db.prepare("INSERT INTO figures (book_id, fig_id, name, updated_at) VALUES (?, 'f1', 'Anna', ?)").run(SRC, now).lastInsertRowid;
  db.prepare("INSERT INTO figure_age_belege (figure_id, book_id, art, wert, zitat, page_id) VALUES (?, ?, 'alter', 30, 'z', ?)").run(fig, SRC, pid);
  db.prepare("INSERT INTO lexicon_terms (book_id, term, count, first_page_id) VALUES (?, 'wort', 3, ?)").run(SRC, pid);
  const chk = db.prepare('INSERT INTO continuity_checks (book_id, checked_at) VALUES (?, ?)').run(SRC, now).lastInsertRowid;
  db.prepare('INSERT INTO continuity_issues (check_id, book_id, page_a_id, page_b_id) VALUES (?, ?, ?, ?)').run(chk, SRC, pid, other.id);
  const [a, b] = pid < other.id ? [pid, other.id] : [other.id, pid];
  db.prepare("INSERT INTO redundancy_dismissals (book_id, user_email, kind, page_a_id, page_b_id) VALUES (?, 'alice@x.ch', 'page', ?, ?)").run(SRC, a, b);

  await contentStore.movePage(pid, { targetBookId: DST });

  for (const t of ['page_headline', 'page_headline_variants', 'page_editorial_status', 'page_textsorte',
    'page_structure_checks', 'user_page_usage']) {
    assert.equal(db.prepare(`SELECT book_id FROM ${t} WHERE page_id = ?`).get(pid).book_id, DST, t);
  }
  for (const t of ['motif_occurrences', 'research_item_findings', 'draft_figure_occurrences']) {
    assert.equal(n(`SELECT COUNT(*) AS n FROM ${t} WHERE page_id = ?`, pid), 0, t);
  }
  const beleg = db.prepare('SELECT book_id, page_id FROM figure_age_belege WHERE figure_id = ?').get(fig);
  assert.deepEqual({ ...beleg }, { book_id: SRC, page_id: null }, 'Beleg bleibt bei der Figur, Seiten-Anker geloest');
  assert.equal(db.prepare("SELECT first_page_id AS p FROM lexicon_terms WHERE term = 'wort'").get().p, null);
  const issue = db.prepare('SELECT page_a_id, page_b_id FROM continuity_issues WHERE check_id = ?').get(chk);
  assert.equal(issue.page_a_id, null);
  assert.equal(issue.page_b_id, other.id);
  assert.equal(n('SELECT COUNT(*) AS n FROM redundancy_dismissals WHERE book_id = ?', SRC), 0);

  // Kein buchgebundener Katalog des Quellbuchs zeigt mehr auf die Seite im Zielbuch.
  for (const t of ['motif_occurrences', 'research_item_findings', 'draft_figure_occurrences', 'plot_beat_occurrences',
    'figure_age_belege']) {
    assert.equal(n(`SELECT COUNT(*) AS n FROM ${t} WHERE page_id = ? AND book_id <> ?`, pid, DST), 0, t);
  }
});

test('movePage: Seiten-Share ohne Freigabe-Rolle im Zielbuch wird widerrufen', async () => {
  const page = await contentStore.createPage({ book_id: SRC, name: 'Geteilt', html: '<p>geheim</p>' });
  const ins = db.prepare("INSERT INTO share_links (token, kind, page_id, book_id, owner_email) VALUES (?, 'page', ?, ?, ?)");
  ins.run('tok-alice', page.id, SRC, 'alice@x.ch');
  ins.run('tok-bob', page.id, SRC, 'bob@x.ch');
  ins.run('tok-vera', page.id, SRC, 'vera@x.ch');

  const res = await contentStore.movePage(page.id, { targetBookId: DST });
  assert.equal(res.revokedShareLinks, 2);

  const link = (t) => db.prepare('SELECT book_id, revoked_at FROM share_links WHERE token = ?').get(t);
  assert.equal(link('tok-alice').book_id, DST);
  assert.equal(link('tok-alice').revoked_at, null, 'Editor im Zielbuch behaelt seinen Link');
  assert.ok(link('tok-bob').revoked_at, 'kein Zugriff aufs Zielbuch → widerrufen');
  assert.ok(link('tok-vera').revoked_at, 'nur Viewer im Zielbuch → widerrufen');
});

// Tripwire: eine neue Tabelle mit page_id-FK UND book_id-Spalte muss in
// localdb-move.js eingeordnet werden — sonst zeigt sie nach einem Umzug mit
// der Quell-book_id auf eine Seite im Zielbuch.
test('jede Tabelle mit page_id-FK und book_id ist in localdb-move eingeordnet', () => {
  const SPECIAL = new Set(['pages', 'page_checks', 'share_links', 'redundancy_dismissals']);
  const known = new Set([...MOVE_WITH_PAGE, ...DELETE_BY_PAGE, ...DETACH.map(([t]) => t), ...SPECIAL]);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
  const missing = [];
  for (const t of tables) {
    const fks = db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(t)})`).all();
    if (!fks.some(f => f.table === 'pages')) continue;
    const cols = db.prepare(`PRAGMA table_info(${JSON.stringify(t)})`).all().map(c => c.name);
    if (!cols.includes('book_id')) continue;
    if (!known.has(t)) missing.push(t);
  }
  assert.deepEqual(missing, []);
});
