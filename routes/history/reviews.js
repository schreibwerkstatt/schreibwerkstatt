'use strict';
// Bewertungen + Tagebuch-Rueckblicke: Buch-/Kapitel-Reviews und Rueckblicke
// lesen und loeschen, dazu der komplette History-Reset eines Buchs.

const {
  db, listChapterReviewHistory, deleteChapterReview,
  listRueckblicke, getRueckblick, searchRueckblickIds, deleteRueckblick,
  listBookReviewHistory, deleteBookReview,
  deleteReviewCache, deleteChapterMacroReviewCache,
} = require('../../db/schema');
const { toIntId } = require('../../lib/validate');
const { sessionEmail } = require('../../lib/acl');
const { buildRueckblickCoverage } = require('../jobs/rueckblick-dates');
const { listPageNamesForBook } = require('../../db/content-names');
const { resolveProvider } = require('../../lib/ai');
const { _modelName } = require('../jobs/shared/model');
const { setContext } = require('../../lib/log-context');
const logger = require('../../logger');

function register(router) {
  // Buchbewertung löschen
  router.delete('/review/:id', (req, res) => {
    const user_email = sessionEmail(req);
    const id = toIntId(req.params.id);
    if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
    deleteBookReview(id, user_email);
    res.json({ ok: true });
  });

  // Tagebuch-Rückblick (History-Eintrag) löschen. Rückblicke sind persönlich —
  // der user_email-Filter ist die Rechteprüfung.
  router.delete('/rueckblick/:id', (req, res) => {
    const id = toIntId(req.params.id);
    if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
    deleteRueckblick(id, sessionEmail(req));
    res.json({ ok: true });
  });

  // Einzelner Rückblick samt Ergebnis (die Liste trägt nur Metadaten).
  router.get('/rueckblick-entry/:id', (req, res) => {
    const id = toIntId(req.params.id);
    if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
    const row = getRueckblick(id, sessionEmail(req));
    if (!row) return res.status(404).json({ error_code: 'NOT_FOUND' });
    setContext({ book: row.book_id });
    res.json(row);
  });

  // Kompletter History-Reset für ein Buch: löscht page_checks, book_reviews und
  // chat_sessions (inkl. Nachrichten via ON DELETE CASCADE) des eingeloggten Users,
  // dazu die Bewertungs-Caches — sonst lieferte die nächste Bewertung nach dem
  // Reset wortgleich das alte Ergebnis.
  router.delete('/book/:book_id', (req, res) => {
    const user_email = sessionEmail(req);
    const book_id = req.bookId;

    const delChecks     = db.prepare('DELETE FROM page_checks      WHERE book_id = ? AND user_email = ?');
    const delReviews    = db.prepare('DELETE FROM book_reviews     WHERE book_id = ? AND user_email = ?');
    const delChReviews  = db.prepare('DELETE FROM chapter_reviews  WHERE book_id = ? AND user_email = ?');
    const delSessions   = db.prepare('DELETE FROM chat_sessions    WHERE book_id = ? AND user_email = ?');
    const delWerkRuns   = db.prepare('DELETE FROM werkstatt_runs   WHERE book_id = ? AND user_email = ?');
    const delRueckblicke = db.prepare('DELETE FROM tagebuch_rueckblicke WHERE book_id = ? AND user_email = ?');

    const result = db.transaction(() => ({
      page_checks:      delChecks.run(book_id, user_email).changes,
      book_reviews:     delReviews.run(book_id, user_email).changes,
      chapter_reviews:  delChReviews.run(book_id, user_email).changes,
      chat_sessions:    delSessions.run(book_id, user_email).changes,
      werkstatt_runs:   delWerkRuns.run(book_id, user_email).changes,
      rueckblicke:      delRueckblicke.run(book_id, user_email).changes,
      review_cache:     deleteReviewCache(book_id, user_email) + deleteChapterMacroReviewCache(book_id, user_email),
    }))();

    logger.info(
      `History-Reset: book=${book_id} user=${user_email} ` +
      `page_checks=${result.page_checks} book_reviews=${result.book_reviews} ` +
      `chapter_reviews=${result.chapter_reviews} chat_sessions=${result.chat_sessions} ` +
      `werkstatt_runs=${result.werkstatt_runs} rueckblicke=${result.rueckblicke} review_cache=${result.review_cache}`
    );
    res.json({ ok: true, deleted: result });
  });

  // Buchbewertungs-Verlauf: die jüngsten zehn (db/book-reviews.js).
  router.get('/review/:book_id', (req, res) => {
    res.json(listBookReviewHistory(req.bookId, sessionEmail(req)));
  });

  // Tagebuch-Rückblicke eines Buchs: ALLE Läufe als Metadaten (ohne Ergebnis,
  // das lädt /rueckblick-entry/:id beim Öffnen) + das Modell, mit dem ein neuer
  // Lauf jetzt erstellt würde — die Karte bietet damit Neu-Erstellen an, wenn
  // ein Rückblick von einem älteren Modell stammt.
  router.get('/rueckblick/:book_id', (req, res) => {
    const userEmail = sessionEmail(req);
    res.json({
      current_model: _modelName(resolveProvider({ userEmail }), { userEmail }),
      entries: listRueckblicke(req.bookId, userEmail),
    });
  });

  // Volltextsuche im Inhalt der Rückblicke → passende IDs. Die Suche nach dem
  // lokalisierten Zeitraum-Label macht die Karte selbst.
  router.get('/rueckblick-search/:book_id', (req, res) => {
    res.json({ ids: searchRueckblickIds(req.bookId, sessionEmail(req), req.query.q) });
  });

  // Rückblick-Heatmap-Coverage: aggregiert datierte Seiten (Monats-/Jahres-Buckets)
  // + vorhandene KI-Rückblicke des Users zu fertigen Buckets fürs Overview-Tile.
  // Liest nur Metadaten (page_name/page_id) zur Datums-Aggregation — kein Buch-
  // Inhalt (folgt der Praxis von /fehler-heatmap, /style-stats). Kein KI-Call.
  router.get('/rueckblick-coverage/:book_id', (req, res) => {
    const user_email = sessionEmail(req);
    const bookId = req.bookId;
    const pages = listPageNamesForBook(bookId);
    // Jüngster Rückblick je Zeitraum (user-spezifisch — tagebuch_rueckblicke ist persönlich).
    const rbRows = db.prepare(`
      WITH ranked AS (
        SELECT id, zeitraum, created_at,
               ROW_NUMBER() OVER (PARTITION BY zeitraum ORDER BY created_at DESC, id DESC) AS rn
        FROM tagebuch_rueckblicke
        WHERE book_id = ? AND user_email = ?
      )
      SELECT id, zeitraum, created_at FROM ranked WHERE rn = 1
    `).all(bookId, user_email);
    res.json(buildRueckblickCoverage(pages, rbRows));
  });

  // Kapitel-Reviews: gruppiert als { [chapter_id]: [entries] }, je Kapitel die
  // jüngsten zehn (db/chapter-reviews.js).
  router.get('/chapter-reviews/:book_id', (req, res) => {
    res.json(listChapterReviewHistory(req.bookId, sessionEmail(req)));
  });

  // Einzelnes Kapitel-Review löschen
  router.delete('/chapter-review/:id', (req, res) => {
    const id = toIntId(req.params.id);
    if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
    deleteChapterReview(id, sessionEmail(req));
    res.json({ ok: true });
  });
}

module.exports = { register };
