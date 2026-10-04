// Schauplatz-Typen (locations.typ) — SSoT für Typ-Auswahl und -Label im Frontend.
// Reihenfolge = grob nach Massstab (gross → klein), so erscheint sie in der
// Typ-Combobox. Muss das Prompt-Enum in prompts/komplett/schema-strings.js
// (ORTE_SCHEMA `typ`) decken — gegated durch tests/unit/ort-typen.test.mjs.
// Ein Typ-Key ist eine Persistenz-Konstante: ergänzen ja, umbenennen nein.
export const ORT_TYPEN = ['region', 'stadt', 'landschaft', 'gebaeude', 'raum', 'andere'];

// Lokalisiertes Label. Unbekannte Werte (ältere Analysen, freie Typen) bleiben
// lesbar als Rohwert statt als fehlender Key.
export function ortTypLabel(typ, t) {
  const key = typ || 'andere';
  if (!ORT_TYPEN.includes(key)) return String(typ);
  return t('orte.typ.' + key);
}
