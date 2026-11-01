// Erster Abschnitt im Teilbaum eines Kapitels. Der Tree ist flach in
// Vorordnung (`depth`); ein Kapitel ohne eigene Abschnitte, das nur
// Unterkapitel trägt, springt so in deren ersten Abschnitt.
export function firstPageInChapter(tree, chapterId) {
  const list = Array.isArray(tree) ? tree : [];
  const at = list.findIndex(t => t.type === 'chapter' && String(t.id) === String(chapterId));
  if (at < 0) return null;
  const depth = list[at].depth || 1;
  for (let i = at; i < list.length; i++) {
    if (i > at && (list[i].depth || 1) <= depth) break;
    if (list[i].pages?.length) return list[i].pages[0];
  }
  return null;
}
