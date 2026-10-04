'use strict';
// Datenschicht der Ideen: Notizen und Pendenzen an einer Seite, einem Kapitel
// oder (ohne Anker) nur am Buch, plus die Bruecke `idea_links` zu Recherche/Beat/Strang/
// Motiv/Werkstatt-Figur.
//
// Warum als eigenes db/-Modul und nicht weiter als SQL im Handler: die Ausgabe
// einer Idee traegt Seiten- und Kapitelnamen, und der ist ein Namens-JOIN auf
// `pages`/`chapters`. Die Content-Store-Regel sagt dafuer ausdruecklich: solch
// ein JOIN gehoert in ein db/-Modul, nicht in einen Route-Handler (Muster
// db/sources/citations.js#listSourceCitations). Seit dem Ideen-Board gibt es
// ausserdem drei Lesepfade auf dieselbe Zeile (Seiten-/Kapitelliste, Board,
// Rueckwaerts-Lesung der drei Gegenseiten) — die Ausgabeform darf nicht
// dreimal danebenstehen.
//
// SKOPIERUNG, die keine Schicht verwischen darf: `ideen.user_email` ist der
// Sichtbarkeits-Scope, nicht blosse Attribution. Eine Idee gehoert ihrem Autor,
// auch auf einem geteilten Buch. Darum traegt JEDE Lesung hier `user_email` —
// besonders die Rueckwaerts-Lesung: `research_items` ist buchweit GETEILT, und
// ohne den Filter zeigte die Recherche-Karte dem einen Mitarbeiter die privaten
// Pendenzen des anderen.

const { db } = require('./connection');
require('./migrations');
const { NOW_ISO_SQL } = require('./now');
const { IDEA_LINK_KINDS, openStatusSql, normalizeIdeeStatus } = require('../lib/ideen-status');

// target_kind → { col, table, pk, nameCol, bookCol } fuer Validierung und
// Display-JOIN. `bookCol` traegt die Buch-Pruefung: der FK allein liesse eine
// Idee aus Buch A auf ein Motiv aus Buch B zeigen (gleiche Absicherung wie
// db/motifs/links.js#resolve*).
const LINK_TARGETS = {
  research: { col: 'research_id', table: 'research_items', pk: 'id', nameCol: 'title', bookCol: 'book_id' },
  beat:     { col: 'beat_id',     table: 'plot_beats',     pk: 'id', nameCol: 'titel', bookCol: 'book_id' },
  motif:    { col: 'motif_id',    table: 'motifs',         pk: 'id', nameCol: 'name',  bookCol: 'book_id' },
  draft:    { col: 'draft_figure_id', table: 'draft_figures', pk: 'id', nameCol: 'name', bookCol: 'book_id' },
  thread:   { col: 'thread_id',   table: 'plot_threads',   pk: 'id', nameCol: 'name',  bookCol: 'book_id' },
};

const SELECT_ROW = `
  SELECT i.id, i.book_id, i.page_id, p.page_name,
         i.chapter_id, c.chapter_name,
         i.content, i.status, i.status_at, i.sort_order, i.created_at, i.updated_at
    FROM ideen i
    LEFT JOIN pages    p ON p.page_id    = i.page_id
    LEFT JOIN chapters c ON c.chapter_id = i.chapter_id
`;

// ── Verknuepfungen ──────────────────────────────────────────────────────────

// Links einer Ideen-Menge nachladen, ein Pass je Ziel-Art (Muster
// db/research-items.js#attachRelations). Label kommt per JOIN zur Lesezeit —
// keine Snapshot-Spalte, ein umbenanntes Motiv heisst sofort ueberall neu.
function attachLinks(rows) {
  if (!rows.length) return rows;
  const ids = rows.map(r => r.id);
  const ph = ids.map(() => '?').join(',');
  const byIdea = new Map();
  for (const kind of IDEA_LINK_KINDS) {
    const t = LINK_TARGETS[kind];
    const linkRows = db.prepare(`
      SELECT l.id AS link_id, l.idea_id, l.${t.col} AS target_id, e.${t.nameCol} AS label
        FROM idea_links l
        JOIN ${t.table} e ON e.${t.pk} = l.${t.col}
       WHERE l.idea_id IN (${ph}) AND l.target_kind = ?
    `).all(...ids, kind);
    for (const r of linkRows) {
      if (!byIdea.has(r.idea_id)) byIdea.set(r.idea_id, []);
      byIdea.get(r.idea_id).push({
        link_id: r.link_id, target_kind: kind, target_id: r.target_id, label: r.label || '',
      });
    }
  }
  for (const row of rows) row.links = byIdea.get(row.id) || [];
  return rows;
}

