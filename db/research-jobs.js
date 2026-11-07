'use strict';
// Lese-Abfragen der Recherche-KI-Jobs (Abgleich, Verknüpfung, Recherche-Chat),
// aus den Job-Handlern herausgezogen: Handler lesen keine Tabellen selbst.
// Schreibwege bleiben in db/research-items.js bzw. db/research-findings.js.

const { db } = require('./connection');
const { activeFigureSql } = require('./figures/active');

/**
 * Kandidaten des Recherche-Abgleichs: Fakten und Zitate, nicht archiviert, nicht
 * verworfen. `doc_text` nur als Anfang (`docChars`) — der Abgleich braucht ihn
 * nur als Ersatz-Anfrage der Embedding-Suche (lib/research-retrieval.js), nicht
 * das ganze PDF je Kandidat. Liefert höchstens `cap + 1` Zeilen (Kappung erkennbar).
 */
function crosscheckCandidates(bookId, itemId, { cap, docChars }) {
  const where = ["ri.book_id = ?", "ri.kind IN ('fact','quote')", 'ri.archived = 0', "ri.status <> 'verworfen'"];
  const args = [Math.max(0, docChars | 0), bookId];
  if (itemId) { where.push('ri.id = ?'); args.push(itemId); }
  return db.prepare(
    `SELECT ri.id, ri.kind, ri.title, ri.body, ri.source, substr(ri.doc_text, 1, ?) AS doc_text
       FROM research_items ri WHERE ${where.join(' AND ')}
      ORDER BY ri.pinned DESC, ri.updated_at DESC LIMIT ${(cap | 0) + 1}`
  ).all(...args);
}

/** Fundstück samt URLs für den Verknüpfungs-Job, null wenn nicht im Buch. */
function researchItemForLinking(itemId, bookId) {
  const item = db.prepare(
    'SELECT id, title, body, source, doc_name, doc_text FROM research_items WHERE id = ? AND book_id = ?'
  ).get(itemId, bookId);
  if (!item) return null;
  item.urls = db.prepare('SELECT url, label FROM research_item_urls WHERE item_id = ? ORDER BY position, id').all(itemId);
  return item;
}

/** Bestehende Verknüpfungen eines Fundstücks als Set `kind:id`. */
function researchItemLinkKeys(itemId) {
  return new Set(
    db.prepare('SELECT target_kind, chapter_id, page_id, figure_id, location_id, scene_id, beat_id, thread_id FROM research_item_links WHERE item_id = ?')
      .all(itemId)
      .map(r => `${r.target_kind}:${r.chapter_id ?? r.page_id ?? r.figure_id ?? r.location_id ?? r.scene_id ?? r.beat_id ?? r.thread_id}`)
  );
}

/** Welt-Entitäten als Verknüpfungs-Kandidaten (Katalog des Users), je Art höchstens `max`. */
function researchLinkCandidates(bookId, userEmail, max) {
  const q = (sql) => db.prepare(`${sql} LIMIT ${max | 0}`).all(bookId, userEmail);
  return {
    // Nur aktive Figuren (db/figures/active.js): eine ausgemusterte Figur steht nicht
    // mehr im Text und taugt nicht als Vorschlag für eine neue Verknüpfung.
    figur:  q(`SELECT id, fig_id AS ref_id, name AS label, typ, beruf, rolle, beschreibung FROM figures f WHERE book_id = ? AND user_email = ? AND ${activeFigureSql('f')} ORDER BY sort_order, name`),
    ort:    q('SELECT id, loc_id AS ref_id, name AS label, typ, land, beschreibung FROM locations WHERE book_id = ? AND user_email = ? ORDER BY sort_order, name'),
    szene:  q('SELECT id, titel AS label, kommentar FROM figure_scenes WHERE book_id = ? AND user_email = ? ORDER BY sort_order, titel'),
    beat:   q('SELECT id, titel AS label, status, beschreibung FROM plot_beats WHERE book_id = ? AND user_email = ? ORDER BY sort_order, titel'),
    strang: q('SELECT id, name AS label FROM plot_threads WHERE book_id = ? AND user_email = ? ORDER BY position, name'),
  };
}

/** context_info aller Assistant-Antworten einer Session mit Vorschlägen, chronologisch. */
function sessionProposalContextInfos(sessionId) {
  return db.prepare(
    `SELECT context_info FROM chat_messages
      WHERE session_id = ? AND role = 'assistant' AND context_info LIKE '%"proposals"%'
      ORDER BY created_at ASC, id ASC`
  ).all(sessionId).map(r => r.context_info);
}

/** context_info einer Chat-Nachricht (roh), null wenn es sie nicht gibt. */
function messageContextInfo(messageId) {
  return db.prepare('SELECT context_info FROM chat_messages WHERE id = ?').get(messageId)?.context_info ?? null;
}

/** Nicht archivierte Fundstücke aus `ids`, jüngste zuerst. */
function activeResearchItemsByIds(ids, limit) {
  if (!ids.length) return [];
  return db.prepare(
    `SELECT id, kind, title, status FROM research_items
      WHERE id IN (${ids.map(() => '?').join(',')}) AND archived = 0
      ORDER BY updated_at DESC LIMIT ${limit | 0}`
  ).all(...ids);
}

module.exports = {
  crosscheckCandidates, researchItemForLinking, researchItemLinkKeys, researchLinkCandidates,
  sessionProposalContextInfos, messageContextInfo, activeResearchItemsByIds,
};
