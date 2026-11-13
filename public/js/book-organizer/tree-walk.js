// Durchlauf des Organizer-Workstates (`workTree`: Kapitel mit `subchapters`).
// Pre-Order über alle Tiefen — Kapitel vor seinen Unterkapiteln, Geschwister in
// Listenreihenfolge (= Depth-First-Rang der Sidebar).

/**
 * Ruft `fn(chapter, indexInParent, depth)` für jedes Kapitel; `depth` beginnt
 * bei 1 für die übergebene Liste.
 * @param {Array|null|undefined} list
 * @param {(c: any, i: number, depth: number) => void} fn
 */
export function eachChapter(list, fn, depth = 1) {
  (list || []).forEach((c, i) => {
    fn(c, i, depth);
    eachChapter(c.subchapters, fn, depth + 1);
  });
}
