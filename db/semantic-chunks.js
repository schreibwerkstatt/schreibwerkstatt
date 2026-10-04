'use strict';
// Datenzugriff auf semantic_chunks (semantische Suche). Der Vektor liegt als
// Float32-BLOB; (De)Serialisierung + Cosinus kommen aus lib/embed-chunk.js.
// Reiner Ableitungs-Index — jederzeit über routes/jobs/embed-index.js neu
// berechenbar.
//
// Die Quell-Entität hängt an einer der sechs typisierten Spalten page_id/scene_id/
// figure_id/research_item_id/location_id/world_fact_id (CASCADE-FK, passend zu
// `kind` per CHECK erzwungen) —
// ein Entity- oder Buch-Delete räumt seine Vektoren selbst auf. Gelesen wird
// polymorph über die generierte Spalte entity_id (COALESCE der sechs), geschrieben
// ausschliesslich über die typisierten Spalten; _entityCols() ist der einzige
// Übersetzer dafür.
// pruneMissing() bleibt zuständig für Entitäten, die noch existieren, aber nicht
// mehr indizierbar sind (stale-Figur/-Schauplatz) — das deckt kein FK ab. Eine in
// ein anderes Buch verschobene Seite verliert ihre Chunks sofort (content-store
// movePage → remove), weil sie sonst bis zum nächsten Lauf im alten Buch auffindbar
// bliebe.
//
// semantic_index_state hält pro (Buch, Modell) das Ende des letzten VOLLSTÄNDIGEN
// Index-Laufs (markIndexed). Ein abgebrochener Lauf schreibt dort nichts — darum ist
// er die Quelle für „gibt es einen brauchbaren Index" (isIndexed), nicht die blosse
// Existenz von Chunks.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
const { vectorToBlob, blobToVector, cosineSim } = require('../lib/embed-chunk');

const _selEntity = db.prepare(
  'SELECT chunk_ix, content_hash, vector FROM semantic_chunks WHERE kind = ? AND entity_id = ? AND model = ? ORDER BY chunk_ix'
);
const _delEntityModel = db.prepare(
  'DELETE FROM semantic_chunks WHERE kind = ? AND entity_id = ? AND model = ?'
);
const _delEntityAll = db.prepare(
  'DELETE FROM semantic_chunks WHERE kind = ? AND entity_id = ?'
);
const _ins = db.prepare(`
  INSERT INTO semantic_chunks (kind, page_id, scene_id, figure_id, research_item_id, location_id, world_fact_id, book_id, chunk_ix, content_hash, model, dim, vector, text, created_at)
  VALUES (@kind, @page_id, @scene_id, @figure_id, @research_item_id, @location_id, @world_fact_id, @book_id, @chunk_ix, @content_hash, @model, @dim, @vector, @text, ${NOW_ISO_SQL})
`);

// kind + entityId → die sechs typisierten FK-Spalten. Genau eine ist gesetzt; der
// CHECK auf der Tabelle weist jede andere Kombination ab.
function _entityCols(kind, entityId) {
  return {
    page_id: kind === 'page' ? entityId : null,
    scene_id: kind === 'scene' ? entityId : null,
    figure_id: kind === 'figure' ? entityId : null,
    research_item_id: kind === 'research' ? entityId : null,
    location_id: kind === 'location' ? entityId : null,
    world_fact_id: kind === 'fact' ? entityId : null,
  };
}

// Bestehende Chunks einer Entität (unter einem Modell) als Map chunk_ix →
// { content_hash, vector }. Basis des Delta-Caches im Index-Job: bei
// unverändertem Hash wird der alte Vektor wiederverwendet statt neu embeddet.
function getEntityChunks(kind, entityId, model) {
  const map = new Map();
  for (const r of _selEntity.all(kind, entityId, model)) {
    map.set(r.chunk_ix, { content_hash: r.content_hash, vector: blobToVector(r.vector) });
  }
  return map;
}

// Existiert die Entität (noch)? Der Index-Job sammelt seine Entitäten am Anfang
// und schreibt sie erst nach dem Embedden — wird eine dazwischen gelöscht,
// schlüge das INSERT am FK fehl und risse den ganzen Lauf mit. Der Job prüft
// darum vor dem Schreiben und überspringt Verschwundenes.
const _EXISTS = {
  page: db.prepare('SELECT 1 FROM pages WHERE page_id = ?'),
  scene: db.prepare('SELECT 1 FROM figure_scenes WHERE id = ?'),
  figure: db.prepare('SELECT 1 FROM figures WHERE id = ?'),
  research: db.prepare('SELECT 1 FROM research_items WHERE id = ?'),
  location: db.prepare('SELECT 1 FROM locations WHERE id = ?'),
  fact: db.prepare('SELECT 1 FROM world_facts WHERE id = ?'),
};
function entityExists(kind, entityId) {
  const st = _EXISTS[kind];
  return !!(st && st.get(entityId));
}

