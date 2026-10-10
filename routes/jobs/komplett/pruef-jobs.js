'use strict';
// Prüfung nach dem Katalog: Kontinuität und Erzählprofil laufen als EIGENE Jobs, die die
// Komplettanalyse nach dem Katalog einreiht — nicht mehr als Phasen in ihr.
//
// Why: als Phasen hingen sie am Konsolidierungs-Checkpoint der Katalog-Pipeline. Jede
// Lücke in dessen Signatur (eine Bucheinstellung, die nur die Prüfung liest) schaltete
// die Prüfung still mit ab, und ein Fehler der Prüfung teilte sich die Fehler- und
// Kostenrechnung mit dem Katalog. Als eigene Jobs haben sie ihren eigenen Lebenslauf,
// ihre eigene Kosten-Zeile, erscheinen einzeln in der Job-Liste — und lesen einen
// Katalog, der fertig geschrieben ist.
const { createJob, enqueueJob, findActiveJobId } = require('../shared');
const { providerClass } = require('../../../lib/ai');
const appSettings = require('../../../lib/app-settings');

/** Reiht die gewählten Prüf-Jobs ein. Läuft einer schon (Klick in der Karte während der
 *  Analyse), bleibt es bei diesem. Gibt die eingereihten Job-IDs je Schritt zurück. */
function enqueuePruefJobs({ bookId, bookName, userEmail, scope, provider }) {
  const out = {};
  if (providerClass(provider) !== 'cloud') return out;
  // Lazy: job.js lädt diese Datei über job-komplett.js — ein Top-Level-require wäre zirkulär.
  const { runKontinuitaetJob } = require('./job-kontinuitaet');
  const { runErzaehlprofilJob } = require('./job-erzaehlprofil');
  const labelParams = bookName ? { name: bookName } : null;
  if (scope.kontinuitaet) {
    const existing = findActiveJobId('kontinuitaet', bookId, userEmail);
    if (existing) out.kontinuitaet = existing;
    else {
      const jobId = createJob('kontinuitaet', bookId, userEmail,
        bookName ? 'job.label.kontinuitaetBook' : 'job.label.kontinuitaet', labelParams);
      enqueueJob(jobId, () => runKontinuitaetJob(jobId, bookId, bookName || '', userEmail));
      out.kontinuitaet = jobId;
    }
  }
  if (scope.erzaehlprofil && appSettings.get('ai.komplett.narrative_profile') !== false) {
    const existing = findActiveJobId('erzaehlprofil', bookId, userEmail);
    if (existing) out.erzaehlprofil = existing;
    else {
      const jobId = createJob('erzaehlprofil', bookId, userEmail,
        bookName ? 'job.label.erzaehlprofilBook' : 'job.label.erzaehlprofil', labelParams);
      enqueueJob(jobId, () => runErzaehlprofilJob(jobId, bookId, bookName || '', userEmail));
      out.erzaehlprofil = jobId;
    }
  }
  return out;
}

module.exports = { enqueuePruefJobs };
