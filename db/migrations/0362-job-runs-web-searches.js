'use strict';
// job_runs.web_searches: Anzahl der Anthropic-Web-Suchen eines Jobs (server_tool_use
// 'web_search'). Die Suchgebühr gehört zu den Kosten des Laufs — recordJobLedger
// trägt sie ins Ledger (ai_cost_ledger.web_searches), costUsd rechnet sie ein.
// Konsument heute: der Weltfakten-Faktencheck (bis zu drei Suchen je Fakt).
module.exports = {
  version: 362,
  up(db) {
    const cols = new Set(db.prepare('PRAGMA table_info(job_runs)').all().map(c => c.name));
    if (!cols.has('web_searches')) db.exec('ALTER TABLE job_runs ADD COLUMN web_searches INTEGER NOT NULL DEFAULT 0');
  },
};
