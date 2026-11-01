// Pure Compute fuer die Kategorie-Gruppierung der „Meine Statistik" (my-stats-card.js).
// Bewusst frei von Alpine/DOM → unit-testbar (tests/unit/my-stats-compute.test.mjs).
// Eigene Datei statt in my-stats-compute.js, damit jene unter dem 600-LOC-Cap bleibt.

// Umfang gruppiert nach Buch-Kategorie (book_categories). `booksDetail` aus
// /me/profile-stats traegt pro Buch `category` ({ id, name, color } | null).
// Buecher ohne Kategorie landen im Sammel-Bucket (categoryId = null). Liefert
// pro Gruppe Summen (chars/words/pages) + Buchzahl, absteigend nach Zeichen;
// der Uncategorized-Bucket steht stets zuletzt. pct = Anteil am Spitzenreiter
// (fuer den Balken). Leere Buecher (chars = 0) zaehlen nicht in die Gruppen.
import { CHARS_PER_NORMSEITE } from '../utils/format.js';

export function computeVolumeByCategory(booksDetail) {
  const groups = new Map(); // catId|'__none__' → { categoryId, name, color, chars, words, pages, bookCount }
  for (const b of (booksDetail || [])) {
    const chars = Number(b.chars) || 0;
    if (chars <= 0) continue;
    const cat = b.category || null;
    const key = cat ? cat.id : '__none__';
    let g = groups.get(key);
    if (!g) {
      g = { categoryId: cat ? cat.id : null, name: cat ? cat.name : null,
            color: cat ? (cat.color || null) : null, chars: 0, words: 0, pages: 0, bookCount: 0 };
      groups.set(key, g);
    }
    g.chars += chars;
    g.words += Number(b.words) || 0;
    g.pages += Number(b.pages) || 0;
    g.bookCount += 1;
  }
  const rows = [...groups.values()];
  rows.sort((a, b) => {
    if ((a.categoryId == null) !== (b.categoryId == null)) return a.categoryId == null ? 1 : -1;
    return b.chars - a.chars;
  });
  const max = rows.length ? Math.max(1, ...rows.map(r => r.chars)) : 1;
  return rows.map(r => ({ ...r, normpages: Math.round(r.chars / CHARS_PER_NORMSEITE), pct: Math.round((r.chars / max) * 100) }));
}
