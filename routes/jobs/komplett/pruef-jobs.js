'use strict';
// Prüfung nach dem Katalog: Kontinuität, Erzählprofil und Alters-Analyse laufen als EIGENE
// Jobs, die die Komplettanalyse nach dem Katalog einreiht — nicht als Phasen in ihr.
//
// Why: als Phasen hingen sie am Konsolidierungs-Checkpoint der Katalog-Pipeline. Jede
// Lücke in dessen Signatur (eine Bucheinstellung, die nur die Prüfung liest) schaltete
// die Prüfung still mit ab, und ein Fehler der Prüfung teilte sich die Fehler- und
// Kostenrechnung mit dem Katalog. Als eigene Jobs haben sie ihren eigenen Lebenslauf,
// ihre eigene Kosten-Zeile, erscheinen einzeln in der Job-Liste — und lesen einen
// Katalog, der fertig geschrieben ist.
const { createJob, enqueueJob, findActiveJobId, jobs } = require('../shared');
const { bus } = require('../shared/events');
const { providerClass } = require('../../../lib/ai');
const appSettings = require('../../../lib/app-settings');

/** Ruft `fn` einmal auf, sobald der Job `jobId` terminal ist (done/error/cancelled —
 *  auch abgebrochen, solange er noch wartete). */
function _afterJobEnds(jobId, fn) {
  const onChange = (job, terminal) => {
    if (!terminal || job.id !== jobId) return;
    bus.off('change', onChange);
    fn();
  };
  bus.on('change', onChange);
}

/** Reiht die gewählten Prüf-Jobs ein. Läuft einer schon (Klick in der Karte während der
 *  Analyse), bleibt es bei diesem. Gibt die eingereihten Job-IDs je Schritt zurück.
 *
 *  Erzählprofil VOR Kontinuität, nicht parallel: beide schicken das ganze Buch als
 *  denselben geteilten 1h-Block. Gleichzeitig gestartet schreibt jeder ihn selbst in den
 *  Cache (~500 K Tokens bei einem Roman, 2× Input-Preis); nacheinander liest die
 *  Kontinuität, was das Erzählprofil (ein Call, ~1 Min) geschrieben hat. Die
 *  Kontinuität bleibt bis dahin «wartend» angelegt; wird sie in der Zeit abgebrochen,
 *  startet sie nicht mehr. */
function enqueuePruefJobs({ bookId, bookName, userEmail, scope, provider }) {
  const out = {};
  // Alters-Analyse: liest den frisch geschriebenen Figurenstamm samt Zeitstrahl, schickt
  // nur Kandidatensätze (nicht das ganze Buch) und läuft mit jeder Provider-Klasse —
  // darum ausserhalb des Cloud-Gates und ohne Warten auf das Erzählprofil. Ohne `force`:
  // ihr Delta-Skip greift, wenn Text und Figuren seit dem letzten Lauf gleich sind.
  if (scope.figurAlter) {
    const { runFigurAlterJob } = require('../figur-alter');
    const existing = findActiveJobId('figur-alter', bookId, userEmail);
    if (existing) out['figur-alter'] = existing;
    else {
      const jobId = createJob('figur-alter', bookId, userEmail, 'job.label.figurAlter');
      enqueueJob(jobId, () => runFigurAlterJob(jobId, bookId, userEmail));
      out['figur-alter'] = jobId;
    }
  }
  if (providerClass(provider) !== 'cloud') return out;
  // Lazy: job.js lädt diese Datei über job-komplett.js — ein Top-Level-require wäre zirkulär.
  const { runKontinuitaetJob } = require('./job-kontinuitaet');
  const { runErzaehlprofilJob } = require('./job-erzaehlprofil');
  const labelParams = bookName ? { name: bookName } : null;
  let erzaehlprofilJobId = null;
  if (scope.erzaehlprofil && appSettings.get('ai.komplett.narrative_profile') !== false) {
    const existing = findActiveJobId('erzaehlprofil', bookId, userEmail);
    if (existing) out.erzaehlprofil = existing;
    else {
      const jobId = createJob('erzaehlprofil', bookId, userEmail,
        bookName ? 'job.label.erzaehlprofilBook' : 'job.label.erzaehlprofil', labelParams);
      enqueueJob(jobId, () => runErzaehlprofilJob(jobId, bookId, bookName || '', userEmail));
      out.erzaehlprofil = erzaehlprofilJobId = jobId;
    }
  }
  if (scope.kontinuitaet) {
    const existing = findActiveJobId('kontinuitaet', bookId, userEmail);
    if (existing) out.kontinuitaet = existing;
    else {
      const jobId = createJob('kontinuitaet', bookId, userEmail,
        bookName ? 'job.label.kontinuitaetBook' : 'job.label.kontinuitaet', labelParams);
      const start = () => {
        if (jobs.get(jobId)?.status !== 'queued') return;
        enqueueJob(jobId, () => runKontinuitaetJob(jobId, bookId, bookName || '', userEmail));
      };
      if (erzaehlprofilJobId) _afterJobEnds(erzaehlprofilJobId, start);
      else start();
      out.kontinuitaet = jobId;
    }
  }
  return out;
}

module.exports = { enqueuePruefJobs };
