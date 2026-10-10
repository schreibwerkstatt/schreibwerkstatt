'use strict';
const express = require('express');
const {
  deleteChapterExtractCache,
  deleteCheckpoint,
  getLatestContinuityCheck,
  setContinuityIssueResolved,
  setContinuityIssueDismissed,
  getChapterNarrativeProfile,
  getKomplettScope, saveKomplettScope,
  } = require('../../../db/schema');
const { getNarrativeReport, getAutorenBefund } = require('../../../db/narrative-report');
const { getContinuityIssueScope } = require('../../../db/continuity');
const { getBookSettings } = require('../../../db/schema');
const { toIntId } = require('../../../lib/validate');
const { resolveProvider, effectiveProviderClass } = require('../../../lib/ai');
const appSettings = require('../../../lib/app-settings');
const { guardBook, aclParamGuard, sessionEmail, resolveBookRole } = require('../../../lib/acl');
const { jsonBody, createJob, enqueueJob, findActiveJobId } = require('../shared');
const { runKomplettAnalyseJob, runKontinuitaetJob, runErzaehlprofilJob, runFaktencheckJob, runKomplettAnalyseAll } = require('./job');
const { normalizeKomplettScope } = require('../../../lib/komplett-scope');
const { activeStepJob } = require('./scope');
const logger = require('../../../logger');

const komplettRouter = express.Router();
// :book_id-Routes: viewer+ über den Param-Guard; DELETE chapter-cache verlangt im
// Handler zusätzlich editor+ (guardBook).
komplettRouter.param('book_id', aclParamGuard('viewer'));

// Prüf-Jobs (Kontinuität, Erzählprofil) lesen den Katalog. Läuft für Buch + User eine
// Komplettanalyse, schreibt sie ihn gerade neu — dann startet die Prüfung nicht parallel,
// sondern antwortet 409 KOMPLETT_ANALYSIS_RUNNING. Ist der Schritt im Umfang der Analyse,
// reiht diese die Prüfung nach dem Katalog selbst ein (./pruef-jobs.js); sonst nach ihrem
// Ende erneut starten. Gegenrichtung (Analyse gegen laufende Prüfung): scope.js#activeStepJob.
function _komplettDedup(res, bookId, userEmail) {
  const komplettId = findActiveJobId('komplett-analyse', bookId, userEmail);
  if (!komplettId) return false;
  res.status(409).json({ error_code: 'KOMPLETT_ANALYSIS_RUNNING', jobId: komplettId, params: { jobId: komplettId } });
  return true;
}

// Triage-Vorspann der Issue-Routen: Issue laden; ohne Leserecht am Buch antwortet die
// Route wie bei einer unbekannten ID (404 — sonst verriete 403 die Existenz des Issues
// in einem fremden Buch); dann Buch-Rolle editor+ (guardBook — antwortet ohne Anmeldung
// selbst mit 401 und setzt den `book`-Slot des Log-Contexts, lib/acl.js), zuletzt Besitz
// (Checks sind pro Buch + User geführt; ein fremdes Issue ist ebenfalls 404).
// Antwortet selbst und liefert null, sonst die Issue-ID.
function _issueForTriage(req, res) {
  const issueId = toIntId(req.params.issue_id);
  if (!issueId) { res.status(400).json({ error_code: 'INVALID_ISSUE_ID' }); return null; }
  const scope = getContinuityIssueScope(issueId);
  const unreadable = scope && sessionEmail(req) && !resolveBookRole(req, scope.book_id);
  if (!scope || unreadable) { res.status(404).json({ error_code: 'ISSUE_NOT_FOUND' }); return null; }
  if (!guardBook(req, res, scope.book_id, 'editor')) return null;
  if ((scope.user_email || null) !== (sessionEmail(req) || null)) {
    res.status(404).json({ error_code: 'ISSUE_NOT_FOUND' });
    return null;
  }
  return issueId;
}

