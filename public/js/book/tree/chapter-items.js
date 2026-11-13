// Kapitel-Items im flachen Seitenbaum (`nav.tree`). Ein Solo-Abschnitt steht dort
// ebenfalls als `type: 'chapter'`-Item (Wrapper um genau einen Abschnitt ohne
// Kapitel) — ein echtes Kapitel ist nur das Item ohne `solo`. Unterkapitel sind
// eigene Items im flachen Baum (`parent_id`, `depth`).

/** Echtes Kapitel (inkl. Unterkapitel), kein Solo-Abschnitt. */
export function isChapterItem(it) {
  return it?.type === 'chapter' && !it.solo;
}

/** Kapitel-Item mit dieser ID (String-Vergleich), sonst `null`. */
export function findChapterItem(tree, id) {
  if (id == null || id === '') return null;
  const key = String(id);
  return (tree || []).find(it => isChapterItem(it) && String(it.id) === key) || null;
}
