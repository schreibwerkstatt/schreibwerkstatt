'use strict';
// Wächter «Neue Buchdaten reisen mit» (docs/book-migration.md#neue-buchdaten).
//
// Jede Tabelle, die über eine Fremdschlüssel-Kette an `books` hängt, ist genau
// eines von beiden:
//   a) im `.swbook` — in WERK_TABLES (db/book-migration-data/werk.js, der
//      generische Kopierer: Standardweg für neue Tabellen) oder vom Code der
//      handgeschriebenen Blöcke (SWBOOK_SOURCES) genannt, oder
//   b) begründet ausgenommen — Eintrag in NICHT_IM_BUNDLE mit einer Kategorie.
// Eine neue Buch-Tabelle ohne beides macht diesen Test rot. Dann: in
// WERK_TABLES aufnehmen (an der Stelle der Abhängigkeitsfolge) + Rundlauf-Fall oder,
// wenn sie bewusst nicht reist, hier mit Kategorie eintragen.
//
// Fassungen sind Text, Bucheinstellungen und Publikation; Analyse und Lektorat
// frieren sie über collectExtras mit ein — der letzte Test sichert diese Kopplung.
//
// Kategorie `luecke` steht auf 0 (MAX_LUECKEN): was am Buch hängt und weder
// Cache, Protokoll, Instanz, Verlauf, Vorliebe noch Inhalt ist, reist mit.
//
// Abgleich über den Tabellennamen im Code: grob, aber genau die Stelle, an der
// es bisher still riss (Berufsweg/Hobbys, Schulweg-Vorband).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { SQUASHED_SCHEMA } = require('../../db/squashed-schema');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// werk.js lädt die DB-Verbindung: Wegwerf-DB vor dem ersten require von db/….
const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('book-data-portability');
const { WERK_TABLES } = require('../../db/book-migration-data/werk');

// Code der handgeschriebenen Blöcke (Analyse, Lektorat, Chats, Recherche,
// Figuren-Zusätze). Der generische Werk-Block zählt über WERK_TABLES, nicht über
// Namen im Code — dort stehen Tabellen auch als Lesequelle oder im Kommentar.
const SWBOOK_SOURCES = [
  'db/book-migration-data.js',
  ...fs.readdirSync(path.join(ROOT, 'db/book-migration-data')).filter(f => f !== 'werk.js').map(f => `db/book-migration-data/${f}`),
  'lib/book-bundle.js',
  'lib/bundle-apply.js',
  'routes/book-migration.js',
];

const KATEGORIEN = {
  inhalt:     'Buchinhalt über die Content-Store-Facade (book.json-Baum), nicht über den Tabellennamen',
  cache:      'abgeleitet aus Text oder Lauf — wird am Ziel neu berechnet',
  protokoll:  'Nutzungs-, Kosten- und Zeitprotokoll dieser Instanz',
  instanz:    'Zugriff, Freigaben, Verbindungen, Sperren, Präsenz — gehört zur Instanz, nicht zum Buch',
  verlauf:    'eigene Historie (Fassungen, Revisionen) — reist nicht in ein neues Buch',
  praeferenz: 'Ansichts-/Bedienvorliebe eines Users',
  luecke:     'sollte mitreisen, tut es noch nicht — Ratsche, nur schrumpfen',
};

const NICHT_IM_BUNDLE = {
  books: 'inhalt',

  book_extract_cache: 'cache', chapter_extract_cache: 'cache', ungrouped_extract_cache: 'cache',
  book_review_cache: 'cache', chapter_review_cache: 'cache', chapter_macro_review_cache: 'cache',
  ungrouped_review_cache: 'cache', lektorat_cache: 'cache', expose_synopsis_cache: 'cache',
  finetune_ai_cache: 'cache', motif_brainstorm_cache: 'cache', tagebuch_rueckblick_cache: 'cache',
  sync_media_cache: 'cache', semantic_chunks: 'cache', semantic_index_state: 'cache',
  chat_semantic_chunks: 'cache', job_checkpoints: 'cache', lexicon_ngrams: 'cache', lexicon_terms: 'cache',
  book_lexicon: 'cache', chapter_lexicon: 'cache', page_stats: 'cache', xref_anchors: 'cache',
  xref_links: 'cache', source_citations: 'cache', figure_idiolect: 'cache',
  idee_check_hints: 'cache', idee_check_baselines: 'cache',
  ai_proposals: 'cache', // offener KI-Vorschlag (Stilprofil), per Lauf neu erzeugbar

  ai_cost_ledger: 'protokoll', usage_events: 'protokoll', job_runs: 'protokoll', lektorat_time: 'protokoll',
  stt_time: 'protokoll', user_page_usage: 'protokoll', page_deletions: 'protokoll',
  share_views: 'protokoll', share_view_sections: 'protokoll',

  book_access: 'instanz', book_share_invites: 'instanz', blog_connections: 'instanz', blog_page_links: 'instanz',
  hubspot_connections: 'instanz', hubspot_page_links: 'instanz', page_locks: 'instanz',
  page_presence: 'instanz', book_presence: 'instanz', book_series_members: 'instanz',

  book_snapshots: 'verlauf', page_revisions: 'verlauf', page_editorial_status_events: 'verlauf',

  komplett_scope: 'praeferenz', book_shelf: 'praeferenz', motif_graph_layout: 'praeferenz',
};

