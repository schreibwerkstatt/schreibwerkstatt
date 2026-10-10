'use strict';
// „Meine Statistik" (Karte myStatsCard): aggregierte Kennzahlen ueber alle
// eigenen Buecher. Submodul von routes/usersettings.js (Mount `/me`).
// Kennzahl-Definitionen + Datenquellen: docs/my-stats.md.

const appUsers = require('../../db/app-users');
const { db } = require('../../db/schema');
const { listBookIdsForUser } = require('../../db/book-access');
const bookCategories = require('../../db/book-categories');
const { localIsoDate, localIsoDaysAgo } = require('../../lib/local-date');
const logger = require('../../logger');
const { sessionEmail } = require('../../lib/acl');
const contentStore = require('../../lib/content-store');

/** Eigene Buecher des Users (role=owner), bereinigt um Buecher mit
 *  book_settings.exclude_from_stats=1 (z.B. Testbuecher). Basis fuer beide
 *  Profile-Stats-Routen. */
function ownedBooksForStats(email) {
  const owned = listBookIdsForUser(email)
    .filter(r => r.role === 'owner')
    .map(r => r.book_id);
  if (!owned.length) return owned;
  const ph = owned.map(() => '?').join(',');
  const excluded = new Set(
    db.prepare(`SELECT book_id FROM book_settings WHERE exclude_from_stats = 1 AND book_id IN (${ph})`)
      .all(...owned).map(r => r.book_id)
  );
  return owned.filter(id => !excluded.has(id));
}

