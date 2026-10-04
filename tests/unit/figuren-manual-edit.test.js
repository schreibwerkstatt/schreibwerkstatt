'use strict';
// Vom Autor gepflegte Figuren und Beziehungen ueberleben die Komplettanalyse
// (figures.manually_edited / ki_name, figure_relations.origin — Migration 313).
//
// Ablauf wie in der App: Analyse-Lauf → Katalog-GET → bearbeiteter Katalog-PUT
// (saveFigurenToDb matchBy 'figId') → naechster Analyse-Lauf (Reconcile identity).

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('figuren-manual-edit');
delete process.env.ADMIN_EMAIL;

require('../../db/migrations');
const { db } = require('../../db/connection');
const {
  saveFigurenToDb, rebuildFigureAppearances, listFigurenWithDetails, updateFigurenSoziogramm,
} = require('../../db/figures');
const { mergeFigures } = require('../../db/entity-merge');

const BOOK = 5101;
const USER = 'autor@x.ch';
const idMaps = { chNameToId: { 'Kapitel 1': 9101 }, pageNameToIdByChapter: {} };

test.before(() => {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO app_users (email, display_name) VALUES (?, ?)').run(USER, 'Autor');
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(BOOK, 'Testbuch', now, now, USER);
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(9101, BOOK, 'Kapitel 1', 0, now);
});

function _komplettLauf(figuren) {
  saveFigurenToDb(BOOK, figuren, USER, idMaps, { reconcile: true, onMissing: 'stale' });
  rebuildFigureAppearances(BOOK, USER, figuren, idMaps);
}
const _katalogPut = (figuren) =>
  saveFigurenToDb(BOOK, figuren, USER, null, { reconcile: true, matchBy: 'figId', onMissing: 'delete' });
const _get = () => listFigurenWithDetails(BOOK, USER).figuren;
const _row = (name) => db.prepare('SELECT * FROM figures WHERE book_id = ? AND name = ?').get(BOOK, name);
const _rels = () => db.prepare(`
  SELECT ff.name AS von, ft.name AS zu, r.typ, r.beschreibung, r.origin
  FROM figure_relations r JOIN figures ff ON ff.id = r.from_fig_id JOIN figures ft ON ft.id = r.to_fig_id
  WHERE r.book_id = ? ORDER BY ff.name, ft.name, r.typ`).all(BOOK);

// Analyse-Ergebnis: Paul ↔ Marta (KI-Beziehung), Lena ohne Beziehung. `variant` aendert
// die KI-Texte, damit sichtbar wird, was die Analyse ueberschreiben darf.
function _analyse(variant) {
  return [
    { id: 'fig_1', name: 'Paul Schmidt', typ: 'hauptfigur', beruf: 'Arzt', geschlecht: 'm',
      beschreibung: `KI-Beschreibung Paul ${variant}`, erste_erwaehnung: 'Kapitel 1',
      arc: { typ: 'wandlung', anfang: 'zaudernd', wendepunkte: [], ende: 'entschlossen' },
      kapitel: [{ name: 'Kapitel 1', haeufigkeit: 3 }], eigenschaften: [`ki-${variant}`],
      beziehungen: [{ figur_id: 'fig_2', typ: 'freund', beschreibung: `KI ${variant}` }] },
    { id: 'fig_2', name: 'Marta Klein', typ: 'nebenfigur', beruf: 'Lehrerin', geschlecht: 'w',
      beschreibung: `KI-Beschreibung Marta ${variant}`,
      kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], eigenschaften: [], beziehungen: [] },
    { id: 'fig_3', name: 'Lena Neu', typ: 'randfigur', beruf: 'Bäckerin', geschlecht: 'w',
      beschreibung: `KI-Beschreibung Lena ${variant}`,
      kapitel: [{ name: 'Kapitel 1', haeufigkeit: 1 }], eigenschaften: [], beziehungen: [] },
  ];
}

