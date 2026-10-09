// Traegt ein Abschnitt denselben Namen wie sein Kapitel, stuenden im
// Lesefluss zwei identische Ueberschriften direkt untereinander — der haeufige
// Fall beim Kapitel aus genau einem Abschnitt, wo beide Namen aus derselben
// Anlage stammen. Gross-/Kleinschreibung und Mehrfach-Whitespace sind hier
// keine Unterscheidung.
//
// PURE + ISOMORPH (Share-SSR laedt manuscript-render.js serverseitig). Browser-
// Konsumenten: Share-Reader-Stream (manuscript-render.js), Bucheditor, Sidebar.
// Server-Pendant fuer PDF/Word: lib/export-builders/shared.js#sameStructureTitle
// — beide Regeln muessen deckungsgleich bleiben (gegated in
// tests/unit/structure-title.test.mjs), sonst zeigt derselbe Buchstand je
// Ausgabe eine andere Gliederung.
export function sameStructureTitle(a, b) {
  const norm = v => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const na = norm(a);
  return !!na && na === norm(b);
}
