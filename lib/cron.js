'use strict';
// Taegliche Cron-Jobs (node-cron). Registriert beim Boot aus server.js.
//
// Zeitzone explizit aus app.timezone — ohne expliziten Wert läuft node-cron in
// Server-TZ; in manchen LXC-Templates ist die TZ UTC → "23:00" wäre dann
// 00:00/01:00 CH-Zeit.

const logger = require('../logger');
const appSettings = require('./app-settings');
const { runWithContext } = require('./log-context');
const { cleanupStuckJobRuns } = require('../db/schema');
const { syncAllBooks } = require('../routes/sync');
const { runCacheCleanup } = require('./cache-cleanup');
const { reindexAllBooks, whenIndexIdle } = require('../routes/jobs/embed-index');
const { reindexAllUserSources } = require('../routes/jobs/source-embed-index');
const { reindexAllXrefs } = require('./xref-index');
const { scanAllBooks: scanAllMotifs } = require('../routes/jobs/motif-scan');
const { anchorAllBooks: anchorAllBeats } = require('../routes/jobs/beat-anchor');
const { anchorAllDraftFigures } = require('../routes/jobs/figur-anchor');
const { scanAllBooks: scanAllLexicons } = require('../routes/jobs/lexicon-scan');

function _nightlySync() {
  logger.info('Cron: Starte täglichen Buchstatistik-Sync…');
  // Wortschatz-Analyse hängt sich HINTER den Sync (nicht in die Embedding-
  // Kette weiter unten): sie liest reinen Seitentext, keine Vektoren, und
  // braucht dafür den frischen Stand aus dem Sync. Der Delta-Skip
  // (content_sig über die Seiten in Leserichtung) macht den Lauf für
  // unveränderte Bücher praktisch kostenlos.
  syncAllBooks()
    .then(() => scanAllLexicons())
    .catch(e => logger.error('Cron-Sync/Wortschatz Fehler: ' + e.message));

  const stuck = cleanupStuckJobRuns();
  if (stuck > 0) logger.warn(`Cron: ${stuck} hängender Job-Run(s) auf 'error' gesetzt.`);
  else logger.info('Cron: Keine hängenden Job-Runs gefunden.');

  try {
    const summary = runCacheCleanup();
    logger.info(`Cron: Cache-Cleanup entfernt ${summary.totalRemoved} Row(s) aus ${summary.tables.length} Tabellen.`);
  } catch (e) {
    logger.error('Cron Cache-Cleanup Fehler: ' + e.message);
  }

  // FTS5-Optimize. Faltet die Segmente zu einem grossen B-Tree
  // zusammen — billig nach naechtlichen Schreibern, beschleunigt Querys.
  try {
    require('./search').optimize();
  } catch (e) {
    logger.error('Cron Search-Optimize Fehler: ' + e.message);
  }

  // Abgelaufene page_locks wegraeumen. Funktional ist es nicht
  // noetig (Guards filtern `WHERE expires_at > now`), nur DB-Hygiene.
  try {
    const { purgeExpiredLocks } = require('../db/book-access');
    const removed = purgeExpiredLocks();
    if (removed > 0) logger.info(`Cron: ${removed} abgelaufene page_locks entfernt.`);
  } catch (e) {
    logger.error('Cron page_locks-Cleanup Fehler: ' + e.message);
  }

  // Querverweis-Index nachziehen: holt Bestandsinhalte nach, die seit
  // Einfuehrung des Features nie gespeichert wurden, und heilt Drift, die
  // kein Seiten-Write mehr anfassen wuerde (Verweis auf ein Ziel, das erst
  // spaeter angelegt wurde — siehe Buch-Guard in db/xrefs.js). Kein Job:
  // reine Klempnerei ohne callAI, wie der FTS-Index.
  reindexAllXrefs().catch(e => logger.error('Cron Querverweis-Index Fehler: ' + e.message));

  // Semantische Suche: Embedding-Indizes aller Bücher frisch halten. Reiht
  // pro Buch einen Job ein (Delta-Cache → nur geänderte Chunks neu
  // embeddet); nie-indizierte Bücher bekommen ihren Erst-Index. Danach den
  // Motiv-Ist-Index + Plot-Beat- + Figurenbogen-Verankerung nachziehen
  // (motif-scan / beat-anchor / figur-anchor pro Buch/User). Die Queue arbeitet
  // mehrere Jobs parallel ab — eingereiht direkt hinter den Embed-Jobs, läse ein
  // Scan den Index eines Buchs, dessen Lauf noch im anderen Slot steckt, und
  // ersetzte seine Fundstellen durch ein Teilergebnis. Darum erst warten, bis
  // jeder Index-Lauf durch ist. Keiner ruft callAI; sie nutzen nur den
  // Embedding-/FTS-Index.
  reindexAllBooks()
    .then(({ bookIds = [] } = {}) => Promise.all(bookIds.map(id => whenIndexIdle(id))))
    .then(() => scanAllMotifs())
    .then(() => anchorAllBeats())
    .then(() => anchorAllDraftFigures())
    .catch(e => logger.error('Cron Embedding-Reindex/Motiv-Scan/Beat-/Figur-Anchor Fehler: ' + e.message));

  // Quellen-PDF-Index zieht nach dem Buch-Index nach (eigene Tabelle, eigener
  // Job — user-skopiert, nicht buchskopiert). Delta-Cache hält billig, was
  // schon indiziert war; frisch hochgeladene PDFs bekommen Erst-Index.
  reindexAllUserSources()
    .catch(e => logger.error('Cron Quellen-Embedding-Reindex Fehler: ' + e.message));
}

