'use strict';
// Provider/Modell der Job-Läufe ohne Chat-Call korrigieren (Job-Statistik,
// Admin-Nutzung, /metrics-Labels) — Fortsetzung von Migration 329.
//
// createJob trug jedem Job, der nicht in EMBED_JOB_TYPES stand, den Chat-Provider
// samt Modell der Job-Stufe ein — auch Läufen, die nie ein Sprachmodell aufrufen.
// Ab jetzt (routes/jobs/shared/jobs.js):
//  - EMBED_JOB_TYPES (Vektor-Konsumenten: Redundanz-Radar, Buchlandkarte, Motiv-/
//    Beat-/Figuren-Anker) → provider 'embed', model = embed.model
//  - NO_AI_JOB_TYPES (Wortschatz, Exporte, Importe, Blog-Syncs, Link-Prüfung) → NULL
//
// job_runs: eingetragen wird der zum Migrationszeitpunkt aktive `embed.model`
// (Altwert nicht rekonstruierbar, Trade-off wie 329). Nur Läufe ohne Tokens —
// wer Tokens trägt, hat wirklich einen Chat-Call gemacht und bleibt unangetastet.
// ai_cost_ledger: recordJobLedger schreibt für Läufe ohne Tokens ohnehin NULL;
// die Altzeilen davor bekommen dasselbe. USD bleibt (0).
const EMBED_TYPES = ['redundancy', 'book-map', 'motif-scan', 'beat-anchor', 'figur-anchor'];
const NO_AI_TYPES = [
  'lexicon-scan', 'research-link-check',
  'pdf-export', 'epub-export', 'docx-export', 'manuscript-import', 'book-import',
  'blog-import', 'blog-pull', 'blog-push', 'blog-reconcile', 'blog-repull',
  'hubspot-import', 'hubspot-push', 'hubspot-reconcile',
];
const NO_TOKENS = `COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0) + COALESCE(cache_read_in, 0)
  + COALESCE(cache_creation_in, 0) + COALESCE(cache_creation_1h_in, 0) = 0`;

module.exports = {
  version: 366,
  up(db) {
    const hasTable = (name) =>
      !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

    let model = 'bge-m3'; // Registry-Default aus lib/app-settings/keys/app.js
    if (hasTable('app_settings')) {
      const row = db.prepare("SELECT value_json FROM app_settings WHERE key = 'embed.model'").get();
      try {
        const v = JSON.parse(row?.value_json ?? '""');
        if (typeof v === 'string' && v.trim()) model = v.trim();
      } catch { /* unlesbarer Wert: Default gilt weiter */ }
    }
    const inList = (arr) => arr.map(() => '?').join(', ');

    if (hasTable('job_runs')) {
      db.prepare(
        `UPDATE job_runs SET provider = 'embed', model = ?
          WHERE type IN (${inList(EMBED_TYPES)}) AND ${NO_TOKENS}`
      ).run(model, ...EMBED_TYPES);
      db.prepare(
        `UPDATE job_runs SET provider = NULL, model = NULL
          WHERE type IN (${inList(NO_AI_TYPES)}) AND ${NO_TOKENS}`
      ).run(...NO_AI_TYPES);
    }
    if (hasTable('ai_cost_ledger')) {
      const all = [...EMBED_TYPES, ...NO_AI_TYPES];
      db.prepare(
        `UPDATE ai_cost_ledger SET provider = NULL, model = NULL
          WHERE source = 'job' AND type IN (${inList(all)}) AND ${NO_TOKENS}`
      ).run(...all);
    }
  },
};
