'use strict';
// Verworfene Kontinuitäts-Befunde sichtbar statt still (docs/komplett.md, Phase 8):
//
// continuity_issues.discard_reason: warum die Pipeline einen gemeldeten Befund selbst
//   verworfen hat — 'entwarnung' (das Modell setzte entwarnung=true), 'zitat' (Beleg-
//   Zitat im Buchtext nicht auffindbar, Single-Pass) oder 'verify' (Verify-Stufe:
//   bestaetigt=false gegen den Originaltext). NULL = kein Pipeline-Verwurf.
// continuity_issues.discard_detail: Begründung dazu (Verify-`grund`), sonst NULL.
//
// Ein verworfener Befund trägt zugleich dismissed = 1: jeder Leser, der nur offene
// Befunde will (Buch-Chat, Plot-/Review-Kontext, Zähler), filtert ihn damit schon über
// das bestehende Flag. Unterschieden von «kein Fehler» des Autors wird er über
// discard_reason — die Triage-Übernahme (lib/continuity-carryover.js) liest nur
// Autoren-Entscheidungen, nie einen Pipeline-Verwurf. «Doch ein Fehler» setzt beide
// zurück (dismissed = 0, discard_reason = NULL).
module.exports = {
  version: 322,
  up(db) {
    const cols = new Set(db.prepare('PRAGMA table_info(continuity_issues)').all().map(c => c.name));
    if (!cols.has('discard_reason')) {
      db.exec(`ALTER TABLE continuity_issues ADD COLUMN discard_reason TEXT
        CHECK(discard_reason IS NULL OR (discard_reason IN ('entwarnung','zitat','verify') AND dismissed = 1))`);
    }
    if (!cols.has('discard_detail')) db.exec('ALTER TABLE continuity_issues ADD COLUMN discard_detail TEXT');
  },
};