// Ersetzt den kompletten Chunk-Satz einer Entität (unter einem Modell) atomar.
// rows: [{ chunk_ix, content_hash, vector:Float32Array, text }]. Leeres rows →
// nur Löschung (Entität hat keinen indizierbaren Text mehr).
const _replaceTx = db.transaction((kind, entityId, bookId, model, dim, rows) => {
  _delEntityModel.run(kind, entityId, model);
  const cols = _entityCols(kind, entityId);
  for (const row of rows) {
    _ins.run({
      kind, ...cols, book_id: bookId, chunk_ix: row.chunk_ix,
      content_hash: row.content_hash, model, dim,
      vector: vectorToBlob(row.vector), text: row.text,
    });
  }
});
function replaceEntity(kind, entityId, bookId, model, dim, rows) {
  _replaceTx(kind, entityId, bookId, model, dim, rows || []);
  _bumpWriteGen();
}

// Nachbar-Passagen eines Treffers: Chunk chunkIx samt radius Chunks davor und
// danach, zu EINEM Text verschmolzen. Die Chunks überlappen (CHUNK_OVERLAP) — die
// doppelte Naht wird entfernt, damit kein Satz zweimal im Prompt steht. Für
// Chat-Kontexte: eine Faktenfrage und ihre Antwort stehen oft in benachbarten
// Passagen, searchSimilar liefert aber nur den besten Chunk je Entität.
function neighborText(kind, entityId, model, chunkIx, radius = 1) {
  const rows = db.prepare(
    'SELECT chunk_ix, text FROM semantic_chunks WHERE kind = ? AND entity_id = ? AND model = ? AND chunk_ix BETWEEN ? AND ? ORDER BY chunk_ix'
  ).all(kind, entityId, model, chunkIx - radius, chunkIx + radius);
  let out = '';
  for (const r of rows) out = out ? mergeOverlap(out, r.text || '') : (r.text || '');
  return out;
}

// Hängt b an a und entfernt dabei die längste Überlappung (Ende von a == Anfang
// von b, höchstens maxOverlap Zeichen). Ohne Überlappung: mit Space verbunden.
function mergeOverlap(a, b, maxOverlap = 600) {
  const lim = Math.min(maxOverlap, a.length, b.length);
  for (let k = lim; k >= 20; k--) {
    if (a.endsWith(b.slice(0, k))) return a + b.slice(k);
  }
  return `${a} ${b}`;
}

// Vollständige Entfernung einer Entität (alle Modelle) — beim Entity-Delete
// aus den Quelltabellen aufzurufen (Pages/Scenes/Figures).
function remove(kind, entityId) {
  _delEntityAll.run(kind, entityId);
  _bumpWriteGen();
}

// Vektor-Cache für searchSimilar, pro (Buch, Modell). Jede Anfrage las sonst alle
// Chunks des Buchs samt BLOB aus SQLite — bei 11k Chunks ~100 ms (kalt ~1 s) je
// Anfrage, während der Cosinus-Scan selbst ~13 ms braucht; Beat-/Figur-Anker und
// Motiv-Scan stellen pro Lauf Dutzende Anfragen. Der Text liegt NICHT im Cache
// (nur die Gewinner brauchen ihn, per rowid nachgeladen).
//
// Invalidierung über zwei Signale, geprüft vor jeder Anfrage:
//   - _writeGen: zählt jeden Schreibweg dieses Moduls hoch (replaceEntity,
//     remove, pruneMissing, clearForeignModels) — andere Schreiber auf semantic_chunks
//     gibt es nicht.
//   - Chunk-Anzahl des Buchs: fängt die FK-CASCADE-Löschungen (Seite/Figur/Szene/
//     Buch gelöscht), die am Modul vorbeigehen. Kaskaden löschen nur, also sinkt
//     die Anzahl immer; Einfügen geht ausschliesslich über replaceEntity.
// Deckel über die Summe der gecachten Chunks (LRU nach Buch): 1024-dim bge-m3
// ≈ 4 KB je Chunk → 30k Chunks ≈ 120 MB.
const VEC_CACHE_MAX_CHUNKS = 30000;
const _vecCache = new Map(); // `${bookId}|${model}` → { gen, count, rows }
let _writeGen = 0;
function _bumpWriteGen() { _writeGen++; }

