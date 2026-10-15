'use strict';
// Provider/Modell der drei Embedding-Job-Typen in job_runs und ai_cost_ledger
// korrigieren (Job-Statistik, Admin-Nutzung, /metrics-Labels, Fertig-Log).
//
// Die Embedding-Läufe fahren keinen Chat-Call, sondern den selbst gehosteten
// /v1/embeddings-Endpunkt. createJob trug für sie bis Migration 329 den globalen
// Chat-Provider samt Modell in den Record — die Auswertung wies für jeden
// Embedding-Lauf Claude aus, obwohl das Embedding-Modell lief. Ab jetzt setzt
// createJob für diese Typen provider = 'embed' und model = `embed.model`
// (EMBED_JOB_TYPES in routes/jobs/shared/jobs.js).
//
// Das Modell der Altläufe ist nicht mehr rekonstruierbar (app_settings_audit führt
// keinen Wertverlauf); eingetragen wird der zum Migrationszeitpunkt aktive Wert —
// derselbe Trade-off wie Migration 117 für die Cache-Provider. Token-Counts und
// USD bleiben unberührt: ein Embedding-Lauf zählt keine Chat-Tokens, costUsd gibt
// für provider != 'claude' 0 zurück.
module.exports = {
  version: 329,
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

    if (hasTable('job_runs')) {
      db.prepare(
        `UPDATE job_runs SET provider = 'embed', model = ?
          WHERE type IN ('embed-index', 'source-embed-index', 'chat-embed-index')`
      ).run(model);
    }
    if (hasTable('ai_cost_ledger')) {
      db.prepare(
        `UPDATE ai_cost_ledger SET provider = 'embed', model = ?
          WHERE type IN ('embed-index', 'source-embed-index', 'chat-embed-index')`
      ).run(model);
    }
  },
};