function register(router) {
  /**
   * Aggregierte Schreib-Statistik ueber ALLE eigenen Buecher (role='owner').
   * Inhalts-Kennzahlen (chars/words/tok/pages) live aus `page_stats` — gleiche
   * Quelle wie admin-books, frischer als der Tages-Snapshot. Kapitel-Anzahl aus
   * dem letzten `book_stats_history`-Snapshot pro Buch (taeglich synchronisiert).
   * Schreibzeit aus `writing_time` (per-User). `page_stats`/`book_stats_history`/
   * `writing_time` sind Cache-/Aggregat-Tabellen (kein Content-Store-Verstoss).
   */
  router.get('/profile-stats', async (req, res) => {
    const email = sessionEmail(req);
    const owned = ownedBooksForStats(email);
    const goalMin = appUsers.getUser(email)?.daily_goal_minutes ?? null;
    const empty = { books: 0, chapters: 0, pages: 0, chars: 0, words: 0, unique_words: 0, tok: 0, writing_seconds: 0, lektorat_seconds: 0, today_writing_seconds: 0, daily_goal_minutes: goalMin, by_hour: [], books_detail: [], lektorat: null };
    if (!owned.length) return res.json(empty);
    try {
      const ph = owned.map(() => '?').join(',');
      const content = db.prepare(`
        SELECT COALESCE(SUM(chars), 0) AS chars,
               COALESCE(SUM(words), 0) AS words,
               COALESCE(SUM(tok),   0) AS tok,
               COUNT(*)                AS pages
        FROM page_stats WHERE book_id IN (${ph})
      `).get(...owned);
      // Letzter Snapshot pro Buch (MAX(recorded_at)) — daraus chapter_count +
      // unique_words summieren (Wortschatz; ueber Buecher summiert = Naeherung,
      // gleiche Konvention wie chars).
      const snap = db.prepare(`
        SELECT COALESCE(SUM(bsh.chapter_count), 0) AS chapters,
               COALESCE(SUM(bsh.unique_words), 0)  AS unique_words
        FROM book_stats_history bsh
        JOIN (
          SELECT book_id, MAX(recorded_at) AS mx
          FROM book_stats_history WHERE book_id IN (${ph}) GROUP BY book_id
        ) m ON m.book_id = bsh.book_id AND m.mx = bsh.recorded_at
      `).get(...owned);
      const wt = db.prepare(`
        SELECT COALESCE(SUM(seconds), 0) AS writing_seconds
        FROM writing_time WHERE user_email = ? AND book_id IN (${ph})
      `).get(email, ...owned);
      // Lektoratszeit (Ueberarbeiten) pro User — Gegenstueck zur Schreibzeit.
      const lt = db.prepare(`
        SELECT COALESCE(SUM(seconds), 0) AS lektorat_seconds
        FROM lektorat_time WHERE user_email = ? AND book_id IN (${ph})
      `).get(email, ...owned);
      // Heute geschriebene Sekunden (live) — Basis fuer den Tagesziel-Fortschritt.
      const todayWt = db.prepare(`
        SELECT COALESCE(SUM(seconds), 0) AS s
        FROM writing_time WHERE user_email = ? AND book_id IN (${ph}) AND date = ?
      `).get(email, ...owned, localIsoDate());
      // Tageszeit-Histogramm (Sekunden je Stunde 0-23, lebenslang ueber alle Buecher).
      const byHour = db.prepare(`
        SELECT hour, COALESCE(SUM(seconds), 0) AS seconds
        FROM writing_hour WHERE user_email = ? AND book_id IN (${ph})
        GROUP BY hour ORDER BY hour ASC
      `).all(email, ...owned);
      // Pro-Buch-Detail fuer die Ziel-Uebersicht: live geschriebener Umfang aus
      // page_stats (Cache-Tabelle, kein Content-Store-Verstoss) + die drei
      // Ziel-Felder aus book_settings (Settings, kein Buchinhalt). Buchnamen kommen
      // im Frontend aus der Root-Buchliste (Content-Store-Regel). Es erscheinen
      // ALLE eigenen Buecher (auch ohne Ziel / ohne Inhalt) — Left-Join-Semantik
      // ueber `owned`, damit der Ueberblick vollstaendig ist.
      const perBookRows = db.prepare(`
        SELECT book_id,
               COALESCE(SUM(chars), 0) AS chars,
               COALESCE(SUM(words), 0) AS words,
               COUNT(*)                AS pages
        FROM page_stats WHERE book_id IN (${ph}) GROUP BY book_id
      `).all(...owned);
      const goalRows = db.prepare(`
        SELECT book_id, daily_goal_chars, goal_target_chars, goal_deadline, is_finished
        FROM book_settings WHERE book_id IN (${ph})
      `).all(...owned);
      // Lektorat-Qualitaet: Fundstellen aus dem JEWEILS juengsten page_checks-Eintrag
      // je Seite (= aktueller Befund des Manuskripts) ueber alle eigenen Buecher.
      // Trend = Vergleich des Schnitts pro gepruefter Seite gegen den Stand vor 30
      // Tagen (richtungsneutral, analog Lesbarkeit). `perNormpage` nutzt den
      // aktuellen Zeichenstand (page_stats) als Naeherung.
      // `checked_at` ist ein ISO-Zeitstempel; der Stichtag ist ein Tagesdatum.
      // `< Folgetag` schliesst den ganzen Stichtag ein (`<= 'YYYY-MM-DD'` liesse
      // jeden Zeitstempel dieses Tages fallen, weil er laenger ist als das Datum).
      const lektoratAgg = (beforeIso) => {
        const cond = beforeIso ? 'AND checked_at < ?' : '';
        const innerArgs = beforeIso ? [...owned, beforeIso] : [...owned];
        const outerArgs = beforeIso ? [...owned, beforeIso] : [...owned];
        return db.prepare(`
          SELECT COUNT(*) AS pages,
                 COALESCE(SUM(lc.error_count), 0) AS findings,
                 COALESCE(SUM(ps.chars), 0)       AS chars
          FROM (
            SELECT pc.page_id, pc.error_count
            FROM page_checks pc
            JOIN (
              SELECT page_id, MAX(checked_at) AS mx
              FROM page_checks WHERE book_id IN (${ph}) ${cond}
              GROUP BY page_id
            ) m ON m.page_id = pc.page_id AND m.mx = pc.checked_at
            WHERE pc.book_id IN (${ph}) ${cond}
          ) lc
          LEFT JOIN page_stats ps ON ps.page_id = lc.page_id
        `).get(...innerArgs, ...outerArgs);
      };
      const ltNow = lektoratAgg(null);
      let lektorat = null;
      if (ltNow && ltNow.pages > 0) {
        const avgPerPage = ltNow.findings / ltNow.pages;
        const perNormpage = ltNow.chars > 0 ? ltNow.findings / (ltNow.chars / 1500) : null;
        const ltPast = lektoratAgg(localIsoDaysAgo(29)); // Stand bis inkl. heute − 30
        let trend = 0;
        if (ltPast && ltPast.pages > 0) {
          const pastAvg = ltPast.findings / ltPast.pages;
          const d = avgPerPage - pastAvg;
          trend = d > 0.2 ? 1 : d < -0.2 ? -1 : 0;
        }
        lektorat = {
          pagesChecked: ltNow.pages,
          totalFindings: ltNow.findings,
          avgPerPage,
          perNormpage,
          trend,
        };
      }

      const perBookMap = new Map(perBookRows.map(r => [r.book_id, r]));
      const goalMap = new Map(goalRows.map(r => [r.book_id, r]));
      // Kategorie je Buch (book_categories-Pool, optional via books.category_id).
      const catMap = bookCategories.getForBooks(owned);
      // Anlagedatum je Buch (Content-Store): das Frontend erkennt daran, ob ein
      // Buch vor einem Zeitraum schon existierte, auch wenn die Snapshot-Historie
      // nicht so weit zurueckreicht (Zeitraum-Umfang „ohne Basis", docs/my-stats.md).
      const ownedSet = new Set(owned);
      const createdMap = new Map((await contentStore.listBooks())
        .filter(b => ownedSet.has(b.id))
        .map(b => [b.id, b.created_at ? String(b.created_at).slice(0, 10) : null]));
      const booksDetail = owned.map((bid) => {
        const c = perBookMap.get(bid) || {};
        const g = goalMap.get(bid) || {};
        const cat = catMap.get(bid) || null;
        return {
          book_id: bid,
          chars: c.chars || 0,
          words: c.words || 0,
          pages: c.pages || 0,
          daily_goal_chars: g.daily_goal_chars ?? null,
          goal_target_chars: g.goal_target_chars ?? null,
          goal_deadline: g.goal_deadline ?? null,
          is_finished: !!g.is_finished,
          created_at: createdMap.get(bid) || null,
          category: cat ? { id: cat.id, name: cat.name, color: cat.color || null } : null,
        };
      });
      res.json({
        books:            owned.length,
        chapters:         snap?.chapters || 0,
        pages:            content?.pages || 0,
        chars:            content?.chars || 0,
        words:            content?.words || 0,
        unique_words:     snap?.unique_words || 0,
        tok:              content?.tok || 0,
        writing_seconds:  wt?.writing_seconds || 0,
        lektorat_seconds: lt?.lektorat_seconds || 0,
        today_writing_seconds: todayWt?.s || 0,
        daily_goal_minutes: goalMin,
        by_hour:          byHour,
        books_detail:     booksDetail,
        lektorat,
      });
    } catch (e) {
      logger.error('[me/profile-stats] DB-Fehler: ' + e.message, { user: email });
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  /**
   * Tages-Zeitreihe fuer den Entwicklungs-Chart — pro Buch aufgeschluesselt.
   * `history`: book_stats_history-Rows aller eigenen Buecher (eine pro (book_id,
   * Tag)). Das Frontend baut daraus sowohl die Gesamt-Kurve (Summe pro Tag) als
   * auch die Pro-Buch-Linien; Buchnamen kommen aus der bereits geladenen
   * Root-Buchliste (kein books-Query hier → Content-Store-Regel).
   * `writing`: Schreib-Sekunden pro (book_id, Tag) (nur aktive Tage).
   * `lektorat`: Lektorats-Sekunden pro (book_id, Tag) (Tagesaggregat aus dem
   * seiten-granularen `lektorat_time`) — fuer den zeitraum-gefilterten Aufwands-Split.
   */
  router.get('/profile-stats-history', (req, res) => {
    const email = sessionEmail(req);
    const owned = ownedBooksForStats(email);
    if (!owned.length) return res.json({ history: [], writing: [], lektorat: [], sessions: [] });
    try {
      const ph = owned.map(() => '?').join(',');
      const history = db.prepare(`
        SELECT book_id, recorded_at, chars, words, tok, page_count, chapter_count, unique_words,
               avg_sentence_len, avg_lix, avg_flesch_de
        FROM book_stats_history WHERE book_id IN (${ph})
        ORDER BY recorded_at ASC
      `).all(...owned);
      const writing = db.prepare(`
        SELECT book_id, date, seconds
        FROM writing_time WHERE user_email = ? AND book_id IN (${ph}) AND seconds > 0
        ORDER BY date ASC
      `).all(email, ...owned);
      // Lektorats-Sekunden pro (book_id, Tag) — lektorat_time ist seiten-granular,
      // hier auf Tagesebene aggregiert. Basis fuer den zeitraum-gefilterten
      // Aufwands-Split (Schreiben vs. Ueberarbeiten) im Frontend.
      const lektorat = db.prepare(`
        SELECT book_id, date, SUM(seconds) AS seconds
        FROM lektorat_time WHERE user_email = ? AND book_id IN (${ph}) AND seconds > 0
        GROUP BY book_id, date
        ORDER BY date ASC
      `).all(email, ...owned);
      // Schreib-Sessions (aus writing_session, aus dem Heartbeat abgeleitet): eine
      // Zeile je zusammenhaengendem Schreibabschnitt. `date` = lokales ISO-Datum des
      // Session-Starts → Zeitraum-Filter im Frontend. Basis fuer Session-Kennzahlen.
      const sessions = db.prepare(`
        SELECT book_id, date, seconds
        FROM writing_session WHERE user_email = ? AND book_id IN (${ph}) AND seconds > 0
        ORDER BY date ASC
      `).all(email, ...owned);
      res.json({ history, writing, lektorat, sessions });
    } catch (e) {
      logger.error('[me/profile-stats-history] DB-Fehler: ' + e.message, { user: email });
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });
}

module.exports = { register, ownedBooksForStats };
