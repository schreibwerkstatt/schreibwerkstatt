'use strict';
// Nachzug der seitengebundenen Tabellen, wenn splitPage einen Abschnitt teilt.
// Laeuft INNERHALB der splitPage-Transaktion (Aufrufer oeffnet sie). Gegenstueck
// zu localdb-move.js; ausgelagert, damit localdb-split.js klein bleibt.
//
// Der Kopf behaelt die page_id, also haengt zunaechst alles an ihm. Ein Zeiger
// ist danach falsch, wenn die Stelle, auf die er zeigt, jetzt im Schwanz steht.
// Modell — jede Tabelle mit page_id gehoert in genau eine Gruppe:
//   - Mit Textbeleg → ZIEHT MIT, wenn der Beleg nur noch im Schwanz steht:
//     Fundstellen der Ist-Index-Jobs (Motiv, Plot-Beat, Entwurfsfigur; Auszug
//     aus dem Live-Seitentext, lib/anchor-snippet.js), Figuren-Belege mit Zitat
//     (Alter, Beruf, Hobby), Kontinuitaets-Stellen, Recherche-Befunde und
//     Erledigt-Hinweise der Ideen. Steht der Beleg in beiden Haelften oder in
//     keiner, bleibt die Zeile, wo sie ist.
//   - Erste Erwaehnung (Figur, Ort, Song) → zum Schwanz, wenn der Name nur dort
//     vorkommt. Der Kopf steht im Buch vor dem Schwanz; kommt der Name im Kopf
//     vor, bleibt die erste Erwaehnung dort.
//   - Eigenschaft des Abschnitts → KOPIE auf den Schwanz: Bearbeitungsstand und
//     Textsorte. Der Text beider Haelften ist derselbe wie vorher; ein Stand,
//     der vor dem Teilen aktuell war, bleibt auf beiden aktuell (der Anker
//     `content_updated_at` folgt dem neuen `pages.updated_at`), ein veralteter
//     bleibt veraltet.
//   - Bleibt beim Kopf: was der Autor bewusst an diesen Abschnitt gehaengt hat
//     oder was keinen Beleg traegt — Revisionen, Seiten-Chats, Ideen,
//     Recherche-Verknuepfungen, Share-Links, Schreibzeit, Titel-Werkstatt,
//     Szenen, Lebensereignisse, Zeitstrahl. Szenen/Ereignisse ordnet die
//     naechste Komplettanalyse neu zu. Lektorat-Befunde und -Cache bleiben
//     ebenfalls unberuehrt (stabilisiertes Modul, docs/stabilisiert.md).
//   - Abgeleitet aus dem Volltext → zieht die Facade nach dem Commit neu:
//     Figuren-Erwaehnungen, FTS, Beleg- und Verweis-Index; Embeddings baut der
//     Index-Job aus dem Buch-Event.

const { db } = require('../../../db/connection');
const { htmlToPlainText } = require('../../html-text');
const { computeFigureMentions } = require('../../page-index');

// Belege sind Auszuege aus dem Seitentext (whitespace-collapsed). Laengere
// Auszuege koennen ueber die Schnittstelle reichen oder seit dem Lauf leicht
// veraendert sein — dann entscheidet ihr Anfang.
const PREFIX_CHARS = 60;