test('Katalog-PUT ohne Aenderung markiert nichts als manuell (Round-Trip GET→PUT)', () => {
  _komplettLauf(_analyse('A'));
  _katalogPut(_get());
  const rows = db.prepare('SELECT name, manually_edited FROM figures WHERE book_id = ?').all(BOOK);
  assert.ok(rows.every(r => r.manually_edited === 0), JSON.stringify(rows));
  assert.deepEqual(_rels().map(r => r.origin), ['ki'], 'unveraenderte KI-Beziehung bleibt ki');
});

test('Autorenaenderung + manuelle Beziehung ueberleben den naechsten Analyse-Lauf', () => {
  const paulIdVorher = _row('Paul Schmidt').id;
  const kat = _get();
  const paul = kat.find(f => f.name === 'Paul Schmidt');
  paul.name = 'Dr. Paul Schmidt';            // Umbenennung durch den Autor
  paul.beschreibung = 'Autor: Landarzt mit Geheimnis';
  paul.beruf = 'Landarzt';
  paul.eigenschaften = ['verschwiegen'];
  // Neue Beziehung von Hand: Paul → Lena; dazu dieselbe Beziehung, die die Analyse
  // spaeter zwischen Marta und Lena liefert (Dublettenpruefung).
  paul.beziehungen.push({ figur_id: kat.find(f => f.name === 'Lena Neu').id, typ: 'mentor', beschreibung: 'von Hand' });
  const marta = kat.find(f => f.name === 'Marta Klein');
  marta.beziehungen.push({ figur_id: kat.find(f => f.name === 'Lena Neu').id, typ: 'schwester', beschreibung: 'Autorin' });
  _katalogPut(kat);

  assert.equal(_row('Dr. Paul Schmidt').manually_edited, 1, 'geaenderte Figur markiert');
  assert.equal(_row('Marta Klein').manually_edited, 0, 'nur Beziehungen geaendert → Stammdaten nicht geschuetzt');
  assert.deepEqual(_rels().filter(r => r.origin === 'manual').map(r => `${r.von}>${r.zu}:${r.typ}`).sort(),
    ['Dr. Paul Schmidt>Lena Neu:mentor', 'Marta Klein>Lena Neu:schwester']);

  // Naechster Lauf: andere KI-Texte; Marta–Lena als KI-Beziehung (gleicher Typ wie die
  // manuelle, umgekehrte Richtung) und die Analyse kennt Paul unter seinem Textnamen.
  const lauf = _analyse('B');
  lauf[2].beziehungen = [{ figur_id: 'fig_2', typ: 'schwester', beschreibung: 'KI B' }];
  _komplettLauf(lauf);

  const p = _row('Dr. Paul Schmidt');
  assert.ok(p, 'Autorenname bleibt stehen');
  assert.equal(p.id, paulIdVorher, 'ueber ki_name wiedererkannt — gleiche figures.id');
  assert.equal(p.stale, 0, 'nicht «nicht mehr im Text»');
  assert.equal(p.ki_name, 'Paul Schmidt');
  assert.equal(p.beschreibung, 'Autor: Landarzt mit Geheimnis');
  assert.equal(p.beruf, 'Landarzt');
  assert.equal(p.manually_edited, 1);
  assert.equal(_row('Paul Schmidt'), undefined, 'keine Dublette unter dem Textnamen');
  const tags = db.prepare('SELECT tag FROM figure_tags WHERE figure_id = ?').all(p.id).map(r => r.tag);
  assert.deepEqual(tags, ['verschwiegen'], 'Eigenschaften des Autors bleiben');
  // Abgeleitete Daten aktualisiert die Analyse weiter.
  assert.equal(db.prepare('SELECT haeufigkeit FROM figure_appearances WHERE figure_id = ?').get(p.id)?.haeufigkeit, 3);

  assert.equal(_row('Marta Klein').beschreibung, 'KI-Beschreibung Marta B', 'nicht editierte Figur folgt der Analyse');

  const rels = _rels().map(r => `${r.von}>${r.zu}:${r.typ}:${r.origin}`);
  assert.deepEqual(rels.sort(), [
    'Dr. Paul Schmidt>Lena Neu:mentor:manual',
    'Dr. Paul Schmidt>Marta Klein:freund:ki',
    'Marta Klein>Lena Neu:schwester:manual',
  ].sort(), 'manuelle bleiben, KI neu aufgebaut, KI-Dublette der manuellen entfaellt');
  assert.equal(_rels().find(r => r.typ === 'freund').beschreibung, 'KI B', 'KI-Beziehung aus dem neuen Lauf');
});

