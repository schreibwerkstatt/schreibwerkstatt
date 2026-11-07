// Unit-Tests fuer lib/search.js Query-Parser +
// HTML-Text-Normalisierung. Voller Index-Flow wird in der Integration getestet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);

function _bootstrap() {
  const dir = mkdtempSync(join(tmpdir(), 'search-query-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
  for (const key of Object.keys(require_.cache)) {
    if (key.includes('/db/') || key.includes('/lib/')) delete require_.cache[key];
  }
  require_('../../db/connection');
  require_('../../db/migrations').runMigrations();
  return {
    dir,
    search: require_('../../lib/search'),
    teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch (_e) {} },
  };
}

test('buildMatchQuery: Single-Token sanitized + quoted', () => {
  const { search, teardown } = _bootstrap();
  try {
    assert.equal(search.buildMatchQuery('hallo'), '"hallo"*');
    assert.equal(search.buildMatchQuery('  hallo  '), '"hallo"*');
  } finally { teardown(); }
});

test('buildMatchQuery: AND-Verkettung mehrerer Tokens', () => {
  const { search, teardown } = _bootstrap();
  try {
    assert.equal(search.buildMatchQuery('alpha beta'), '"alpha"* "beta"*');
  } finally { teardown(); }
});

test('buildMatchQuery: Phrase mit Anfuehrungszeichen', () => {
  const { search, teardown } = _bootstrap();
  try {
    assert.equal(search.buildMatchQuery('"hallo welt"'), '"hallo welt"');
    assert.equal(search.buildMatchQuery('alpha "hallo welt" beta'),
      '"hallo welt" "alpha"* "beta"*');
  } finally { teardown(); }
});

test('buildMatchQuery: Negation via -prefix', () => {
  const { search, teardown } = _bootstrap();
  try {
    // FTS5 kennt kein vorangestelltes Minus (wirft «no such column»), nur NOT.
    assert.equal(search.buildMatchQuery('alpha -beta'), '("alpha"*) NOT "beta"');
    assert.equal(search.buildMatchQuery('alpha -beta -gamma'), '("alpha"*) NOT "beta" NOT "gamma"');
    // Ausgeschlossene Phrase bleibt ausgeschlossen (nicht positiv gesucht).
    assert.equal(search.buildMatchQuery('-"Hans Peter" anna'), '("anna"*) NOT "Hans Peter"');
    // Nur Ausschluesse: nichts, wovon ausgeschlossen werden koennte.
    assert.equal(search.buildMatchQuery('-beta'), '');
  } finally { teardown(); }
});

test('buildMatchQuery: Prefix-Match via trailing *', () => {
  const { search, teardown } = _bootstrap();
  try {
    assert.equal(search.buildMatchQuery('schwert*'), '"schwert"*');
  } finally { teardown(); }
});

test('buildMatchQuery: Spezialzeichen werden gestrippt — kein FTS5-Syntax-Error', () => {
  const { search, teardown } = _bootstrap();
  try {
    // SQL-Syntax-Versuch: Quote + Semicolon + AND-Operator. Alles raus.
    const out = search.buildMatchQuery(`'; DROP TABLE search_index; --`);
    assert.match(out, /^"DROP"\* "TABLE"\* "search_index"\*$/);
    // Klammer/Punkt/Komma werden gestrippt.
    assert.equal(search.buildMatchQuery('(alpha, beta).'), '"alpha"* "beta"*');
  } finally { teardown(); }
});

test('buildMatchQuery: leere/zu kurze Tokens werden verworfen', () => {
  const { search, teardown } = _bootstrap();
  try {
    assert.equal(search.buildMatchQuery(''), '');
    assert.equal(search.buildMatchQuery('   '), '');
    // Einzelner Buchstabe < 2 Zeichen.
    assert.equal(search.buildMatchQuery('a b cd'), '"cd"');
  } finally { teardown(); }
});

test('htmlToText: identisch zu sync/page-revisions Normalisierung', () => {
  const { search, teardown } = _bootstrap();
  try {
    assert.equal(search.htmlToText('<p>Hallo  <b>Welt</b></p>'), 'Hallo Welt');
    assert.equal(search.htmlToText('<p>A</p><p>B</p>'), 'A B');
    assert.equal(search.htmlToText('  '), '');
    assert.equal(search.htmlToText(null), '');
    assert.equal(search.htmlToText(undefined), '');
  } finally { teardown(); }
});

test('query: Empty-Input liefert leere Hits', () => {
  const { search, teardown } = _bootstrap();
  try {
    const r1 = search.query('');
    assert.deepEqual(r1, { hits: [], fallback: false, more: false });
    const r2 = search.query('   ');
    assert.deepEqual(r2, { hits: [], fallback: false, more: false });
  } finally { teardown(); }
});

test('query: book_id-Filter geht durch + Empty-allowedBookIds short-circuits', () => {
  const { search, teardown } = _bootstrap();
  try {
    // Bei leerer Allowlist (kein Buch-Zugang) keine Treffer.
    const r = search.query('hallo', { allowedBookIds: [] });
    assert.deepEqual(r, { hits: [], fallback: false, more: false });
  } finally { teardown(); }
});

// nav_id = ID, mit der die Oberflaeche einen Treffer oeffnet. Fuer Figuren und
// Schauplaetze ist das NICHT der PK, den der Index fuehrt, sondern die TEXT-ID
// (fig_id/loc_id) — nur die kennen die Katalog-Listen und der Deep-Link-Hash.
// Ohne die Aufloesung oeffnet ein Klick auf einen Volltext-Treffer die Karte,
// ohne dass die Zeile darin je aufgeht.
test('attachNavIds: figure/location bekommen ihre TEXT-ID, der Rest den PK', () => {
  const { search, teardown } = _bootstrap();
  try {
    const { db } = require_('../../db/connection');
    db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (7, 'Buch', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO figures (id, book_id, fig_id, name, updated_at) VALUES (11, 7, 'fig_abc', 'Gerold', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO locations (id, book_id, loc_id, name, updated_at) VALUES (22, 7, 'loc_xyz', 'Schloss', '2026-01-01T00:00:00.000Z')").run();

    const rows = search.attachNavIds([
      { kind: 'figure', entity_id: 11 },
      { kind: 'location', entity_id: 22 },
      { kind: 'page', entity_id: 33 },
      { kind: 'scene', entity_id: 44 },
      // Geloeschte Entitaet: kein Treffer in der Tabelle → PK bleibt stehen,
      // statt dass das Feld fehlt und der Aufrufer stillschweigend `undefined`
      // in die URL schreibt.
      { kind: 'figure', entity_id: 999 },
    ]);

    assert.equal(rows[0].nav_id, 'fig_abc');
    assert.equal(rows[1].nav_id, 'loc_xyz');
    assert.equal(rows[2].nav_id, 33);
    assert.equal(rows[3].nav_id, 44);
    assert.equal(rows[4].nav_id, 999);
    // entity_id bleibt unangetastet — daran haengen die Server-Konsumenten.
    assert.equal(rows[0].entity_id, 11);
  } finally { teardown(); }
});

test('buildMatchQuery anyTerms: ODER ohne Füllwörter, Phrasen bleiben, Negation fällt weg', () => {
  const { search, teardown } = _bootstrap();
  try {
    const q = search.buildMatchQuery('Wo trifft Anna ihren Bruder "zum ersten Mal"? -Streit', { anyTerms: true });
    assert.equal(q, '"zum ersten Mal" OR "trifft" OR "Bruder" OR "Anna"');
    assert.equal(search.buildMatchQuery('die und der', { anyTerms: true }), '');
    // Deckel auf die längsten Wörter.
    const many = Array.from({ length: 30 }, (_, i) => `wort${String(i).padStart(2, '0')}${'x'.repeat(i % 5)}`).join(' ');
    assert.equal(search.buildMatchQuery(many, { anyTerms: true }).split(' OR ').length, 16);
    // Ohne anyTerms bleibt das UND-Verhalten (mit Auto-Prefix).
    assert.equal(search.buildMatchQuery('Anna Bruder'), '"Anna"* "Bruder"*');
  } finally { teardown(); }
});

test('buildMatchQuery: Auto-Prefix ab 3 Zeichen, 2-Zeichen-Woerter exakt', () => {
  const { search, teardown } = _bootstrap();
  try {
    assert.equal(search.buildMatchQuery('ab'), '"ab"');
    assert.equal(search.buildMatchQuery('abc'), '"abc"*');
    assert.equal(search.buildMatchQuery('ab*'), '"ab"*');
  } finally { teardown(); }
});

test('buildMatchQuery: ß und ss sind gleichwertig', () => {
  const { search, teardown } = _bootstrap();
  try {
    assert.equal(search.buildMatchQuery('Strasse'), '("Strasse"* OR "straße"*)');
    assert.equal(search.buildMatchQuery('Straße'), '("Straße"* OR "strasse"*)');
    assert.equal(search.buildMatchQuery('Gruss', { anyTerms: true }), '("Gruss" OR "gruß")');
  } finally { teardown(); }
});

// Index-Ebene: rowid-Upsert, User-Scope, Bindestrich-Tokenisierung, Folgeseiten.
function _seed(db) {
  const ts = '2026-01-01T00:00:00.000Z';
  db.prepare("INSERT INTO app_users (email, created_at) VALUES ('a@x.ch', ?), ('b@x.ch', ?)").run(ts, ts);
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (7, ?, ?, ?)').run('Buch', ts, ts);
  db.prepare('INSERT INTO pages (page_id, book_id, page_name, body_html, updated_at) VALUES (?, 7, ?, ?, ?)')
    .run(1, 'Garten', '<p>Anna trifft Hans-Peter an der Straße.</p>', ts);
  db.prepare('INSERT INTO pages (page_id, book_id, page_name, body_html, updated_at) VALUES (?, 7, ?, ?, ?)')
    .run(2, 'Annas Tag', '<p>Anna allein.</p>', ts);
  db.prepare("INSERT INTO figures (id, book_id, fig_id, name, user_email, updated_at) VALUES (11, 7, 'fig_1', 'Anna', 'a@x.ch', ?)").run(ts);
  db.prepare("INSERT INTO figures (id, book_id, fig_id, name, user_email, updated_at) VALUES (12, 7, 'fig_1', 'Anna', 'b@x.ch', ?)").run(ts);
}

test('query: Ausschluss, Prefix, Bindestrich-Teilwort, ß/ss gegen echten Index', () => {
  const { search, teardown } = _bootstrap();
  try {
    const { db } = require_('../../db/connection');
    _seed(db);
    search.reindexAll();
    const ids = (q) => search.query(q, { bookId: 7, kinds: ['page'] }).hits.map(h => h.entity_id).sort();
    assert.deepEqual(ids('Anna'), [1, 2]);
    assert.deepEqual(ids('anna -hans'), [2]);
    assert.deepEqual(ids('Hans'), [1]);
    assert.deepEqual(ids('Hans-Peter'), [1]);
    assert.deepEqual(ids('Strasse'), [1]);
    assert.deepEqual(ids('-anna'), []);
  } finally { teardown(); }
});

test('query: Daten pro User nur aus dem eigenen Bestand (Option user)', () => {
  const { search, teardown } = _bootstrap();
  try {
    const { db } = require_('../../db/connection');
    _seed(db);
    search.reindexAll();
    const figs = (opts) => search.query('Anna', { bookId: 7, kinds: ['figure', 'page'], ...opts })
      .hits.filter(h => h.kind === 'figure').map(h => h.entity_id).sort();
    assert.deepEqual(figs({ user: 'a@x.ch' }), [11]);
    assert.deepEqual(figs({ user: 'b@x.ch' }), [12]);
    // Ohne Option ungefiltert (Server-Konsumenten skopieren selbst).
    assert.deepEqual(figs({}), [11, 12]);
    // Abschnitte gehoeren dem Buch, nicht dem User.
    assert.equal(search.query('Anna', { bookId: 7, kinds: ['page'], user: 'a@x.ch' }).hits.length, 2);
  } finally { teardown(); }
});

test('query: more-Flag, leere Folgeseite ohne Trigram-Fallback', () => {
  const { search, teardown } = _bootstrap();
  try {
    const { db } = require_('../../db/connection');
    _seed(db);
    search.reindexAll();
    const first = search.query('Anna', { bookId: 7, kinds: ['page'], limit: 1 });
    assert.equal(first.hits.length, 1);
    assert.equal(first.more, true);
    const second = search.query('Anna', { bookId: 7, kinds: ['page'], limit: 1, offset: 1 });
    assert.equal(second.more, false);
    const past = search.query('Annas', { bookId: 7, kinds: ['page'], offset: 10 });
    assert.deepEqual(past, { hits: [], fallback: false, more: false });
  } finally { teardown(); }
});

test('upsert/remove per rowid: Aktualisieren ersetzt, Entfernen loescht genau die Zeile', () => {
  const { search, teardown } = _bootstrap();
  try {
    const { db } = require_('../../db/connection');
    _seed(db);
    search.reindexAll();
    db.prepare("UPDATE pages SET body_html = '<p>Bruno allein.</p>' WHERE page_id = 2").run();
    search.upsertPage(2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM search_index WHERE kind = 'page' AND entity_id = 2").get().n, 1);
    assert.deepEqual(search.query('Bruno', { bookId: 7, kinds: ['page'] }).hits.map(h => h.entity_id), [2]);
    search.remove('page', 2);
    assert.equal(search.query('Bruno', { bookId: 7, kinds: ['page'] }).hits.length, 0);
    assert.deepEqual(search.query('Anna', { bookId: 7, kinds: ['page'] }).hits.map(h => h.entity_id), [1]);
  } finally { teardown(); }
});
