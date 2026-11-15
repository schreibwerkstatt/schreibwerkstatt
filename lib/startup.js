'use strict';
// Einmalige Aufgaben nach `app.listen`: Dev-Zugang, haengende Job-Runs,
// Catch-up des taeglichen Statistik-Syncs.

const logger = require('../logger');
const { runWithContext } = require('./log-context');
const { localIsoDate, localHour, currentTz, isoAddDays } = require('./local-date');

// Uhrzeit des Nachtlaufs (lib/cron.js): 00:05 lokal, schreibt den Snapshot des Vortags.
const NIGHTLY_MINUTE_OF_DAY = 5;

/** Snapshot-Tag des letzten erwarteten Nachtlaufs als lokales ISO-Datum (app.timezone):
 *  gestern, wenn der heutige 00:05-Lauf schon fällig war, sonst vorgestern.
 *  `book_stats_history.recorded_at` ist ein lokales Datum (routes/sync.js) — Uhrzeit
 *  und Datum muessen darum beide aus derselben Zeitzone kommen, sonst feuert der
 *  Catch-up in UTC-Containern zur falschen Stunde oder vergleicht gegen den falschen Tag. */
function catchUpCutoff(now = new Date(), tz = currentTz()) {
  const today = localIsoDate(now, tz);
  const minuteOfDay = localHour(now, tz) * 60 + Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, minute: '2-digit' }).format(now));
  return isoAddDays(today, minuteOfDay >= NIGHTLY_MINUTE_OF_DAY ? -1 : -2);
}

function bootstrapDevAccess(stage, { localDevMode }) {
  if (!localDevMode) return;
  const { db } = require('../db/schema');
  const appUsers = require('../db/app-users');
  const bookAccess = require('../db/book-access');
  const email = 'dev@local';
  try {
    if (!appUsers.getUser(email)) {
      appUsers.createUser({ email, displayName: 'Dev (lokal)', globalRole: 'admin', status: 'active', markChangelogSeen: false });
    }
    appUsers.touchLogin(email, 'Dev (lokal)');
    const books = db.prepare('SELECT book_id FROM books').all();
    let granted = 0;
    for (const { book_id } of books) {
      if (!bookAccess.getBookRole(book_id, email)) {
        bookAccess.grantAccess(book_id, email, 'owner', 'system');
        granted++;
      }
    }
    if (granted > 0) {
      logger.info(`LOCAL_DEV_MODE (${stage}): ${granted} Buch/Bücher für ${email} als owner freigeschaltet.`);
    }
  } catch (e) {
    logger.warn(`bootstrapDevAccess (${stage}): ${e.message}`);
  }
}

function runStartupTasks({ localDevMode = false } = {}) {
  const { db, cleanupStuckJobRuns } = require('../db/schema');
  const { syncAllBooks } = require('../routes/sync');

  bootstrapDevAccess('boot', { localDevMode });

  // Hängende Job-Runs aus dem letzten Server-Leben bereinigen
  const stuck = cleanupStuckJobRuns();
  if (stuck > 0) logger.warn(`Startup: ${stuck} hängender Job-Run(s) auf 'error' gesetzt.`);

  // Catch-up: nächtlichen Sync nachholen, falls der Server zur Cron-Zeit aus war.
  // Geschrieben wird der Snapshot-Tag des verpassten Laufs.
  let syncPromise = Promise.resolve();
  try {
    const cutoff = catchUpCutoff();
    const row = db.prepare('SELECT MAX(recorded_at) AS last FROM book_stats_history').get();
    if (!row?.last || row.last < cutoff) {
      logger.info(`Startup: book_stats_history letzter Eintrag ${row?.last || 'nie'} – hole Sync nach.`);
      syncPromise = runWithContext({ job: 'cron', user: 'system' }, () =>
        syncAllBooks({ day: cutoff }).catch(e => logger.error('Startup-Sync Fehler: ' + e.message))
      );
    } else {
      logger.info('Startup: Sync aktuell – kein Catch-up nötig.');
    }
  } catch (e) {
    logger.error('Startup-Catch-up Fehler: ' + e.message);
  }

  return syncPromise.finally(() => {
    bootstrapDevAccess('post-sync', { localDevMode });
  });
}

module.exports = { runStartupTasks, bootstrapDevAccess, catchUpCutoff };