function _norm(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** 'tail' nur, wenn der Beleg im Schwanz und NICHT im Kopf steht. */
function locateQuote(quote, headText, tailText) {
  const q = _norm(quote);
  if (q.length < 8) return null;
  for (const probe of q.length > PREFIX_CHARS ? [q, q.slice(0, PREFIX_CHARS)] : [q]) {
    const inHead = headText.includes(probe);
    const inTail = tailText.includes(probe);
    if (inHead || inTail) return inTail && !inHead ? 'tail' : null;
  }
  return null;
}

// [Tabelle, Seiten-Spalte, Beleg-Spalte, Schluessel-Spalte(n)]
const QUOTED = [
  ['motif_occurrences', 'page_id', 'snippet', 'id'],
  ['plot_beat_occurrences', 'page_id', 'snippet', 'id'],
  ['draft_figure_occurrences', 'page_id', 'snippet', 'id'],
  ['figure_age_belege', 'page_id', 'zitat', 'id'],
  ['figure_jobs', 'page_id', 'zitat', 'id'],
  ['figure_hobbies', 'page_id', 'zitat', 'id'],
  ['research_item_findings', 'page_id', 'stelle', 'id'],
  ['continuity_issues', 'page_a_id', 'stelle_a', 'id'],
  ['continuity_issues', 'page_b_id', 'stelle_b', 'id'],
  ['idee_check_hints', 'page_id', 'beleg', 'idee_id'],
];

function _moveQuoted(pageId, newId, headText, tailText) {
  const moved = {};
  for (const [table, pageCol, quoteCol, key] of QUOTED) {
    const rows = db.prepare(`SELECT ${key} AS k, ${quoteCol} AS q FROM ${table} WHERE ${pageCol} = ?`).all(pageId);
    const upd = db.prepare(`UPDATE ${table} SET ${pageCol} = ? WHERE ${key} = ?`);
    let n = 0;
    for (const r of rows) {
      if (locateQuote(r.q, headText, tailText) === 'tail') n += upd.run(newId, r.k).changes;
    }
    if (n) moved[`${table}.${pageCol}`] = n;
  }
  return moved;
}

function _containsName(text, name) {
  const n = _norm(name).toLowerCase();
  return n.length >= 2 && text.toLowerCase().includes(n);
}

function _moveFirstMentions(pageId, newId, bookId, headText, tailText) {
  const moved = {};
  const figs = db.prepare(
    'SELECT id, name, kurzname, weitere_namen FROM figures WHERE erste_erwaehnung_page_id = ?'
  ).all(pageId);
  if (figs.length) {
    const inHead = new Set(computeFigureMentions(headText, figs).map(m => m.figure_id));
    const inTail = new Set(computeFigureMentions(tailText, figs).map(m => m.figure_id));
    const upd = db.prepare('UPDATE figures SET erste_erwaehnung_page_id = ? WHERE id = ?');
    let n = 0;
    for (const f of figs) if (inTail.has(f.id) && !inHead.has(f.id)) n += upd.run(newId, f.id).changes;
    if (n) moved.figures = n;
  }
  for (const [table, nameCol] of [['locations', 'name'], ['songs', 'titel']]) {
    const rows = db.prepare(`SELECT id, ${nameCol} AS name FROM ${table} WHERE erste_erwaehnung_page_id = ? AND book_id = ?`)
      .all(pageId, bookId);
    const upd = db.prepare(`UPDATE ${table} SET erste_erwaehnung_page_id = ? WHERE id = ?`);
    let n = 0;
    for (const r of rows) {
      if (_containsName(tailText, r.name) && !_containsName(headText, r.name)) n += upd.run(newId, r.id).changes;
    }
    if (n) moved[table] = n;
  }
  return moved;
}

// `prevUpdatedAt`: pages.updated_at VOR dem Teilen, `now`: Stempel beider Haelften.
function _copyPageProperties(pageId, newId, prevUpdatedAt, now) {
  const st = db.prepare('SELECT * FROM page_editorial_status WHERE page_id = ?').get(pageId);
  if (st) {
    const wasCurrent = !!st.content_updated_at && !(String(prevUpdatedAt || '') > String(st.content_updated_at));
    const anchor = wasCurrent ? now : st.content_updated_at;
    db.prepare('UPDATE page_editorial_status SET content_updated_at = ? WHERE page_id = ?').run(anchor, pageId);
    db.prepare(`
      INSERT INTO page_editorial_status (page_id, book_id, status, note, content_updated_at, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(newId, st.book_id, st.status, st.note, anchor, st.updated_by, st.updated_at);
  }
  db.prepare(`
    INSERT INTO page_textsorte (page_id, book_id, textsorte, updated_at)
    SELECT ?, book_id, textsorte, updated_at FROM page_textsorte WHERE page_id = ?
  `).run(newId, pageId);
}

/**
 * Innerhalb der splitPage-Transaktion aufrufen, nachdem Kopf und Schwanz
 * geschrieben sind. Liefert die Zahl umgehaengter Zeilen je Tabelle (fuers Log).
 */
function applySplitSideEffects({ pageId, newId, bookId, headHtml, tailHtml, prevUpdatedAt, now }) {
  const headText = htmlToPlainText(headHtml);
  const tailText = htmlToPlainText(tailHtml);
  _copyPageProperties(pageId, newId, prevUpdatedAt, now);
  return {
    ..._moveQuoted(pageId, newId, headText, tailText),
    ..._moveFirstMentions(pageId, newId, bookId, headText, tailText),
  };
}

module.exports = { applySplitSideEffects, locateQuote };
