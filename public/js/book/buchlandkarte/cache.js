// Letztes Buchlandkarten-Ergebnis je Buch für die Dauer der Browser-Sitzung
// (Modul-State, kein localStorage): Schliessen der Karte oder ein Buchwechsel
// kostet sonst einen neuen Lauf. Kein persistierter Index — das Ergebnis bleibt
// nur so lange wie der Tab, und „Neu zeichnen" holt den aktuellen Stand. Die
// KI-Benennung der Achsen hängt als `_labels` am Ergebnis, zu dem sie gehört.
export const resultCache = new Map();
