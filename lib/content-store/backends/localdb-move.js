'use strict';
// Nachzug der seitengebundenen Tabellen, wenn movePage eine Seite in ein anderes
// Buch haengt. Laeuft INNERHALB der movePage-Transaktion (Aufrufer oeffnet sie).
// Ausgelagert, damit localdb.js unter dem LOC-Cap bleibt.
//
// Modell — jede Tabelle mit page_id gehoert in genau eine Gruppe:
//   - Seiten-intrinsisch → ZIEHT MIT (book_id nachfuehren): Daten, die die Seite
//     selbst beschreiben und ohne Quellbuch Sinn ergeben — Revisionen, Stats,
//     Schreibzeit, Seiten-Chat, Lektorat-Befunde, Titel-Werkstatt (Headline +
//     Varianten), Bearbeitungsstand, Textsorte, Struktur-Check, „zuletzt
//     benutzt", Embeddings des Seitentexts. Tabellen ohne book_id (Status-
//     Events, Bilder, Beleg-/Verweis-Index) ziehen ueber die stabile page_id von
//     selbst mit.
//   - Buchwelt der Quelle → GEKAPPT: Zeilen eines buchgebundenen Katalogs
//     (Figuren, Motive, Plot-Beats, Entwurfsfiguren, Recherche, Wortschatz,
//     Kontinuitaet, Redundanz, Zeitstrahl, Lektorat-Cache) duerfen nicht auf eine
//     Seite eines fremden Buchs zeigen. Reine Fundstellen-Zeilen (Occurrences,
//     Findings, Mentions) werden geloescht — die naechste Analyse im Zielbuch
//     baut sie neu. User-kuratierte Zeilen bleiben im Quellbuch und verlieren nur
//     den Seiten-Anker (page_id/chapter_id → NULL).
//   - Integrations-Spiegel (Blog/HubSpot) der Quell-Connection + Ephemeres
//     (Locks/Presence) → loeschen.
//   - Seiten-Share-Links ziehen mit; wer keine Freigabe-Rolle im Zielbuch hat,
//     dessen Link wird widerrufen — sonst veroeffentlichte er weiter den Inhalt
//     eines Buchs, auf das er keinen Zugriff hat.

const { db } = require('../../../db/connection');
const { getBookRole, hasMinRole } = require('../../../db/book-access');
const { SHARE_CREATE_MIN_ROLE } = require('../../../db/share-links');

// book_id = Ziel fuer alle Zeilen der Seite.
const MOVE_WITH_PAGE = [
  'page_revisions', 'page_stats', 'lektorat_time', 'chat_sessions',
  'page_headline', 'page_headline_variants', 'page_editorial_status',
  'page_textsorte', 'page_structure_checks', 'user_page_usage', 'semantic_chunks',
];

// Fundstellen buchgebundener Kataloge der Quelle → loeschen.
const DELETE_BY_PAGE = [
  'page_figure_mentions', 'zeitstrahl_event_pages', 'research_item_links',
  'research_item_findings', 'lektorat_cache', 'motif_occurrences', 'motif_pages',
  'plot_beat_occurrences', 'draft_figure_occurrences',
  'blog_page_links', 'hubspot_page_links', 'page_locks', 'page_presence',
];

// User-kuratierte Zeilen der Quelle → nur den Seiten-Anker loesen.
const DETACH = [
  ['figure_events', 'page_id', true],
  ['figure_scenes', 'page_id', true],
  ['figure_age_belege', 'page_id', true],
  ['ideen', 'page_id', true],
  ['figures', 'erste_erwaehnung_page_id', false],
  ['locations', 'erste_erwaehnung_page_id', false],
  ['songs', 'erste_erwaehnung_page_id', false],
  ['lexicon_terms', 'first_page_id', false],
  ['lexicon_ngrams', 'first_page_id', false],
  ['continuity_issues', 'page_a_id', false],
  ['continuity_issues', 'page_b_id', false],
  ['book_presence', 'page_id', false],
];

function _revokeForeignShareLinks(pageId, tBook) {
  const links = db.prepare(`
    SELECT token, owner_email FROM share_links
     WHERE page_id = ? AND revoked_at IS NULL
  `).all(pageId);
  const revoke = db.prepare('UPDATE share_links SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL');
  const now = new Date().toISOString();
  let revoked = 0;
  for (const l of links) {
    if (hasMinRole(getBookRole(tBook, l.owner_email), SHARE_CREATE_MIN_ROLE)) continue;
    revoked += revoke.run(now, l.token).changes;
  }
  return revoked;
}

/** Innerhalb der movePage-Transaktion aufrufen. Liefert { revokedShareLinks }. */
function applyMoveSideEffects(pageId, tBook, tChap) {
  for (const t of MOVE_WITH_PAGE) {
    db.prepare(`UPDATE ${t} SET book_id = ? WHERE page_id = ?`).run(tBook, pageId);
  }
  db.prepare('UPDATE page_checks SET book_id = ?, chapter_id = ? WHERE page_id = ?').run(tBook, tChap, pageId);

  const revokedShareLinks = _revokeForeignShareLinks(pageId, tBook);
  db.prepare('UPDATE share_links SET book_id = ? WHERE page_id = ?').run(tBook, pageId);

  for (const t of DELETE_BY_PAGE) db.prepare(`DELETE FROM ${t} WHERE page_id = ?`).run(pageId);
  db.prepare('DELETE FROM redundancy_dismissals WHERE page_a_id = ? OR page_b_id = ?').run(pageId, pageId);

  for (const [t, col, withChapter] of DETACH) {
    const set = withChapter ? `${col} = NULL, chapter_id = NULL` : `${col} = NULL`;
    db.prepare(`UPDATE ${t} SET ${set} WHERE ${col} = ?`).run(pageId);
  }
  return { revokedShareLinks };
}

module.exports = { applyMoveSideEffects, MOVE_WITH_PAGE, DELETE_BY_PAGE, DETACH };
