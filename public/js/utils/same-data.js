// Stiller Abgleich (Tab-Rueckkehr, card-lifecycle.js#wake): ist die
// Server-Antwort inhaltlich gleich dem angezeigten Stand, wird sie nicht
// zugewiesen — eine neue Array-Identitaet liesse sonst jede Zeile, jeden Memo
// und jede Ableitung neu auswerten, ohne dass sich etwas aendert.
// Vergleich ueber JSON: Server-Daten sind reine JSON-Werte; Alpine-Proxies
// serialisieren wie ihre Rohwerte.
export function sameData(a, b) {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}
