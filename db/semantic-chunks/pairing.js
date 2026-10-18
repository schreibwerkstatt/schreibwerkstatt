'use strict';
// Massenleser über semantic_chunks für die Analysen, die die Wolke als Ganzes
// lesen statt nach Nachbarn zu fragen: Redundanz-Radar (All-Pairs-Cosinus,
// Figuren-Dubletten) und Buchlandkarte. Re-exportiert von db/semantic-chunks.js
// (Facade); ausgelagert wegen des LOC-Caps. Nur lesend — Schreibwege bleiben im
// Hauptmodul (dessen Vektor-Cache hängt an ihnen).

const { db } = require('../connection');
const { blobToVector } = require('../../lib/embed-chunk');

// Volle Zeilen (mit Text) für den Redundanz-Radar. ORDER BY macht dessen
// MAX_CHUNKS-Kappung deterministisch: ohne stabile Reihenfolge schnitte .slice()
// in SQLite-rowid-Ordnung, und welche Passagen bei einem Buch über dem Cap
// fehlen, wäre zwischen Läufen nicht reproduzierbar.
const _selBookKinds = db.prepare(
  'SELECT kind, entity_id, chunk_ix, text, vector FROM semantic_chunks WHERE book_id = ? AND model = ? ORDER BY entity_id, chunk_ix'
);

// Alle Chunks eines Buches unter einem Modell für den Redundanz-Radar laden:
// pro Chunk { entity_id, chunk_ix, text, vector:Float32Array }, gefiltert auf die
// angegebenen kinds (Redundanz vergleicht nur Seiten). Basis des All-Pairs-
// Cosinus in lib/redundancy.js — kein Embedding-Call, die Vektoren liegen schon.
function loadChunksForPairing(bookId, model, kinds = ['page']) {
  const kindSet = new Set(kinds);
  const out = [];
  for (const r of _selBookKinds.all(bookId, model)) {
    if (!kindSet.has(r.kind)) continue;
    out.push({ entity_id: r.entity_id, chunk_ix: r.chunk_ix, text: r.text, vector: blobToVector(r.vector) });
  }
  return out;
}

// Gemittelte Profil-Vektoren aller Figuren eines Buchs für den Figuren-Dubletten-
// Radar (lib/redundancy.js#findFigureDuplicates). EIN Vektor je Figur (Mittel über
// ihre Chunks unter model). Der JOIN auf figures scoped auf den anfragenden User
// und filtert stale-Figuren — der embed-index indexiert Figuren buchweit über alle
// User und OHNE stale-Filter, ein ungefilterter Vergleich brächte Fremd-User- und
// verwaiste Figuren als Falsch-Treffer. Rückgabe: [{ id, fig_id, name, vector:Float32Array }]
// (`fig_id` = öffentliche Kennung, Katalog-`id` im Frontend).
function loadFigureVectorsForPairing(bookId, userEmail, model) {
  const rows = db.prepare(`
    SELECT sc.entity_id, sc.vector, f.name, f.fig_id
      FROM semantic_chunks sc
      JOIN figures f ON f.id = sc.entity_id
     WHERE sc.book_id = ? AND sc.model = ? AND sc.kind = 'figure'
       AND f.book_id = ? AND f.user_email IS ? AND f.stale = 0
     ORDER BY sc.entity_id, sc.chunk_ix
  `).all(bookId, model, bookId, userEmail || null);
  const acc = new Map(); // entity_id → { name, fig_id, sum:Float32Array, count }
  for (const r of rows) {
    const v = blobToVector(r.vector);
    let e = acc.get(r.entity_id);
    if (!e) { e = { name: r.name, fig_id: r.fig_id, sum: new Float32Array(v.length), count: 0 }; acc.set(r.entity_id, e); }
    if (v.length !== e.sum.length) continue; // Fremdmodell-Rest überspringen
    for (let i = 0; i < v.length; i++) e.sum[i] += v[i];
    e.count++;
  }
  const out = [];
  for (const [id, e] of acc) {
    if (!e.count) continue;
    const vec = new Float32Array(e.sum.length);
    for (let i = 0; i < vec.length; i++) vec[i] = e.sum[i] / e.count;
    out.push({ id, fig_id: e.fig_id, name: e.name, vector: vec });
  }
  return out;
}

