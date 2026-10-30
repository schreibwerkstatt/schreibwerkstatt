'use strict';
// Buch-Metadaten haben genau einen Ort (Root-CLAUDE.md, „Buch-Metadaten").
// OWNERS ordnet jedem Buchthema seine Tabelle zu; das Gate faengt die zweite
// Kopie ab, bevor sie Daten sammelt:
//   1. keine OWNERS-Spalte (oder ein bekannter Ausweichname) in einer fremden
//      Tabelle — ausser den begruendeten Ausnahmen in FOREIGN_OK,
//   2. keine Spalte zugleich in book_settings und book_publication,
//   3. kein Publikationstext / keine Reihe als eigenes Feld in einem
//      PDF-/DOCX-Profil.
// Neues Buchthema ⇒ eine OWNERS-Zeile. Why: Klappentext (book_publication,
// books.description, coverSpec.blurb) und Reihe (book_publication.series neben
// book_series) lagen doppelt, und nichts glich die Kopien ab.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('book-meta-single-place');

require('../../db/migrations');
const { db } = require('../../db/connection');
const pdfDefaults = require('../../lib/pdf-export-defaults');
const docxDefaults = require('../../lib/docx-export-defaults');

// Thema → Besitzer-Tabelle(n), Spalten, Ausweichnamen, unter denen dasselbe
// erfahrungsgemaess ein zweites Mal entsteht.
const OWNERS = [
  { thema: 'Klappentext',     tables: ['book_publication'], columns: [],   aliases: ['blurb', 'klappentext'] },
  { thema: 'Cover',           tables: ['book_publication'], columns: ['cover_image', 'cover_mime'], aliases: [] },
  { thema: 'Autorfoto',       tables: ['book_publication'], columns: ['author_image', 'author_image_mime'], aliases: [] },
  { thema: 'Autorname',       tables: ['book_publication'], columns: ['author_name', 'author_file_as', 'co_authors'], aliases: [] },
  { thema: 'Vita',            tables: ['book_publication'], columns: ['author_bio'], aliases: ['vita'] },
  { thema: 'Titelei',         tables: ['book_publication'], columns: ['isbn', 'subtitle', 'year', 'dedication', 'imprint', 'copyright', 'frontmatter', 'extra_sections'], aliases: [] },
  { thema: 'Buchhandel',      tables: ['book_publication'], columns: ['publisher', 'keywords', 'zielgruppe', 'vergleichstitel'], aliases: [] },
  { thema: 'Reihe',           tables: ['book_series', 'book_series_members'], columns: [], aliases: ['series', 'series_index', 'series_name', 'band_nr', 'volume'] },
  { thema: 'Sprache/Region',  tables: ['book_settings'], columns: ['language', 'region'], aliases: [] },
  { thema: 'Buchtyp',         tables: ['book_settings'], columns: ['buchtyp', 'textsorte'], aliases: [] },
  { thema: 'Erzählweise',     tables: ['book_settings'], columns: ['erzaehlperspektive', 'erzaehlzeit', 'stilprofil'], aliases: [] },
  { thema: 'Schulsystem',     tables: ['book_settings'], columns: ['schulsystem_json'], aliases: ['schulsystem', 'school_system'] },
  { thema: 'Handlungsjahr',   tables: ['book_settings'], columns: ['handlungsjahr'], aliases: ['story_year', 'handlungszeit'] },
];

// Gleicher Spaltenname, anderer Gegenstand — jeweils mit Begruendung.
const FOREIGN_OK = {
  'sources.publisher': 'Verlag eines zitierten Werks, nicht dieses Buchs',
  'sources.isbn':      'ISBN eines zitierten Werks',
  'sources.volume':    'Band eines zitierten Werks',
  'sources.year':      'Erscheinungsjahr eines zitierten Werks',
  'app_users.language': 'UI-Sprache des Kontos / Vorgabe fuer neue Buecher',
  'app_users.default_language': 'Vorgabe fuer neue Buecher',
  'book_lexicon.language': 'Cache: Sprache, mit der die Wortschatz-Analyse lief',
  'page_textsorte.textsorte': 'Abschnitts-Override, Buch-Default in book_settings',
  'page_structure_checks.textsorte': 'Cache: Textsorte, gegen die geprueft wurde',
  'chapter_narrative_profile.erzaehlzeit': 'Analyse-Ergebnis je Kapitel, nicht die Angabe des Autors',
};

const TECHNICAL = new Set(['book_id', 'created_at', 'updated_at']);

function allTables() {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all().map(r => r.name);
}

function columns(table) {
  try { return db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name); }
  catch { return []; }   // FTS5-Virtual-Tables o. ae.
}

const snake = s => s.replace(/[A-Z]/g, m => '_' + m.toLowerCase());

// Blatt-Pfade mit String-Default. Boolesche Schalter (docx frontmatter.dedication
// = „Widmung mitdrucken") sind keine Kopie des Inhalts.
function stringLeaves(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) return stringLeaves(v, `${prefix}${k}.`);
    return typeof v === 'string' ? [{ path: prefix + k, name: snake(k) }] : [];
  });
}

test('OWNERS stimmt mit dem Schema überein', () => {
  for (const o of OWNERS) {
    for (const t of o.tables) assert.ok(columns(t).length, `${o.thema}: Tabelle ${t} fehlt`);
    for (const c of o.columns) assert.ok(columns(o.tables[0]).includes(c), `${o.thema}: ${o.tables[0]}.${c} fehlt`);
  }
});

test('jedes Buchthema hat genau einen Ort (OWNERS)', () => {
  const hits = [];
  const tables = allTables();
  for (const o of OWNERS) {
    const names = new Set([...o.columns, ...o.aliases]);
    for (const t of tables) {
      if (o.tables.includes(t)) continue;
      for (const c of columns(t)) {
        if (names.has(c) && !FOREIGN_OK[`${t}.${c}`]) hits.push(`${o.thema}: ${t}.${c} (Ort: ${o.tables.join('/')})`);
      }
    }
  }
  assert.deepEqual(hits, [], 'Zweite Kopie eines Buchthemas — vom Besitzer lesen statt speichern, '
    + 'oder bei anderem Gegenstand mit Begruendung in FOREIGN_OK');
});

test('keine Spalte zugleich in book_settings und book_publication', () => {
  const pub = new Set(columns('book_publication'));
  const both = columns('book_settings').filter(c => !TECHNICAL.has(c) && pub.has(c));
  assert.deepEqual(both, []);
});

test('books traegt keine Beschreibung', () => {
  assert.ok(!columns('books').includes('description'), 'Klappentext lebt in book_publication.description');
});

test('PDF-/DOCX-Profile tragen keine Publikationstexte als eigenes Feld', () => {
  const forbidden = new Set(['description', ...OWNERS.flatMap(o => [...o.columns, ...o.aliases])]);
  const hits = [
    ...stringLeaves(pdfDefaults.defaultConfig()).map(l => ({ ...l, profile: 'pdf' })),
    ...stringLeaves(docxDefaults.defaultConfig()).map(l => ({ ...l, profile: 'docx' })),
  ].filter(l => forbidden.has(l.name)).map(l => `${l.profile}: ${l.path}`);
  assert.deepEqual(hits, [], 'Titelei/Klappentext/Reihe aus dem Besitzer spiegeln, nicht im Profil speichern');
});
