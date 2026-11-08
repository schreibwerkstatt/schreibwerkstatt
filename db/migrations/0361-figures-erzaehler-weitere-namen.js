'use strict';
// Zwei Analyse-Felder an der Figur (docs/komplett.md «Figuren-Stammdaten», docs/figur-alter.md):
//
// figures.ist_erzaehler: die Figur ist die Ich-Erzählstimme des Buchs. Die Extraktion
//   markiert sie; die Alters-Analyse ordnet Ich-Sätze der Erzählung (ausserhalb direkter
//   Rede) dieser Figur zu, wenn das Buch auf Ich-Perspektive steht. Gilt als kuratiertes
//   Feld: eine Korrektur des Autors gewinnt gegen den nächsten Lauf (CURATED_FIELDS).
//
// figures.weitere_namen: JSON-Array weiterer Ruf- und Spitznamen aus dem Text («Lotti»
//   neben Name «Charlotte» und Kurzname «Lotte»). Bewusst NICHT figure_aliases — die
//   hält nur vom Autor bestätigte Namen (manuelles Zusammenführen) und steuert den
//   Cross-Run-Abgleich; ein geratener Rufname gehört nicht in die Identitätsachse.
//   Gelesen von Erwähnungs-Index und Alters-Analyse (lib/page-index.js#buildFigureNamePatterns).
module.exports = {
  version: 361,
  up(db) {
    const cols = new Set(db.prepare('PRAGMA table_info(figures)').all().map(c => c.name));
    if (!cols.has('ist_erzaehler')) {
      db.exec('ALTER TABLE figures ADD COLUMN ist_erzaehler INTEGER NOT NULL DEFAULT 0 CHECK(ist_erzaehler IN (0, 1))');
    }
    if (!cols.has('weitere_namen')) db.exec('ALTER TABLE figures ADD COLUMN weitere_namen TEXT');
  },
};
