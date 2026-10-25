// Ziel-Optionen der Share-Links-Karte (Abschnitt bzw. Kapitel teilen), gebaut
// aus dem FLACHEN Sidebar-Baum (`nav.tree`: depth-first, Kapitel jeder Tiefe als
// eigene Items mit `depth` + `parent_id`, kapitellose Abschnitte als
// Solo-Items). Framework-frei, damit Unit-Tests es direkt laden.
//
// Kapitel-Labels kommen aus `_chapterLabelMap` (tree/build.js, gleichnamige
// Kapitel mit Elternkapitel davor) — dieselben Namen wie in allen Filtern.

const isChapter = (it) => it?.type === 'chapter' && !it.solo;

// Pfad «Teil › Kapitel» je Kapitel-ID über die parent_id-Kette.
function chapterPaths(tree) {
  const byId = new Map();
  for (const it of tree) if (isChapter(it)) byId.set(it.id, it);
  const paths = new Map();
  const pathOf = (it, guard = 0) => {
    if (paths.has(it.id)) return paths.get(it.id);
    const parent = it.parent_id != null ? byId.get(it.parent_id) : null;
    const p = parent && guard < 8 ? `${pathOf(parent, guard + 1)} › ${it.name}` : it.name;
    paths.set(it.id, p);
    return p;
  };
  for (const it of byId.values()) pathOf(it);
  return paths;
}

/** Abschnitte: «Kapitelpfad / Abschnitt», kapitellose nur mit ihrem Namen. */
export function sharePageOptions(tree) {
  const items = tree || [];
  const paths = chapterPaths(items);
  const out = [];
  for (const it of items) {
    if (it?.type !== 'chapter') continue;
    for (const p of it.pages || []) {
      out.push({ value: String(p.id), label: it.solo ? p.name : `${paths.get(it.id)} / ${p.name}` });
    }
  }
  return out;
}

/** Kapitel in Buchreihenfolge, nach Tiefe eingerückt. Ein Kapitel, in dessen
 *  ganzem Unterbaum kein Abschnitt liegt, fehlt — der Share-Link teilt den
 *  Unterbaum, ein leerer zeigte dem Leser eine leere Seite. */
export function shareChapterOptions(tree, labels = null) {
  const items = (tree || []).filter(isChapter);
  const total = new Map();
  for (const it of items) total.set(it.id, (it.pages || []).length);
  // depth-first: Kinder stehen hinter ihrem Parent → rückwärts aufsummieren.
  const byId = new Map(items.map(it => [it.id, it]));
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.parent_id != null && byId.has(it.parent_id)) {
      total.set(it.parent_id, total.get(it.parent_id) + total.get(it.id));
    }
  }
  return items
    .filter(it => total.get(it.id) > 0)
    .map(it => ({
      value: String(it.id),
      label: '— '.repeat(Math.max(0, (it.depth || 1) - 1)) + (labels?.get(it.id) || it.name),
    }));
}
