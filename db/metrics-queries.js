'use strict';
// Lese-Abfragen fuer den Metrics-Collector (lib/metrics/). Reine Aggregate —
// keine Inhalte, keine Buchtitel. Liegt in db/, weil einige Abfragen
// `books`/`page_stats` joinen (Besitzer-Zuordnung); der Collector selbst
// fasst keine Tabelle direkt an.

const { db } = require('./connection');
require('./migrations');

const _one = (sql) => { const st = db.prepare(sql); return (...a) => st.get(...a)?.n ?? 0; };
const _all = (sql) => { const st = db.prepare(sql); return (...a) => st.all(...a); };

// ── User ────────────────────────────────────────────────────────────────────
const usersByStatus     = _all('SELECT status, COUNT(*) AS n FROM app_users GROUP BY status');
const usersSeenSince    = _one('SELECT COUNT(*) AS n FROM app_users WHERE last_seen_at >= ?');
const activeUsers       = _all(`SELECT email, display_name, last_seen_at, daily_goal_minutes
                                  FROM app_users WHERE status = 'active' ORDER BY email`);

// ── Inhalt ──────────────────────────────────────────────────────────────────
const countBooks        = _one('SELECT COUNT(*) AS n FROM books');
const countPages        = _one('SELECT COUNT(*) AS n FROM pages');
const countChapters     = _one('SELECT COUNT(*) AS n FROM chapters');
const sumChars          = _one('SELECT COALESCE(SUM(chars),0) AS n FROM page_stats');
const sumWords          = _one('SELECT COALESCE(SUM(words),0) AS n FROM page_stats');
const booksByOwner      = _all(`SELECT owner_email AS email, COUNT(*) AS n FROM books
                                 WHERE owner_email IS NOT NULL GROUP BY owner_email`);
const wordsByOwner      = _all(`SELECT b.owner_email AS email, COALESCE(SUM(ps.words),0) AS n
                                  FROM page_stats ps JOIN books b ON b.book_id = ps.book_id
                                 WHERE b.owner_email IS NOT NULL GROUP BY b.owner_email`);

// Netto-Woerter heute je Buch: aktueller Stand minus letzter Tages-Snapshot vor
// heute (book_stats_history, lokales Datum, Lauf um 23:00). Buecher ohne
// Snapshot (heute neu/importiert) fehlen bewusst — sonst zaehlte ein Import
// als geschriebener Text.
const _wordsTodayByBook = db.prepare(`
  SELECT b.book_id, b.owner_email AS email,
         COALESCE((SELECT SUM(words) FROM page_stats WHERE book_id = b.book_id), 0)
           - h.words AS delta
    FROM books b
    JOIN book_stats_history h ON h.book_id = b.book_id
   WHERE h.recorded_at = (SELECT MAX(recorded_at) FROM book_stats_history
                           WHERE book_id = b.book_id AND recorded_at < ?)
`);
function wordsTodayByBook(today) { return _wordsTodayByBook.all(today); }

// ── Zeiterfassung (lokales Datum) ───────────────────────────────────────────
const _TIME_TABLES = new Set(['writing_time', 'lektorat_time', 'stt_time']);
const _timeTotal = {}, _timeByUser = {};
for (const t of _TIME_TABLES) {
  _timeTotal[t]  = db.prepare(`SELECT COALESCE(SUM(seconds),0) AS n FROM ${t} WHERE date = ?`);
  _timeByUser[t] = db.prepare(`SELECT user_email AS email, COALESCE(SUM(seconds),0) AS n
                                 FROM ${t} WHERE date = ? GROUP BY user_email`);
}
function secondsOn(table, date)       { return _timeTotal[table].get(date).n; }
function secondsByUserOn(table, date) { return _timeByUser[table].all(date); }
const sttCharsOn        = _one('SELECT COALESCE(SUM(chars),0) AS n FROM stt_time WHERE date = ?');

// ── Jobs ────────────────────────────────────────────────────────────────────
const jobRunsByTypeStatus = _all('SELECT type, status, COUNT(*) AS n FROM job_runs GROUP BY type, status');
const jobRunsEndedSince   = _all(`SELECT type, status, COUNT(*) AS n FROM job_runs
                                   WHERE ended_at >= ? GROUP BY type, status`);

// ── Kosten-Ledger (usd zur Call-Zeit eingefroren) ───────────────────────────
const ledgerByModel = _all(`
  SELECT provider, model,
         COALESCE(SUM(tokens_in),0)         AS t_in,
         COALESCE(SUM(tokens_out),0)        AS t_out,
         COALESCE(SUM(cache_read_in),0)     AS c_r,
         COALESCE(SUM(cache_creation_in),0) AS c_w,
         COALESCE(SUM(usd),0)               AS usd
    FROM ai_cost_ledger GROUP BY provider, model`);
const ledgerUsdSince    = _one('SELECT COALESCE(SUM(usd),0) AS n FROM ai_cost_ledger WHERE ts >= ?');
const ledgerUsdByType   = _all(`SELECT source, type, COALESCE(SUM(usd),0) AS n
                                  FROM ai_cost_ledger GROUP BY source, type`);
const ledgerUsdByUser   = _all(`SELECT user_email AS email, COALESCE(SUM(usd),0) AS n
                                  FROM ai_cost_ledger WHERE user_email IS NOT NULL GROUP BY user_email`);
const ledgerUsdByUserSince = _all(`SELECT user_email AS email, COALESCE(SUM(usd),0) AS n
                                     FROM ai_cost_ledger WHERE user_email IS NOT NULL AND ts >= ?
                                    GROUP BY user_email`);

// ── Betrieb ─────────────────────────────────────────────────────────────────
const jsErrorsSince        = _one('SELECT COUNT(*) AS n FROM js_errors WHERE created_at >= ?');
const pendingRegistrations = _one("SELECT COUNT(*) AS n FROM registration_requests WHERE status = 'pending'");
const activeDevices        = _all(`SELECT COALESCE(platform,'unknown') AS platform,
                                          COALESCE(client_version,'unknown') AS client_version,
                                          COUNT(*) AS n
                                     FROM device_tokens
                                    WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
                                    GROUP BY 1, 2`);

module.exports = {
  usersByStatus, usersSeenSince, activeUsers,
  countBooks, countPages, countChapters, sumChars, sumWords,
  booksByOwner, wordsByOwner, wordsTodayByBook,
  secondsOn, secondsByUserOn, sttCharsOn,
  jobRunsByTypeStatus, jobRunsEndedSince,
  ledgerByModel, ledgerUsdSince, ledgerUsdByType, ledgerUsdByUser, ledgerUsdByUserSince,
  jsErrorsSince, pendingRegistrations, activeDevices,
};