test('Soziogramm-Nachlauf laesst Autorenfiguren und manuelle Beziehungen stehen', () => {
  const ids = Object.fromEntries(db.prepare('SELECT fig_id, name FROM figures WHERE book_id = ?').all(BOOK)
    .map(r => [r.name, r.fig_id]));
  db.prepare("UPDATE figures SET sozialschicht = 'autor' WHERE name = 'Dr. Paul Schmidt'").run();
  updateFigurenSoziogramm(BOOK,
    [{ fig_id: ids['Dr. Paul Schmidt'], sozialschicht: 'ki' }, { fig_id: ids['Marta Klein'], sozialschicht: 'ki' }],
    [{ from_fig_id: ids['Dr. Paul Schmidt'], to_fig_id: ids['Lena Neu'], machtverhaltnis: 2 },
     { from_fig_id: ids['Dr. Paul Schmidt'], to_fig_id: ids['Marta Klein'], machtverhaltnis: 1 }],
    USER);
  assert.equal(_row('Dr. Paul Schmidt').sozialschicht, 'autor');
  assert.equal(_row('Marta Klein').sozialschicht, 'ki');
  const macht = db.prepare('SELECT typ, machtverhaltnis FROM figure_relations WHERE book_id = ? ORDER BY typ').all(BOOK);
  assert.equal(macht.find(r => r.typ === 'mentor').machtverhaltnis, null, 'manuelle Beziehung unberuehrt');
  assert.equal(macht.find(r => r.typ === 'freund').machtverhaltnis, 1);
});

test('Katalog-PUT: geaenderte KI-Beziehung wird manual, zweiter Typ auf demselben Paar bleibt', () => {
  const kat = _get();
  const paul = kat.find(f => f.name === 'Dr. Paul Schmidt');
  paul.beziehungen.find(b => b.typ === 'freund').beschreibung = 'praezisiert vom Autor';
  paul.beziehungen.push({ figur_id: kat.find(f => f.name === 'Marta Klein').id, typ: 'rivale', beschreibung: 'zweiter Typ' });
  _katalogPut(kat);
  const byTyp = Object.fromEntries(_rels().map(r => [r.typ, r.origin]));
  assert.equal(byTyp.freund, 'manual');
  assert.equal(byTyp.rivale, 'manual');
  assert.equal(byTyp.mentor, 'manual');
});

test('Merge: manuelle Beziehung der Quelle setzt sich gegen gleiche KI-Beziehung am Ziel durch', () => {
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO figures (book_id, user_email, fig_id, name, sort_order, updated_at, manually_edited)
    VALUES (?, ?, ?, ?, 9, ?, ?)`);
  const src = ins.run(BOOK, USER, 'fig_x', 'Paulchen', now, 1).lastInsertRowid;
  const tgt = ins.run(BOOK, USER, 'fig_y', 'Paul Zwilling', now, 0).lastInsertRowid;
  const lena = _row('Lena Neu').id;
  const rel = db.prepare(`INSERT INTO figure_relations (book_id, user_email, from_fig_id, to_fig_id, typ, origin)
    VALUES (?, ?, ?, ?, 'onkel', ?)`);
  rel.run(BOOK, USER, src, lena, 'manual');
  rel.run(BOOK, USER, tgt, lena, 'ki');
  mergeFigures(BOOK, USER, src, tgt);
  const rows = db.prepare("SELECT origin FROM figure_relations WHERE from_fig_id = ? AND typ = 'onkel'").all(tgt);
  assert.deepEqual(rows.map(r => r.origin), ['manual']);
  assert.equal(db.prepare('SELECT manually_edited FROM figures WHERE id = ?').get(tgt).manually_edited, 1,
    'Schutz der Quelle wandert ans Ziel');
});