// ── Routen ────────────────────────────────────────────────────────────────────
komplettRouter.post('/komplett-analyse', jsonBody, (req, res) => {
  const { book_name } = req.body;
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  if (!guardBook(req, res, book_id, 'editor')) return;
  const userEmail = sessionEmail(req);
  const existing = findActiveJobId('komplett-analyse', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  // Lauf-Umfang (Teil-Lauf): welche Schritte dieser Lauf neu berechnet. Katalog +
  // Normalisierung in lib/komplett-scope.js; fehlt `scope`, läuft alles (unverändertes
  // Verhalten für bestehende Aufrufer und den Nacht-Cron).
  //
  // Der gestartete Umfang wird zugleich zur Vorbelegung des nächsten Laufs: ein Wert,
  // ein Schreiber. Ein separat gespeicherter „Standard" neben dem zuletzt gestarteten
  // Umfang wären zwei Zustände, von denen der sichtbare nicht zwingend der wirksame ist.
  const scope = normalizeKomplettScope(req.body?.scope);
  // Läuft ein Prüf-Job, nicht parallel starten: er läse den Katalog, während die Analyse
  // ihn neu schreibt — vor saveKomplettScope, damit ein abgewiesener Start die
  // Vorbelegung nicht verschiebt.
  const stepJob = activeStepJob(book_id, userEmail);
  if (stepJob) {
    return res.status(409).json({ error_code: 'KOMPLETT_STEP_JOB_RUNNING', jobId: stepJob.jobId, step: stepJob.step });
  }
  saveKomplettScope(book_id, userEmail, scope);
  // «Neu erstellen statt aktualisieren»: Delta-Cache UND Konsolidierungs-Checkpoint
  // leeren, damit die Extraktion wirklich neu läuft. Derselbe Schreibpfad wie der
  // Knopf «Cache leeren» — kein zweiter.
  if (req.body?.force === true) {
    const deleted = deleteChapterExtractCache(book_id, userEmail || '');
    deleteCheckpoint('komplett-consolidation', book_id, userEmail || '');
    deleteCheckpoint('komplett-singlepass-truncated', book_id, userEmail || '');
    logger.info(`Komplettanalyse: Neu-Erstellung angefordert – ${deleted} Cache-Eintraege geleert.`);
  }
  const label = book_name ? 'job.label.komplettBook' : 'job.label.komplett';
  const labelParams = book_name ? { name: book_name } : null;
  const jobId = createJob('komplett-analyse', book_id, userEmail, label, labelParams);
  // provider bleibt undefined (Slot 6) — den setzt nur der Nacht-Cron; opts folgt dahinter.
  enqueueJob(jobId, () => runKomplettAnalyseJob(jobId, book_id, book_name || '', userEmail,
    undefined, { scope }));
  res.json({ jobId });
});

komplettRouter.post('/kontinuitaet', jsonBody, (req, res) => {
  const { book_name } = req.body;
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  if (!guardBook(req, res, book_id, 'editor')) return;
  const userEmail = sessionEmail(req);
  // Kontinuitätsprüfung braucht die Cloud-KLASSE (Single-Pass, Verify-Filter,
  // Attribut-Check setzen ein faehiges Modell voraus — keine Anthropic-API-Faehigkeit).
  // Dieselbe Entscheidung wie `/config` komplett.continuity und das Ueberspringen der
  // Phase im Job; dieser Guard erzwingt sie serverseitig (Defense-in-depth).
  if (effectiveProviderClass({ userEmail }) !== 'cloud') return res.status(400).json({ error_code: 'CONTINUITY_PROVIDER_UNSUPPORTED' });
  if (_komplettDedup(res, book_id, userEmail)) return;
  const existing = findActiveJobId('kontinuitaet', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const label = book_name ? 'job.label.kontinuitaetBook' : 'job.label.kontinuitaet';
  const labelParams = book_name ? { name: book_name } : null;
  const jobId = createJob('kontinuitaet', book_id, userEmail, label, labelParams);
  enqueueJob(jobId, () => runKontinuitaetJob(jobId, book_id, book_name || '', userEmail));
  res.json({ jobId });
});

komplettRouter.get('/kontinuitaet/:book_id', (req, res) => {
  res.json(getLatestContinuityCheck(req.bookId, sessionEmail(req)));
});

// Issue als erledigt/offen markieren (editor+, eigener Check). Gilt nur für diesen Lauf:
// findet ein späterer Lauf den Befund wieder, ist er nicht behoben und steht offen.
// book_id wird aus dem Issue aufgeloest, da kein :book_id-Param vorliegt -> _issueForTriage
// statt aclParamGuard.
komplettRouter.post('/kontinuitaet/issue/:issue_id/resolved', jsonBody, (req, res) => {
  const issueId = _issueForTriage(req, res);
  if (!issueId) return;
  const resolved = !!req.body?.resolved;
  setContinuityIssueResolved(issueId, resolved);
  res.json({ ok: true, resolved });
});

// Issue als „kein Fehler" (Fehlalarm) markieren bzw. das aufheben (editor+). Anders als
// „erledigt" übernehmen spätere Läufe diesen Status für denselben Befund; massgeblich
// ist dessen jüngste Zeile, ein Aufheben gilt also auch für alle Folgeläufe
// (db/continuity.js#_priorIssues + lib/continuity-carryover.js).
komplettRouter.post('/kontinuitaet/issue/:issue_id/dismissed', jsonBody, (req, res) => {
  const issueId = _issueForTriage(req, res);
  if (!issueId) return;
  const dismissed = !!req.body?.dismissed;
  setContinuityIssueDismissed(issueId, dismissed);
  res.json({ ok: true, dismissed });
});

// Weltfakten-Realitätscheck eigenständig starten — editor+. Prüft die extrahierten
// Welt-Fakten mit Web-Suche gegen die reale Faktenlage. Claude-only (web_search ist
// Server-Tool), Instanz-Kill-Switch ai.komplett.factcheck, Buch-Opt-in weltfakten_real_pruefen.
komplettRouter.post('/faktencheck', jsonBody, (req, res) => {
  const { book_name } = req.body;
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  if (!guardBook(req, res, book_id, 'editor')) return;
  const userEmail = sessionEmail(req);
  if (resolveProvider({ userEmail }) !== 'claude') return res.status(400).json({ error_code: 'FACTCHECK_CLAUDE_ONLY' });
  // Default aus (lib/app-settings/keys/ai.js) — dieselbe Lesart wie /config komplett.factcheck.
  if (appSettings.get('ai.komplett.factcheck') !== true) return res.status(400).json({ error_code: 'FACTCHECK_DISABLED' });
  if (!getBookSettings(book_id, userEmail)?.weltfakten_real_pruefen) return res.status(400).json({ error_code: 'FACTCHECK_NOT_ENABLED_FOR_BOOK' });
  // Der Faktencheck ist kein Schritt der Komplettanalyse, liest aber deren Fakten-Index und
  // hängt an deren Kontinuitäts-Check: während eines Laufs nicht starten.
  const komplettId = findActiveJobId('komplett-analyse', book_id, userEmail);
  if (komplettId) return res.status(409).json({ error_code: 'KOMPLETT_ANALYSIS_RUNNING', jobId: komplettId, params: { jobId: komplettId } });
  const existing = findActiveJobId('faktencheck', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const label = book_name ? 'job.label.faktencheckBook' : 'job.label.faktencheck';
  const labelParams = book_name ? { name: book_name } : null;
  const jobId = createJob('faktencheck', book_id, userEmail, label, labelParams);
  enqueueJob(jobId, () => runFaktencheckJob(jobId, book_id, book_name || '', userEmail));
  res.json({ jobId });
});

// Erzählprofil eigenständig neu berechnen (nur die Phase «Erzählprofil», ohne die
// volle Extraktions-Pipeline) — editor+. Nutzt den vorhandenen Figuren-Katalog.
komplettRouter.post('/erzaehlprofil', jsonBody, (req, res) => {
  const { book_name } = req.body;
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  if (!guardBook(req, res, book_id, 'editor')) return;
  const userEmail = sessionEmail(req);
  // Erzählprofil braucht die Cloud-Klasse (Single-Pass). Serverseitiger Guard analog
  // Kontinuität (Defense-in-depth), gleiche Entscheidung wie `/config`.
  if (effectiveProviderClass({ userEmail }) !== 'cloud') return res.status(400).json({ error_code: 'NARRATIVE_PROFILE_PROVIDER_UNSUPPORTED' });
  if (_komplettDedup(res, book_id, userEmail)) return;
  const existing = findActiveJobId('erzaehlprofil', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const label = book_name ? 'job.label.erzaehlprofilBook' : 'job.label.erzaehlprofil';
  const labelParams = book_name ? { name: book_name } : null;
  const jobId = createJob('erzaehlprofil', book_id, userEmail, label, labelParams);
  enqueueJob(jobId, () => runErzaehlprofilJob(jobId, book_id, book_name || '', userEmail));
  res.json({ jobId });
});

// Kapitel-Erzählprofil (aus der Komplettanalyse-Phase «Erzählprofil») – viewer+.
komplettRouter.get('/erzaehlprofil/:book_id', (req, res) => {
  const bookId = req.bookId;
  const userEmail = sessionEmail(req);
  const profile = getChapterNarrativeProfile(bookId, userEmail);
  // Deterministischer Buch-Befund (read-time, pure Engine über die Katalog-Zeilen) +
  // gespeicherter KI-Dach-Befund (Autoren-Befund). Beides an dieselbe Antwort gehängt,
  // damit die Karte alles in einem Fetch bekommt. Unter der Kapitel-Schwelle trägt der
  // Befund nur `tooFewChapters` — dann auch keinen (älteren) Autoren-Befund zeigen.
  const befund = profile.chapters.length ? getNarrativeReport(bookId, userEmail) : null;
  const autorenBefund = (befund && !befund.tooFewChapters) ? getAutorenBefund(bookId, userEmail) : null;
  res.json({ ...profile, befund, autorenBefund });
});

// Zuletzt gewaehlter Lauf-Umfang — Vorbelegung des Modals vor dem Start. viewer+,
// weil es eine Lese-Frage ist; geschrieben wird er ausschliesslich beim Starten
// (POST /komplett-analyse), damit es nur einen Schreibpfad gibt.
komplettRouter.get('/komplett-scope/:book_id', (req, res) => {
  res.json({ scope: getKomplettScope(req.bookId, sessionEmail(req)) });
});

komplettRouter.delete('/chapter-cache/:book_id', (req, res) => {
  const bookId = req.bookId;
  if (!guardBook(req, res, bookId, 'editor')) return;
  const userEmail = sessionEmail(req) || '';
  const deleted = deleteChapterExtractCache(bookId, userEmail);
  // F5: den Konsolidierungs-Checkpoint mitlöschen — sonst würde ein Re-Run nach dem Cache-Leeren
  // zwar Phase 1 neu extrahieren, aber (bei gleichem Inhalt) P2–P8 weiterhin überspringen.
  deleteCheckpoint('komplett-consolidation', bookId, userEmail);
  deleteCheckpoint('komplett-singlepass-truncated', bookId, userEmail);
  res.json({ ok: true, deleted });
});

module.exports = { komplettRouter, runKomplettAnalyseAll, runKomplettAnalyseJob, runKontinuitaetJob, runErzaehlprofilJob, runFaktencheckJob };