const _selBookCount = db.prepare('SELECT COUNT(*) AS n FROM semantic_chunks WHERE book_id = ?');
const _selState = db.prepare('SELECT indexed_at FROM semantic_index_state WHERE book_id = ? AND model = ?');
const _upsertState = db.prepare(`
  INSERT INTO semantic_index_state (book_id, model, indexed_at) VALUES (?, ?, ${NOW_ISO_SQL})
  ON CONFLICT(book_id, model) DO UPDATE SET indexed_at = excluded.indexed_at
`);
// ORDER BY hält die Scan-Reihenfolge (und damit Gleichstands-Auflösung) stabil.
const _selBookVectors = db.prepare(
  'SELECT rowid AS rid, kind, entity_id, chunk_ix, vector FROM semantic_chunks WHERE book_id = ? AND model = ? ORDER BY entity_id, chunk_ix'
);
const _selChunkText = db.prepare('SELECT text FROM semantic_chunks WHERE rowid = ?');

// Volle Zeilen (mit Text) für den Redundanz-Radar. ORDER BY macht dessen
// MAX_CHUNKS-Kappung deterministisch: ohne stabile Reihenfolge schnitte .slice()
// in SQLite-rowid-Ordnung, und welche Passagen bei einem Buch über dem Cap
// fehlen, wäre zwischen Läufen nicht reproduzierbar.
const _selBookKinds = db.prepare(
  'SELECT kind, entity_id, chunk_ix, text, vector FROM semantic_chunks WHERE book_id = ? AND model = ? ORDER BY entity_id, chunk_ix'
);

function _bookVectors(bookId, model) {
  const key = `${bookId}|${model}`;
  const count = _selBookCount.get(bookId).n;
  const hit = _vecCache.get(key);
  if (hit && hit.gen === _writeGen && hit.count === count) {
    _vecCache.delete(key); _vecCache.set(key, hit); // LRU: ans Ende
    return hit.rows;
  }
  const rows = _selBookVectors.all(bookId, model).map(r => ({
    rid: r.rid, kind: r.kind, entity_id: r.entity_id, chunk_ix: r.chunk_ix, vec: blobToVector(r.vector),
  }));
  _vecCache.delete(key);
  _vecCache.set(key, { gen: _writeGen, count, rows });
  let total = 0;
  for (const e of _vecCache.values()) total += e.rows.length;
  for (const [k, e] of _vecCache) {
    if (total <= VEC_CACHE_MAX_CHUNKS || k === key) break;
    _vecCache.delete(k); total -= e.rows.length;
  }
  return rows;
}

// Brute-Force-Ähnlichkeitssuche innerhalb eines Buches gegen queryVec. Bei
// Buchgrösse (Hunderte–wenige Tausend Chunks) ist der lineare Scan Millisekunden
// — kein sqlite-vec nötig. Filtert aufs aktive Modell (model), optional auf
// kinds und schliesst die Quell-Entität aus (exclude), damit „ähnliche Stellen
// zu dieser Szene" nicht die Szene selbst zurückgibt. Ein Treffer pro Entität
// (bester Chunk), nach Score sortiert, top-K. minScore: Cosinus-Untergrenze —
// die Ähnlichkeitssuche liefert nie „keine Treffer", darum schneidet der Floor
// den schwachen Long-Tail ab (0 = aus).
function searchSimilar(bookId, model, queryVec, { kinds = null, topK = 20, excludeKind = null, excludeEntityId = null, minScore = 0 } = {}) {
  const kindSet = kinds && kinds.length ? new Set(kinds) : null;
  const best = new Map(); // key `${kind}:${entity_id}` → { kind, entity_id, chunk_ix, text, score }
  for (const r of _bookVectors(bookId, model)) {
    if (kindSet && !kindSet.has(r.kind)) continue;
    if (excludeKind && r.kind === excludeKind && r.entity_id === excludeEntityId) continue;
    const score = cosineSim(queryVec, r.vec);
    if (!Number.isFinite(score)) continue;
    if (score < minScore) continue;
    const key = `${r.kind}:${r.entity_id}`;
    const cur = best.get(key);
    if (!cur || score > cur.score) {
      best.set(key, { kind: r.kind, entity_id: r.entity_id, chunk_ix: r.chunk_ix, rid: r.rid, score });
    }
  }
  return Array.from(best.values()).sort((a, b) => b.score - a.score).slice(0, topK)
    .map(({ rid, ...h }) => ({ ...h, text: _selChunkText.get(rid)?.text ?? '' }));
}