/** Tabellen mit FK-Kette zu `books` (transitiv), aus dem End-Schema. */
function bookScopedTables() {
  const db = new Database(':memory:');
  db.exec(SQUASHED_SCHEMA);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all().map(r => r.name);
  const parents = {};
  for (const t of tables) {
    try { parents[t] = db.prepare(`PRAGMA foreign_key_list("${t}")`).all().map(f => f.table); }
    catch { parents[t] = []; } // FTS5-Virtual-Tables
  }
  db.close();
  const scoped = new Set(['books']);
  for (let changed = true; changed;) {
    changed = false;
    for (const t of tables) {
      if (!scoped.has(t) && parents[t].some(p => scoped.has(p))) { scoped.add(t); changed = true; }
    }
  }
  return [...scoped].sort();
}

const BUNDLE_CODE = SWBOOK_SOURCES.map(read).join('\n');
const imBundle = (t) => WERK_TABLES.includes(t) || new RegExp(`(?<![A-Za-z0-9_])${t}(?![A-Za-z0-9_])`).test(BUNDLE_CODE);

test('jede Buch-Tabelle ist im .swbook oder begründet ausgenommen', () => {
  const scoped = bookScopedTables();
  assert.ok(scoped.length > 100, `FK-Kette gefunden (${scoped.length} Tabellen)`);
  const offen = scoped.filter(t => !imBundle(t) && !NICHT_IM_BUNDLE[t]);
  assert.deepEqual(offen, [],
    `Neue Buch-Tabelle(n) ohne Weg ins .swbook: ${offen.join(', ')}.\n`
    + 'In db/book-migration-data* sammeln und einspielen (+ Rundlauf-Test in tests/integration/book-import.test.js) '
    + 'oder in NICHT_IM_BUNDLE mit Kategorie eintragen — siehe docs/book-migration.md#neue-buchdaten.');
});

test('Ausnahmeliste ist aktuell: keine geschlossene Lücke, keine tote Zeile, nur bekannte Kategorien', () => {
  const scoped = new Set(bookScopedTables());
  const tot = Object.keys(NICHT_IM_BUNDLE).filter(t => !scoped.has(t));
  assert.deepEqual(tot, [], `Ausnahme für Tabellen ohne Buch-Bezug oder ohne Tabelle: ${tot.join(', ')}`);
  const schonDrin = Object.keys(NICHT_IM_BUNDLE).filter(imBundle);
  assert.deepEqual(schonDrin, [], `Reist schon mit — aus NICHT_IM_BUNDLE streichen: ${schonDrin.join(', ')}`);
  const unbekannt = Object.entries(NICHT_IM_BUNDLE).filter(([, k]) => !KATEGORIEN[k]).map(([t]) => t);
  assert.deepEqual(unbekannt, []);
});

test('Lücken-Ratsche: die Zahl offener Lücken steigt nicht', () => {
  const MAX_LUECKEN = 0;
  const n = Object.values(NICHT_IM_BUNDLE).filter(k => k === 'luecke').length;
  assert.ok(n <= MAX_LUECKEN, `${n} Lücken > ${MAX_LUECKEN} — eine neue Tabelle gehört ins .swbook, nicht in die Lücken-Liste`);
});

test('Fassungen frieren Analyse- und Lektorat-Block über collectExtras ein', () => {
  const payload = read('routes/snapshots/payload.js');
  assert.match(payload, /collectExtras\(\s*bookId\s*,\s*\{\s*analysis:\s*true\s*,\s*lektorat:\s*true\s*\}/,
    'routes/snapshots/payload.js muss collectExtras(bookId, { analysis: true, lektorat: true }) rufen — sonst reist ein neuer Block-Eintrag nur ins .swbook');
  const facade = read('db/book-migration-data.js');
  assert.match(facade, /out\.analysis = collectAnalysis\(/, 'collectExtras sammelt den Analyse-Block über collectAnalysis');
  assert.match(facade, /if \(lektorat\) out\.lektorat = collectLektorat\(/, 'collectExtras sammelt den Lektorat-Block');
});
