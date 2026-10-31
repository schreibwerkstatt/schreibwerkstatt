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

// Ob die Ueberschrift eines Abschnitts unter seinem Kapitel entfaellt: beim
// einzigen Abschnitt des Kapitels immer (der Kapitelname traegt ihn), sonst
// beim ersten, der wie das Kapitel heisst. Server-Pendant (PDF/Word):
// lib/export-builders/shared.js#sectionTitleRedundant.
export function sectionTitleRedundant({ index, count, pageName, chapterName }) {
  if (index !== 0) return false;
  return count === 1 || sameStructureTitle(pageName, chapterName);
}

// Zahl der Abschnitte je Kapitel in einem Stream (manuscript-stream.js-
// Entries: `kind` 'chapter' | 'page', Seiten mit `chapterId`). Direkte
// Abschnitte, ohne die der Unterkapitel — wie `g.pages` der Server-Gruppen.
export function sectionCountsByChapter(entries) {
  const counts = new Map();
  for (const e of (entries || [])) {
    if (e.kind !== 'page') continue;
    const k = e.chapterId ?? null;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return counts;
}