// Beste Chunks INNERHALB einer Entität gegen queryVec. Gegenstück zu
// searchSimilar, das pro Entität nur den besten Chunk liefert: hier zählt die
// Verteilung im Inneren eines langen Dokuments (Recherche-PDF), von dem mehrere
// Passagen zur Frage passen können. Kein Embedding-Call für die Chunks — die
// Vektoren liegen schon; der Aufrufer bringt nur den Query-Vektor mit.
function searchInEntity(kind, entityId, model, queryVec, { topK = 5, minScore = 0 } = {}) {
  const rows = db.prepare(
    'SELECT chunk_ix, text, vector FROM semantic_chunks WHERE kind = ? AND entity_id = ? AND model = ? ORDER BY chunk_ix'
  ).all(kind, entityId, model);
  const out = [];
  for (const r of rows) {
    const score = cosineSim(queryVec, blobToVector(r.vector));
    if (!Number.isFinite(score) || score < minScore) continue;
    out.push({ chunk_ix: r.chunk_ix, text: r.text, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, topK);
}

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

// Repräsentativer Vektor einer indizierten Entität = Mittel über ihre Chunks
// (unter model). Basis der „ähnliche Stellen zu dieser Figur/Szene"-Suche —
// kein Embedding-Call nötig, der Vektor liegt schon. null wenn nicht indiziert.
function getEntityVector(kind, entityId, model) {
  const rows = db.prepare(
    'SELECT vector FROM semantic_chunks WHERE kind = ? AND entity_id = ? AND model = ?'
  ).all(kind, entityId, model);
  if (!rows.length) return null;
  const first = blobToVector(rows[0].vector);
  const acc = new Float32Array(first.length);
  for (const r of rows) {
    const v = blobToVector(r.vector);
    if (v.length !== acc.length) continue;
    for (let i = 0; i < acc.length; i++) acc[i] += v[i];
  }
  for (let i = 0; i < acc.length; i++) acc[i] /= rows.length;
  return acc;
}

// Repräsentativer Text einer indizierten Entität = ihre Chunk-Texte in chunk_ix-
// Reihenfolge verkettet (unter model), auf maxChars begrenzt. Query-String für das
// Reranking der „ähnliche Stellen zu dieser Entität"-Suche — der Cross-Encoder
// bewertet (Text, Text)-Paare, der gemittelte Vektor aus getEntityVector taugt nur
// fürs Retrieval. '' wenn nicht indiziert.
function getEntityText(kind, entityId, model, maxChars = 2000) {
  const rows = db.prepare(
    'SELECT text FROM semantic_chunks WHERE kind = ? AND entity_id = ? AND model = ? ORDER BY chunk_ix'
  ).all(kind, entityId, model);
  let out = '';
  for (const r of rows) {
    if (!r.text) continue;
    out += (out ? '\n' : '') + r.text;
    if (out.length >= maxChars) break;
  }
  return out.slice(0, maxChars);
}

// Index-Status pro Buch (für die Karte/Admin): Chunks + distinkte Entitäten je
// kind unter dem aktiven Modell, plus ob unter Fremdmodellen Chunks liegen
// (→ „Reindex nötig nach Modellwechsel").
function bookStats(bookId, model) {
  const byKind = db.prepare(`
    SELECT kind, COUNT(*) AS chunks, COUNT(DISTINCT entity_id) AS entities
    FROM semantic_chunks WHERE book_id = ? AND model = ? GROUP BY kind
  `).all(bookId, model);
  const staleModels = db.prepare(
    'SELECT COUNT(*) AS n FROM semantic_chunks WHERE book_id = ? AND model <> ?'
  ).get(bookId, model);
  const total = byKind.reduce((s, r) => s + r.chunks, 0);
  return { model, total, byKind, staleModelChunks: staleModels?.n || 0 };
}

// Verwaiste Chunks nach einem Full-Reindex entfernen: pro kind alle Entitäten
// löschen, die nicht mehr in keepIds stehen (gelöschte Seiten/Szenen/Figuren,
// deren remove()-Hook z.B. bei einem Bulk-Delete nicht lief). Fremdmodell-Chunks
// bleiben unangetastet (model-Filter).
function pruneMissing(bookId, model, kind, keepIds) {
  const keep = new Set((keepIds || []).map(Number));
  const rows = db.prepare(
    'SELECT DISTINCT entity_id FROM semantic_chunks WHERE book_id = ? AND model = ? AND kind = ?'
  ).all(bookId, model, kind);
  const del = db.prepare('DELETE FROM semantic_chunks WHERE book_id = ? AND model = ? AND kind = ? AND entity_id = ?');
  let removed = 0;
  db.transaction(() => {
    for (const r of rows) {
      if (!keep.has(Number(r.entity_id))) { del.run(bookId, model, kind, r.entity_id); removed++; }
    }
  })();
  if (removed) _bumpWriteGen();
  return removed;
}

// Ende des letzten VOLLSTÄNDIGEN Index-Laufs (ISO) oder null. Nur der Index-Job
// schreibt ihn, und nur, wenn er bis zum Ende durchlief.
function lastIndexedAt(bookId, model) {
  return _selState.get(bookId, model)?.indexed_at || null;
}
function markIndexed(bookId, model) {
  _upsertState.run(bookId, model);
}
// Gibt es einen brauchbaren Index? Ein Buch ohne indizierbaren Text hat nach
// einem vollständigen Lauf zwar keinen Chunk, ist aber „indiziert".
function isIndexed(bookId, model) {
  return lastIndexedAt(bookId, model) != null;
}

// Index-Frische für die Such-Karte. lastIndexedAt = Ende des letzten vollständigen
// Laufs (semantic_index_state). staleCount = Quell-Entitäten, deren updated_at
// danach liegt (seither geändert oder neu hinzugekommen) — billiger Heuristik-
// Zähler ohne Re-Hashing. Plus bookStats (total/byKind/staleModel).
function indexStatus(bookId, model) {
  const stats = bookStats(bookId, model);
  const last = lastIndexedAt(bookId, model);
  if (!last) return { indexed: false, lastIndexedAt: null, staleCount: 0, ...stats };
  const _changedSince = (table) => db.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE book_id = ? AND updated_at > ?`
  ).get(bookId, last).n;
  const staleCount = _changedSince('pages') + _changedSince('figure_scenes')
                   + _changedSince('figures') + _changedSince('research_items')
                   + _changedSince('locations') + _changedSince('world_facts');
  return { indexed: true, lastIndexedAt: last, staleCount, ...stats };
}

// Chunks und Index-Stand fremder Modelle eines Buchs löschen. Nach einem
// vollständigen Lauf unter dem aktiven Modell sind sie toter Ballast: jede Anfrage
// filtert aufs aktive Modell. Rückgabe: Anzahl gelöschter Chunks.
function clearForeignModels(bookId, model) {
  const n = db.prepare('DELETE FROM semantic_chunks WHERE book_id = ? AND model <> ?').run(bookId, model).changes;
  db.prepare('DELETE FROM semantic_index_state WHERE book_id = ? AND model <> ?').run(bookId, model);
  if (n) _bumpWriteGen();
  return n;
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
// `book_id` doppelt geprueft (an den Chunks UND an der Seite): eine Seite, die in
// ein anderes Buch verschoben wurde, haelt ihre Vektoren bis zum naechsten
// Reindex — sie darf nicht in der Landkarte des alten Buchs auftauchen.
// Rueckgabe: [{ entity_id, chapter_id, text, vector:Float32Array }].
function loadPageChunksWithChapter(bookId, model) {
  const rows = db.prepare(`
    SELECT sc.entity_id, sc.text, sc.vector, p.chapter_id
      FROM semantic_chunks sc
      JOIN pages p ON p.page_id = sc.entity_id
     WHERE sc.book_id = ? AND sc.model = ? AND sc.kind = 'page'
       AND p.book_id = ?
     ORDER BY sc.entity_id, sc.chunk_ix
  `).all(bookId, model, bookId);
  return rows.map(r => ({
    entity_id: r.entity_id,
    chapter_id: r.chapter_id ?? null,
    text: r.text,
    vector: blobToVector(r.vector),
  }));
}

module.exports = {
  getEntityChunks, replaceEntity, remove, searchSimilar, searchInEntity, getEntityVector, getEntityText,
  bookStats, clearForeignModels, pruneMissing, indexStatus,
  entityExists, neighborText, mergeOverlap, lastIndexedAt, markIndexed, isIndexed,
  loadChunksForPairing, loadFigureVectorsForPairing, loadPageChunksWithChapter,
};
