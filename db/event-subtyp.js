// SSoT (Server-Seite) für die Event-Subtyp-Whitelist von figure_events /
// zeitstrahl_events. MUSS deckungsgleich mit dem Prompt-Enum EVENT_SUBTYP_ENUM
// in public/js/prompts/komplett/schemas.js bleiben (das ist der KI-Vertrag) –
// db/figures.js (figure_events) und db/schema.js (zeitstrahl_events) gaten ihren
// Save dagegen. Unbekannte/leere Werte fallen auf 'sonstiges' zurück.
const EVENT_SUBTYP_WL = new Set([
  'geburt', 'tod', 'hochzeit', 'liebe', 'trennung', 'krankheit',
  'reise', 'umzug', 'konflikt', 'wendepunkt', 'entdeckung', 'verlust', 'sieg',
  'ausbildung', 'abschluss', 'stellenantritt', 'berufswechsel', 'jobverlust', 'pensionierung',
  'extern_politisch', 'extern_wirtschaftlich', 'extern_natur', 'extern_kulturell', 'extern_krieg',
  'sonstiges',
]);

/** Normalisiert einen KI-Subtyp auf die Whitelist; unbekannt/leer → 'sonstiges'. */
function normEventSubtyp(raw) {
  return EVENT_SUBTYP_WL.has(raw) ? raw : 'sonstiges';
}

module.exports = { EVENT_SUBTYP_WL, normEventSubtyp };
