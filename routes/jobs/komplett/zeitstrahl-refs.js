'use strict';
// P6 (Zeitstrahl): Vorgruppierung der Figuren-Lebensereignisse und Rückführung
// ihrer Kapitel-/Abschnitts-IDs. Reine Funktionen — Test:
// tests/unit/komplett-zeitstrahl-refs.test.mjs.
//
// Warum IDs neben den Namen: `figure_events` trägt `chapter_id`/`page_id`. Liefe
// der Anker nur über den Namen (Name → chNameToId), verlöre jedes Ereignis in
// einem gleichnamigen Kapitel («Einleitung» in Teil I und II) seinen Bezug —
// chapterNameMap lässt einen Namen, den zwei Kapitel tragen, bewusst weg.
// Die IDs reisen NICHT in den Konsolidierungs-Prompt (der bleibt unverändert),
// sondern in einer WeakMap neben den Gruppen.

/**
 * Gruppiert Zeilen aus listFigureEventsForTimeline nach `groupKey`
 * (cards/ereignisse/model.js#eventGroupKey). Liefert `{ events, refs }`:
 * `events` ist genau die Form, die der Prompt bekommt, `refs.get(ev)` die
 * Anker-IDs der Gruppe `{ chapter_ids, page_ids, chapters: Map name→Set(id),
 * pages: Map name→Set(id), figIds: Set }`.
 */
function groupFigureEvents(rows, groupKey) {
  const byKey = new Map();
  const refs = new WeakMap();
  for (const row of rows || []) {
    const key = groupKey(row);
    let ev = byKey.get(key);
    if (!ev) {
      ev = {
        datum: row.datum,
        datum_label:      row.datum_label,
        datum_year:       row.datum_year,
        datum_month:      row.datum_month,
        datum_day:        row.datum_day,
        datum_ende_year:  row.datum_ende_year,
        datum_ende_month: row.datum_ende_month,
        datum_ende_day:   row.datum_ende_day,
        story_tag:        row.story_tag,
        datum_unsicher:   row.datum_unsicher ? true : false,
        subtyp:           row.subtyp || 'sonstiges',
        ereignis: row.ereignis, typ: row.evt_typ,
        bedeutung: row.bedeutung || '',
        kapitel: [],
        seiten:  [],
        figuren: [],
      };
      byKey.set(key, ev);
      refs.set(ev, { chapter_ids: [], page_ids: [], chapters: new Map(), pages: new Map(), figIds: new Set() });
    }
    const r = refs.get(ev);
    // Sicheres Datum gewinnt: ist eine der zusammengeführten Figuren-Zeilen
    // explizit belegt (datum_unsicher=0), gilt das Gruppen-Event als sicher.
    if (!row.datum_unsicher) ev.datum_unsicher = false;
    if (!ev.figuren.some(f => f.id === row.fig_id))
      ev.figuren.push({ id: row.fig_id, name: row.fig_name, typ: row.fig_typ || 'andere' });
    r.figIds.add(row.fig_id);
    if (row.kapitel && !ev.kapitel.includes(row.kapitel)) ev.kapitel.push(row.kapitel);
    if (row.seite   && !ev.seiten.includes(row.seite))   ev.seiten.push(row.seite);
    _addId(r.chapter_ids, r.chapters, row.kapitel, row.chapter_id);
    _addId(r.page_ids, r.pages, row.seite, row.page_id);
  }
  return { events: [...byKey.values()], refs };
}

function _addId(list, byName, name, id) {
  if (id == null) return;
  if (!list.includes(id)) list.push(id);
  if (!name) return;
  if (!byName.has(name)) byName.set(name, new Set());
  byName.get(name).add(id);
}

/** Vorgruppierte Events direkt speicherfertig: jedes trägt seine Anker-IDs. */
function withRefIds(events, refs) {
  return events.map(ev => {
    const r = refs.get(ev);
    return r ? { ...ev, chapter_ids: r.chapter_ids, page_ids: r.page_ids } : ev;
  });
}

/**
 * Rückabgleich nach der KI-Konsolidierung: die Antwort nennt Kapitel/Abschnitte
 * nur beim Namen. Je Name wird die ID aus den Vorgruppen genommen, wenn sie
 * eindeutig ist — zuerst aus der Gruppe mit demselben Vergleichsschlüssel, dann
 * aus den Gruppen derselben Figuren, zuletzt buchweit. Bleibt ein Name mehrdeutig,
 * bekommt das Ereignis für ihn keine ID (die Namensauflösung im Save versucht es
 * dann noch; ein geratenes Kapitel wäre still falsch).
 */
function attachRefIds(kiEvents, groups, groupKey, structured) {
  const { events, refs } = groups;
  const byKey = new Map(events.map(ev => [groupKey(ev), refs.get(ev)]));
  const all = events.map(ev => refs.get(ev));
  const figIdOf = (f) => (f && typeof f === 'object' ? f.id : null);
  const pick = (name, candidates, field) => {
    for (const set of candidates) {
      const ids = new Set();
      for (const r of set) for (const id of (r[field].get(name) || [])) ids.add(id);
      if (ids.size === 1) return [...ids][0];
      if (ids.size > 1) return null;
    }
    return null;
  };
  return (kiEvents || []).map(ev => {
    const same = byKey.get(groupKey({ ...ev, ...(structured ? structured(ev) : {}) }));
    const figIds = new Set((Array.isArray(ev.figuren) ? ev.figuren : []).map(figIdOf).filter(Boolean));
    const byFig = figIds.size ? all.filter(r => [...figIds].some(id => r.figIds.has(id))) : [];
    const tiers = [same ? [same] : [], byFig, all].filter(t => t.length);
    const resolve = (names, field) => {
      const out = [];
      for (const n of (Array.isArray(names) ? names : [])) {
        if (typeof n !== 'string' || !n) continue;
        const id = pick(n, tiers, field);
        if (id != null && !out.includes(id)) out.push(id);
      }
      return out;
    };
    return { ...ev, chapter_ids: resolve(ev.kapitel, 'chapters'), page_ids: resolve(ev.seiten, 'pages') };
  });
}

module.exports = { groupFigureEvents, withRefIds, attachRefIds };