/** Ausgabeform einer Idee (Namen per JOIN, Links angehaengt). */
function getIdee(id) {
  const row = db.prepare(`${SELECT_ROW} WHERE i.id = ?`).get(id);
  if (!row) return null;
  attachLinks([row]);
  return row;
}

/** Besitz-/Scope-Zeile fuer die Schreibpfade (ohne JOINs, ohne Links). */
function getIdeeOwned(id, userEmail) {
  return db.prepare(
    'SELECT id, book_id, page_id, chapter_id, status FROM ideen WHERE id = ? AND user_email = ?'
  ).get(id, userEmail);
}

/**
 * Verknuepfung anlegen. Liefert `{ ok }` oder `{ error_code }` — die Pruefung,
 * ob das Ziel ueberhaupt zum selben Buch gehoert, liegt hier und nicht im
 * Handler, weil sie die Ziel-Tabelle kennen muss.
 */
function addIdeaLink(ideaId, bookId, targetKind, targetId) {
  const t = LINK_TARGETS[targetKind];
  if (!t) return { error_code: 'INVALID_LINK_KIND' };
  const target = db.prepare(
    `SELECT ${t.bookCol} AS book_id FROM ${t.table} WHERE ${t.pk} = ?`
  ).get(targetId);
  if (!target) return { error_code: 'LINK_TARGET_NOT_FOUND' };
  if (target.book_id !== bookId) return { error_code: 'BOOK_MISMATCH' };
  db.prepare(
    `INSERT OR IGNORE INTO idea_links (idea_id, target_kind, ${t.col}) VALUES (?, ?, ?)`
  ).run(ideaId, targetKind, targetId);
  return { ok: true };
}

/** Verknuepfung loesen. `idea_id` im WHERE, damit eine fremde link_id nichts trifft. */
function removeIdeaLink(ideaId, linkId) {
  return db.prepare('DELETE FROM idea_links WHERE id = ? AND idea_id = ?').run(linkId, ideaId).changes;
}

/**
 * Rueckwaerts-Lesung fuer die drei Gegenseiten: Map target_id → [Idee-Anrisse].
 * Ausschliesslich die Ideen von `userEmail` (siehe Skopierungs-Hinweis oben).
 * Buch-skopiert, damit eine Ziel-ID aus einem anderen Buch nichts zieht.
 */
function ideaLinksByTarget(targetKind, bookId, userEmail) {
  const t = LINK_TARGETS[targetKind];
  const out = new Map();
  if (!t || !bookId || !userEmail) return out;
  const rows = db.prepare(`
    SELECT l.id AS link_id, l.${t.col} AS target_id, i.id AS idea_id,
           i.content, i.status, i.page_id, p.page_name, i.chapter_id, c.chapter_name
      FROM idea_links l
      JOIN ideen i       ON i.id = l.idea_id
      LEFT JOIN pages    p ON p.page_id    = i.page_id
      LEFT JOIN chapters c ON c.chapter_id = i.chapter_id
     WHERE l.target_kind = ? AND i.book_id = ? AND i.user_email = ?
     ORDER BY i.created_at DESC, i.id DESC
  `).all(targetKind, bookId, userEmail);
  for (const r of rows) {
    if (!out.has(r.target_id)) out.set(r.target_id, []);
    out.get(r.target_id).push({
      link_id: r.link_id,
      idea_id: r.idea_id,
      content: r.content,
      status: normalizeIdeeStatus(r.status),
      page_id: r.page_id,
      page_name: r.page_name || '',
      chapter_id: r.chapter_id,
      chapter_name: r.chapter_name || '',
    });
  }
  return out;
}

/**
 * Ideen-Anrisse an eine bereits geladene Liste haengen (`rows[i].ideas`).
 * Der eine Griff, den Recherche-Karte, Beat-Board und Motiv-Werkstatt teilen —
 * sonst schriebe jede Gegenseite ihre eigene Gruppierung.
 */
function attachIdeasTo(rows, targetKind, bookId, userEmail) {
  const map = ideaLinksByTarget(targetKind, bookId, userEmail);
  for (const row of rows || []) row.ideas = map.get(row.id) || [];
  return rows;
}