function registerCrons() {
  let cron;
  try { cron = require('node-cron'); }
  catch {
    logger.warn('node-cron nicht verfügbar – keine automatischen Cron-Jobs (npm install ausführen)');
    return;
  }
  const cronTz = appSettings.get('app.timezone') || 'Europe/Zurich';
  const asCron = (fn) => () => runWithContext({ job: 'cron', user: 'system' }, fn);

  // 23:00 – Buchstatistik-Sync + hängende Jobs bereinigen + TTL-Cache-Cleanup.
  // Tagesscharfe Statistik: recorded_at am Tag X reflektiert Inhalte vom Tag X.
  cron.schedule('0 23 * * *', asCron(_nightlySync), { timezone: cronTz });
  logger.info(`Cron-Job registriert: Buchstatistik-Sync + Job-Cleanup + Cache-TTL-Cleanup + page_locks-Purge täglich 23:00 (${cronTz})`);

  // 02:30 – pending registration_requests aelter als N Tage auf
  // 'expired' setzen. Default 30 Tage; konfigurierbar via app_settings
  // auth.registration.expire_days. Status-Wechsel ohne Mail (siehe Spec).
  cron.schedule('30 2 * * *', asCron(() => {
    try {
      const regRequests = require('../db/registration-requests');
      const days = Math.max(1, parseInt(appSettings.get('auth.registration.expire_days'), 10) || 30);
      const changed = regRequests.expireStale(days);
      if (changed > 0) logger.info(`Cron: ${changed} pending registration_requests auf 'expired' gesetzt (Schwelle ${days} Tage).`);
    } catch (e) {
      logger.error('Cron registration-expire Fehler: ' + e.message);
    }
  }), { timezone: cronTz });
  logger.info(`Cron-Job registriert: registration_requests-Expire täglich 02:30 (${cronTz})`);

  // 05:15 – Anthropic-Kosten aus der Cost-Report-API nachziehen (Abgleich
  // gegen das Ledger, Admin-Usage → Abrechnung). No-op ohne Admin-Key.
  cron.schedule('15 5 * * *', asCron(() => {
    require('./anthropic-billing').syncBilling()
      .catch(e => logger.error('Cron Anthropic-Billing Fehler: ' + (e.code || e.message)));
  }), { timezone: cronTz });
  logger.info(`Cron-Job registriert: Anthropic-Kostenabgleich täglich 05:15 (${cronTz})`);

  // Nacht-Komplettanalyse für alle Bücher × alle User ist bewusst NICHT
  // registriert (runKomplettAnalyseAll in routes/jobs). Bei Reaktivierung wie
  // oben über asCron() einhängen, damit die enqueue-Logs den ALS-Context tragen.
}

module.exports = { registerCrons };
