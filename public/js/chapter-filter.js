// Kapitel-/Abschnitts-Filter der Katalog-Karten — eine Regel für alle:
// der Filterwert ist die ID, der Name nur das Label.
//
// Gleichnamige Kapitel («Einleitung» in Teil I und Teil II) sind zwei Kapitel,
// gleichnamige Abschnitte zwei Abschnitte. Ein Filter auf den Namen legte sie
// zusammen, und jede Name→ID-Rückübersetzung müsste raten. Darum tragen die
// Einträge ihre Kapitel-/Abschnitts-IDs (chapter_id, chapter_ids, page_ids …),
// und Filter, Optionen und Einsprünge (Buchübersicht, Figur-Detail) reichen
// IDs weiter. Regel + Drift-Test: docs/chapter-hierarchy.md
// («Kapitel und Abschnitte per ID, nie per Name»).
//
// Framework-frei (kein Alpine, kein window), damit Unit-Tests es direkt laden.

export const sameId = (a, b) => a != null && b != null && a !== '' && b !== '' && String(a) === String(b);

/** Kommt `id` in `list` vor (Zahl/String egal)? */
export function hasId(list, id) {
  for (const x of list || []) if (sameId(x, id)) return true;
  return false;
}

// Anzeigename je Kapitel-ID: der Kapitelname, bei gleichnamigen Kapiteln mit dem
// Elternkapitel davor («Teil II › Kapitel 1»). Ohne Eltern bleibt der Name
// gleich — dann trennt die Buchreihenfolge die Einträge.
export function buildKapitelLabels(tree) {
  const chapters = (tree || []).filter(i => i.type === 'chapter' && !i.solo);
  const byId = new Map(chapters.map(c => [c.id, c]));
  const nameCount = new Map();
  for (const c of chapters) nameCount.set(c.name, (nameCount.get(c.name) || 0) + 1);
  const labels = new Map();
  for (const c of chapters) {
    const parent = c.parent_id != null ? byId.get(c.parent_id) : null;
    labels.set(c.id, nameCount.get(c.name) > 1 && parent ? `${parent.name} › ${c.name}` : c.name);
  }
  return labels;
}

/** Combobox-Optionen aus IDs: dedupliziert, in Buchreihenfolge (`idxOf`), Label
 *  über `labelOf`. IDs ohne Label (Kapitel gelöscht) fallen weg — eine Option, die
 *  nichts mehr benennt, liesse sich nicht wählen. */
export function idOptions(ids, labelOf, idxOf) {
  const seen = new Map();
  for (const id of ids || []) {
    if (id == null || id === '' || seen.has(String(id))) continue;
    const label = labelOf(id);
    if (!label) continue;
    seen.set(String(id), { value: id, label, idx: idxOf(id) });
  }
  return [...seen.values()].sort((a, b) => a.idx - b.idx).map(({ value, label }) => ({ value, label }));
}

/** Der Filterwert, der tatsächlich wirkt: nur einer, den die Optionen anbieten.
 *  Ein gespeicherter Wert aus einem früheren Stand (Kapitel gelöscht, Eintrag
 *  neu analysiert, altes Namensformat) zeigte in der Combobox «Alle Kapitel» —
 *  filterte er trotzdem, stünde eine leere Liste unter einem leeren Filter. */
export function activeFilterId(value, options) {
  if (value == null || value === '') return '';
  for (const o of options || []) if (sameId(o.value, value)) return o.value;
  return '';
}