/**
 * Verknuepfbare Ziele eines Buches fuer den Link-Picker.
 *
 * Skopierung je Katalog verschieden, und das ist kein Versehen:
 * `research_items` ist buchweit GETEILT (jeder Mitarbeitende sieht denselben
 * Bestand), `plot_beats` und `motifs` gehoeren dagegen dem User, der sie
 * angelegt hat. Ein Picker, der fremde Beats anboete, wuerde Kanten erzeugen,
 * deren Gegenseite der Autor in seiner Werkstatt nie zu Gesicht bekommt.
 *
 * Verworfene Beats und archivierte Fundstuecke bleiben draussen — als NEUES
 * Ziel taugen sie nicht. Eine bestehende Kante dorthin bleibt bestehen und wird
 * weiter angezeigt (der Chip liest ueber attachLinks, nicht ueber diese Liste).
 */
function listIdeaLinkTargets(bookId, userEmail) {
  const bid = parseInt(bookId);
  return {
    research: db.prepare(`
      SELECT id, COALESCE(NULLIF(TRIM(title), ''), substr(COALESCE(body,''), 1, 60)) AS label
        FROM research_items
       WHERE book_id = ? AND archived = 0
       ORDER BY pinned DESC, updated_at DESC, id DESC
    `).all(bid).map(r => ({ id: r.id, label: r.label || '' })),
    beat: db.prepare(`
      SELECT b.id, b.titel AS label, a.name AS sublabel
        FROM plot_beats b
        JOIN plot_acts a ON a.id = b.act_id
       WHERE b.book_id = ? AND b.user_email = ? AND b.verworfen = 0
       ORDER BY a.position, b.sort_order, b.id
    `).all(bid, userEmail).map(r => ({ id: r.id, label: r.label || '', sublabel: r.sublabel || '' })),
    motif: db.prepare(`
      SELECT id, name AS label
        FROM motifs
       WHERE book_id = ? AND user_email = ?
       ORDER BY position, id
    `).all(bid, userEmail).map(r => ({ id: r.id, label: r.label || '' })),
    // Werkstatt-Figuren und Stränge gehoeren wie Beats und Motive dem User.
    draft: db.prepare(`
      SELECT id, name AS label
        FROM draft_figures
       WHERE book_id = ? AND user_email = ?
       ORDER BY name COLLATE NOCASE, id
    `).all(bid, userEmail).map(r => ({ id: r.id, label: r.label || '' })),
    thread: db.prepare(`
      SELECT id, name AS label
        FROM plot_threads
       WHERE book_id = ? AND user_email = ?
       ORDER BY position, id
    `).all(bid, userEmail).map(r => ({ id: r.id, label: r.label || '' })),
  };
}

// ── Lesepfade ───────────────────────────────────────────────────────────────

/** Ideen einer Seite ODER eines Kapitels (offen zuerst, je Block neueste oben). */
function listIdeenForScope(kind, scopeId, userEmail) {
  const col = kind === 'chapter' ? 'chapter_id' : 'page_id';
  const rows = db.prepare(`
    ${SELECT_ROW}
    WHERE i.${col} = ? AND i.user_email = ?
    ORDER BY CASE WHEN ${openStatusSql('i')} THEN 0 ELSE 1 END,
             i.created_at DESC
  `).all(scopeId, userEmail);
  return attachLinks(rows);
}

/**
 * Map Anker-ID → Zahl der OFFENEN Ideen (Sidebar-Plakette, `/ideen/counts`).
 * `verworfen` zaehlt bewusst nicht mit — eine fallengelassene Idee ist keine
 * offene Pendenz und soll keine Plakette setzen.
 */
function openIdeenCounts(bookId, userEmail, kind) {
  const col = kind === 'chapter' ? 'chapter_id' : 'page_id';
  const rows = db.prepare(`
    SELECT ${col} AS scope_id, COUNT(*) AS n
      FROM ideen
     WHERE book_id = ? AND user_email = ? AND ${openStatusSql()} AND ${col} IS NOT NULL
     GROUP BY ${col}
  `).all(bookId, userEmail);
  const map = {};
  for (const r of rows) map[r.scope_id] = r.n;
  return map;
}

/**
 * Alle Ideen eines Buches fuer das Board — eine Abfrage, ein Lesepfad.
 *
 * Mitgeliefert wird `lane_chapter_id`: fuer eine Kapitel-Idee das Kapitel
 * selbst, fuer eine Seiten-Idee das Kapitel IHRER SEITE. Daran haengt der
 * Kapitel-Filter des Boards — ohne diese Spalte muesste das Frontend die
 * Seite→Kapitel-Zuordnung aus dem Baum nachschlagen und haette bei einer Seite,
 * die der Baum (noch) nicht kennt, eine stumme Luecke. Die REIHENFOLGE der
 * Bahnen kommt weiterhin aus dem Baum (SSoT `book_order`), nicht von hier.
 */
