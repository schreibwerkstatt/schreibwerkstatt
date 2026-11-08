'use strict';
// Feld-Schutz der Schauplatz-Stammdaten (docs/schauplaetze.md#was-die-analyse-respektiert).
//
// `locations.manual_fields` ist ein JSON-Array der Felder, die der Autor korrigiert
// hat; nur diese lässt der Analyse-Schreibpfad stehen. `manually_edited` bleibt als
// «mindestens ein Feld geschützt» daneben (Badge, Reihen-Übernahme, Bundles).
// `ki_<feld>` (ki_name, ki_typ, …) hält den zuletzt von der Analyse gelieferten Wert —
// daraus stellt «Analyse-Werte übernehmen» wieder her.

const LOC_MANUAL_FIELDS = Object.freeze(['name', 'typ', 'beschreibung', 'stimmung', 'land']);
const KI_COL = Object.freeze(Object.fromEntries(LOC_MANUAL_FIELDS.map(f => [f, 'ki_' + f])));

// Liest `manual_fields` einer Zeile als Set. Altbestand/Bundle ohne Spalte: das
// Zeilen-Flag `manually_edited` schützt dann alle Felder.
function manualFieldSet(row) {
  if (!row) return new Set();
  if (row.manual_fields != null) {
    try {
      const arr = JSON.parse(row.manual_fields);
      if (Array.isArray(arr)) return new Set(arr.filter(f => LOC_MANUAL_FIELDS.includes(f)));
    } catch { /* kaputter Wert → wie ungeschützt */ }
    return new Set();
  }
  return row.manually_edited ? new Set(LOC_MANUAL_FIELDS) : new Set();
}

// Set → Spaltenwert (kanonische Reihenfolge; leer → NULL).
function serializeManualFields(set) {
  const arr = LOC_MANUAL_FIELDS.filter(f => set.has(f));
  return arr.length ? JSON.stringify(arr) : null;
}

module.exports = { LOC_MANUAL_FIELDS, KI_COL, manualFieldSet, serializeManualFields };