// Seiten-Chunks eines Buchs samt KAPITEL-Zuordnung fuer die Buchlandkarte
// (lib/book-map.js). Wie loadChunksForPairing, aber mit `chapter_id` — die Karte
// gruppiert und faerbt nach Kapitel, und die Kohaesions-Kennzahl braucht die
// Zuordnung ueberhaupt erst.
//
// Der JOIN auf `pages` ist der sanktionierte Fall der Content-Store-Regel: eine
// abgeleitete Tabelle braucht zur Lesezeit einen Wert aus `pages`, und die
// Abfrage liegt darum in ihrem eigenen db/-Modul statt im Handler (Muster
// db/sources/citations.js#listSourceCitations). Es kommt bewusst KEIN Seiten-NAME
// mit: den loest das Frontend aus der ohnehin geladenen Navigationsliste auf
// (gleiche Regel wie beim Redundanz-Radar), und eine Snapshot-Spalte waere hier
// erst recht falsch.
//
// `book_id` doppelt geprueft (an den Chunks UND an der Seite): Chunks und Seite
// muessen im selben Buch liegen, sonst gehoert der Punkt nicht in diese Landkarte.
// Rueckgabe: [{ entity_id, chunk_ix, chapter_id, text, vector:Float32Array }].
function loadPageChunksWithChapter(bookId, model) {
  const rows = db.prepare(`
    SELECT sc.entity_id, sc.chunk_ix, sc.text, sc.vector, p.chapter_id
      FROM semantic_chunks sc
      JOIN pages p ON p.page_id = sc.entity_id
     WHERE sc.book_id = ? AND sc.model = ? AND sc.kind = 'page'
       AND p.book_id = ?
     ORDER BY sc.entity_id, sc.chunk_ix
  `).all(bookId, model, bookId);
  return rows.map(r => ({
    entity_id: r.entity_id,
    chunk_ix: r.chunk_ix,
    chapter_id: r.chapter_id ?? null,
    text: r.text,
    vector: blobToVector(r.vector),
  }));
}

// Pol-Kandidaten der Buchlandkarte: Figuren und Schauplätze des Users, die im
// Index dieses Buchs unter `model` liegen. Gleicher Scope wie die Figuren-
// Dubletten (eigener User, keine stale-Figur) — der Index führt Figuren und Orte
// buchweit über alle User. Der Name ist ein Auswahl-Label für den Pol-Wähler,
// keine Anzeige eines Ergebnisses.
// Rückgabe: [{ kind:'figure'|'location', id, name }], je Art nach Name sortiert.
function listPoleCandidates(bookId, userEmail, model) {
  const figs = db.prepare(`
    SELECT DISTINCT f.id, f.name FROM figures f
      JOIN semantic_chunks sc ON sc.kind = 'figure' AND sc.entity_id = f.id
     WHERE f.book_id = ? AND f.user_email IS ? AND f.stale = 0
       AND sc.book_id = ? AND sc.model = ?
     ORDER BY f.name COLLATE NOCASE
  `).all(bookId, userEmail || null, bookId, model);
  const locs = db.prepare(`
    SELECT DISTINCT l.id, l.name FROM locations l
      JOIN semantic_chunks sc ON sc.kind = 'location' AND sc.entity_id = l.id
     WHERE l.book_id = ? AND l.user_email IS ?
       AND sc.book_id = ? AND sc.model = ?
     ORDER BY l.name COLLATE NOCASE
  `).all(bookId, userEmail || null, bookId, model);
  return [
    ...figs.map(r => ({ kind: 'figure', id: r.id, name: r.name })),
    ...locs.map(r => ({ kind: 'location', id: r.id, name: r.name })),
  ];
}

// Gemittelter Vektor einer Figur oder eines Schauplatzes als Pol der
// Buchlandkarte — nur, wenn die Entität dem User gehört, im Buch liegt und
// unter `model` indiziert ist (sonst null). Die Besitzprüfung steckt im SQL,
// nicht beim Aufrufer: die Entitäts-ID kommt aus dem Request.
function loadPoleVector(bookId, userEmail, model, kind, entityId) {
  const table = kind === 'figure' ? 'figures' : kind === 'location' ? 'locations' : null;
  if (!table) return null;
  const staleCond = kind === 'figure' ? 'AND e.stale = 0' : '';
  const rows = db.prepare(`
    SELECT sc.vector FROM semantic_chunks sc
      JOIN ${table} e ON e.id = sc.entity_id
     WHERE sc.kind = ? AND sc.entity_id = ? AND sc.book_id = ? AND sc.model = ?
       AND e.book_id = ? AND e.user_email IS ? ${staleCond}
     ORDER BY sc.chunk_ix
  `).all(kind, entityId, bookId, model, bookId, userEmail || null);
  if (!rows.length) return null;
  let acc = null;
  let count = 0;
  for (const r of rows) {
    const v = blobToVector(r.vector);
    if (!acc) acc = new Float64Array(v.length);
    if (v.length !== acc.length) continue;
    for (let i = 0; i < v.length; i++) acc[i] += v[i];
    count++;
  }
  return count ? acc : null;
}

module.exports = {
  loadChunksForPairing, loadFigureVectorsForPairing, loadPageChunksWithChapter,
  listPoleCandidates, loadPoleVector,
};