function listBoardIdeen(bookId, userEmail) {
  const rows = db.prepare(`
    SELECT i.id, i.book_id, i.page_id, p.page_name,
           i.chapter_id, c.chapter_name,
           COALESCE(i.chapter_id, p.chapter_id) AS lane_chapter_id,
           COALESCE(c.chapter_name, pc.chapter_name) AS lane_chapter_name,
           i.content, i.status, i.status_at, i.sort_order, i.created_at, i.updated_at
      FROM ideen i
      LEFT JOIN pages    p  ON p.page_id     = i.page_id
      LEFT JOIN chapters c  ON c.chapter_id  = i.chapter_id
      LEFT JOIN chapters pc ON pc.chapter_id = p.chapter_id
     WHERE i.book_id = ? AND i.user_email = ?
     ORDER BY i.created_at DESC, i.id DESC
  `).all(bookId, userEmail);
  return attachLinks(rows);
}

// ── Schreibpfade ────────────────────────────────────────────────────────────

function createIdee({ bookId, pageId, chapterId, userEmail, content }) {
  const res = db.prepare(`
    INSERT INTO ideen (book_id, page_id, chapter_id, user_email, content,
                       status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'offen', ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
  `).run(bookId, pageId || null, chapterId || null, userEmail, content);
  return res.lastInsertRowid;
}

/**
 * Teil-Update. `fields` kennt `content`, `status` und den Umzug (`page_id` bzw.
 * `chapter_id`) — welche Kombination erlaubt ist, entscheidet der Handler.
 * `status_at` wandert mit dem Status mit und wird nie separat gesetzt.
 */
function updateIdee(id, userEmail, fields) {
  const sets = [];
  const vals = [];
  if (typeof fields.content === 'string') { sets.push('content = ?'); vals.push(fields.content); }
  if (typeof fields.status === 'string') {
    sets.push('status = ?');    vals.push(fields.status);
    sets.push(`status_at = ${NOW_ISO_SQL}`);
  }
  if (typeof fields.page_id === 'number')    { sets.push('page_id = ?');    vals.push(fields.page_id); }
  if (typeof fields.chapter_id === 'number') { sets.push('chapter_id = ?'); vals.push(fields.chapter_id); }
  if (!sets.length) return 0;
  sets.push(`updated_at = ${NOW_ISO_SQL}`);
  vals.push(id, userEmail);
  return db.prepare(`UPDATE ideen SET ${sets.join(', ')} WHERE id = ? AND user_email = ?`).run(...vals).changes;
}

/**
 * Manuelle Reihenfolge einer Board-Zelle (Bahn × Stufe) setzen: `ids` in
 * Anzeige-Reihenfolge bekommen `sort_order` 1..n. Ganz oder gar nicht — gehoert
 * eine ID nicht diesem User in diesem Buch, wird nichts geschrieben (`false`).
 * Welche Ideen eine Zelle bilden, entscheidet das Board; hier wird nur
 * sichergestellt, dass niemand fremde Zeilen umordnet. `updated_at` bleibt
 * stehen: Umsortieren aendert die Idee nicht.
 */
const reorderIdeen = db.transaction((bookId, userEmail, ids) => {
  const own = db.prepare('SELECT 1 FROM ideen WHERE id = ? AND book_id = ? AND user_email = ?');
  for (const id of ids) if (!own.get(id, bookId, userEmail)) return false;
  const upd = db.prepare('UPDATE ideen SET sort_order = ? WHERE id = ? AND user_email = ?');
  ids.forEach((id, i) => upd.run(i + 1, id, userEmail));
  return true;
});

function deleteIdee(id, userEmail) {
  return db.prepare('DELETE FROM ideen WHERE id = ? AND user_email = ?').run(id, userEmail).changes;
}

module.exports = {
  LINK_TARGETS,
  attachLinks,
  getIdee,
  getIdeeOwned,
  listIdeenForScope,
  listBoardIdeen,
  openIdeenCounts,
  createIdee,
  updateIdee,
  reorderIdeen,
  deleteIdee,
  addIdeaLink,
  removeIdeaLink,
  ideaLinksByTarget,
  listIdeaLinkTargets,
  attachIdeasTo,
};
