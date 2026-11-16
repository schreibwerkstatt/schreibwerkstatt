'use strict';
// Wer einen KI-Call bezahlt: `billed_to` = 'instance' (Key des Betreibers) oder
// 'own' (eigener KI-Zugang des Kontos, lib/ai/profile.js#usesOwnAccess).
// job_runs haelt den Wert ab Job-Start fest (der Zugang kann mitten im Lauf
// wechseln), recordJobLedger uebernimmt ihn ins Ledger. Budget-Gate, /metrics und
// der Anthropic-Rechnungsabgleich zaehlen nur 'instance'; die Profil-Uebersicht
// des Users liest 'own'. Altbestand = 'instance': die Zuordnung frueherer Calls
// ist nicht mehr feststellbar.
module.exports = {
  version: 365,
  up(db) {
    for (const t of ['ai_cost_ledger', 'job_runs']) {
      const cols = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));
      if (!cols.has('billed_to')) {
        db.exec(`ALTER TABLE ${t} ADD COLUMN billed_to TEXT NOT NULL DEFAULT 'instance' CHECK(billed_to IN ('instance','own'))`);
      }
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_ai_cost_ledger_billed_user_ts ON ai_cost_ledger(billed_to, user_email, ts)');
  },
};
