'use strict';
// Emotionale Nähe einer Figuren-Beziehung (−2 … +2), neben dem Machtverhältnis.
// Das Soziogramm (docs/graph.md) spannt daraus die Federlänge zwischen zwei
// Figuren: der Beziehungstyp allein taugt nicht — eine «versteinerte Ehe» ist
// `ehepartner`, aber nicht nah. Befüllt von der Komplettanalyse und vom Job
// `figuren-naehe`.
//
// Kein Backfill: NULL heisst «nicht eingeschätzt», das Soziogramm fällt dann auf
// den Standardwert des Beziehungstyps zurück (book/beziehung-typen.js#naeheOf).
module.exports = {
  version: 357,
  up(db) {
    const cols = db.prepare('PRAGMA table_info(figure_relations)').all().map(c => c.name);
    if (!cols.includes('naehe')) db.exec('ALTER TABLE figure_relations ADD COLUMN naehe INTEGER');
  },
};
