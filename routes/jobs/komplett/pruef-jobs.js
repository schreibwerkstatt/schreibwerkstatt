'use strict';
// Prüfung nach dem Katalog: Kontinuität, Erzählprofil, Alters-Analyse sowie Schul- und
// Berufsweg-Vorschlag laufen als EIGENE Jobs, die die Komplettanalyse nach dem Katalog
// einreiht — nicht als Phasen in ihr.
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
const { getBookSchulsystem } = require('../../../db/book-settings');

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
  // Alters-Analyse, Schulweg- und Berufsweg-Vorschlag: lesen den frisch geschriebenen
  // Figurenstamm, schicken nur Kandidatensätze (nicht das ganze Buch, also kein geteilter
  // 1h-Block) und laufen mit jeder Provider-Klasse — darum ausserhalb des Cloud-Gates und
  // ohne Warten auf das Erzählprofil. Die Alters-Analyse ohne `force`: ihr Delta-Skip
  // greift, wenn Text und Figuren seit dem letzten Lauf gleich sind. Die beiden
  // Vorschlags-Jobs schreiben nur Vorschläge, nie den Stand des Autors; `nachKatalog`
  // macht «nichts zu tun» (keine Figuren, kein Schulsystem) zu einem stillen Ende statt
  // einer Fehlermeldung, die der User nicht ausgelöst hat.
  const once = (key, type, label, run) => {
    const existing = findActiveJobId(type, bookId, userEmail);
    if (existing) { out[key] = existing; return; }
    const jobId = createJob(type, bookId, userEmail, label);
    enqueueJob(jobId, () => run(jobId));
    out[key] = jobId;
  };
  if (scope.figurAlter) {
    const { runFigurAlterJob } = require('../figur-alter');
    once('figur-alter', 'figur-alter', 'job.label.figurAlter',
      (jobId) => runFigurAlterJob(jobId, bookId, userEmail));
  }
  // Ohne gespeichertes Schulsystem rechnet das Buch keine Schullaufbahn (Bucheinstellungen
  // › «Schule» aus) — dann gar nicht erst einreihen. Den Buchtyp prüft der Lauf selbst.
  if (scope.schulweg && getBookSchulsystem(bookId)) {
    const { runSchulwegVorschlagJob } = require('../schulweg-vorschlag');
    once('schulweg-vorschlag', 'schulweg-vorschlag', 'job.label.schulwegVorschlag',
      (jobId) => runSchulwegVorschlagJob(jobId, bookId, userEmail, { nachKatalog: true }));
  }
  if (scope.stationen) {
    const { runStationenVorschlagJob } = require('../stationen-vorschlag');
    once('stationen-vorschlag', 'stationen-vorschlag', 'job.label.stationenVorschlag',
      (jobId) => runStationenVorschlagJob(jobId, bookId, userEmail, { nachKatalog: true }));
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
