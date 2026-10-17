'use strict';
// Pflichtfeld-Prüfung der Bewertungs-Jobs (Buchbewertung `review.js`,
// Kapitelbewertung `kapitel.js`): beide lesen dieselben Schemas
// (SCHEMA_CHAPTER_ANALYSIS / gesamtnote auf der Skala 1–6) und prüfen sie
// darum an einer Stelle — BEVOR ein Ergebnis in einen Cache geht; ein kaputtes
// Ergebnis im Cache käme sonst bei jedem Lauf wieder.
const { i18nError } = require('./jobs');

// Skala 1.0–6.0; ein Zahl-String wird zur Zahl, sonst wirft die Prüfung.
function normalizeGesamtnote(r) {
  const raw = r?.gesamtnote;
  if (raw == null || raw === '') throw i18nError('job.error.gesamtnoteMissing');
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 6) {
    throw i18nError('job.error.gesamtnoteInvalid', { note: String(raw) });
  }
  r.gesamtnote = n;
  return r;
}

// Eine leere (Teil-)Kapitelanalyse ginge still als «–» in die Synthese ein und
// verzerrte die Note, ohne dass es jemand sieht.
function assertChapterAnalysis(ca, name) {
  const filled = (v) => typeof v === 'string' && v.trim().length > 0;
  if (!ca || !(filled(ca.themen) || filled(ca.funktion_kurz))) {
    throw i18nError('job.error.chapterAnalysisEmpty', { name });
  }
}

module.exports = { normalizeGesamtnote, assertChapterAnalysis };
