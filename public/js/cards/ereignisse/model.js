// Event-Modell: Kanonform und Ordnung der Zeitstrahl-Events. Reine Funktionen
// ohne Alpine — direkt testbar (tests/unit/event-sort.test.mjs).
//
// Zwei Produzenten speisen `Alpine.store('catalog').globalZeitstrahl`: der
// konsolidierte Server-Endpunkt (/figures/zeitstrahl/:book_id) und der
// Figuren-Fallback (../../book/ereignisse.js#_buildGlobalZeitstrahl). Beide
// laufen durch `normalizeEvent`, damit JEDE Leseseite eine feste Form vorfindet
// — sonst normalisiert jede Stelle einzeln nach (`Array.isArray(ev.kapitel) ?
// … : …`), und genau diese Nachnormalisierung driftet: sie stand an dreizehn
// Stellen und las teils Felder, die der Produzent gar nicht mehr setzt.

import { validYear, validMonth, validDay } from './date.js';

/** Ein Wert → Liste. `null`/`''`/`undefined` → []; Skalar → [Skalar]. */
function _list(v) {
  if (Array.isArray(v)) return v;
  return (v == null || v === '') ? [] : [v];
}

/**
 * Anker-Paare Name ↔ ID. `names[i]` gehoert zu `ids[i]` — das Template und die
 * Entity-Refs lesen beide ueber denselben Index. Darum wird nie eine der beiden
 * Listen fuer sich gefiltert: ein Paar ohne Namen faellt als Ganzes weg, eine
 * fehlende ID bleibt `null` an ihrem Platz (der Verweis loest dann ueber den
 * Namen auf). Liefert `{ names, ids }` gleicher Laenge.
 */
function _pairs(nameSrc, idSrc) {
  const names = _list(nameSrc), ids = _list(idSrc);
  const out = { names: [], ids: [] };
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    if (n == null || n === '') continue;
    out.names.push(n);
    out.ids.push(ids[i] ?? null);
  }
  return out;
}

/**
 * Haengt ein Anker-Paar an `names`/`ids` an (beide gleich lang) und haelt sie
 * duplikatfrei: mit ID ist die ID der Schluessel (zwei gleichnamige Abschnitte
 * in verschiedenen Kapiteln bleiben zwei Eintraege), ohne ID der Name. Kommt
 * zu einem namensgleichen Eintrag ohne ID spaeter die ID, wird er ergaenzt
 * statt verdoppelt.
 */
export function addRefPair(names, ids, name, id) {
  if (!name) return;
  const hasId = id != null && id !== '';
  for (let i = 0; i < names.length; i++) {
    if (hasId && ids[i] != null && String(ids[i]) === String(id)) return;
    if (names[i] === name && (ids[i] == null || !hasId)) {
      if (hasId && ids[i] == null) ids[i] = id;
      return;
    }
  }
  names.push(name);
  ids.push(hasId ? id : null);
}

/**
 * Kanonform eines Events. Mehrwertige Anker (Kapitel/Seiten/Figuren) sind IMMER
 * Arrays, Typ und Subtyp immer gesetzt; `kapitel[i]` gehoert zu `chapter_ids[i]`,
 * `seiten[i]` zu `page_ids[i]` (beide Listen gleich lang, ID ggf. `null`). Die
 * Skalar-Felder `kapitel`/`seite`/`chapter_id`/`page_id` des Fallback-Pfads
 * werden dabei in ihre Listen ueberfuehrt und nicht doppelt gefuehrt — zwei
 * Traeger derselben Aussage waeren die naechste Drift.
 */
export function normalizeEvent(ev) {
  const kap = _pairs(ev.kapitel, ev.chapter_ids !== undefined ? ev.chapter_ids : ev.chapter_id);
  const sei = _pairs(ev.seiten !== undefined ? ev.seiten : ev.seite,
    ev.page_ids !== undefined ? ev.page_ids : ev.page_id);
  const out = {
    ...ev,
    typ: ev.typ || 'persoenlich',
    subtyp: ev.subtyp || 'sonstiges',
    kapitel: kap.names,
    chapter_ids: kap.ids,
    seiten: sei.names,
    page_ids: sei.ids,
    figuren: Array.isArray(ev.figuren) ? ev.figuren : [],
  };
  delete out.seite;
  delete out.chapter_id;
  delete out.page_id;
  return out;
}

/**
 * Vergleichsschluessel «dasselbe Ereignis»: Datum + Text. SSoT fuer alle drei
 * Stellen, die Ereignisse zusammenfuehren — den Figuren-Fallback der Karte
 * (book/ereignisse.js), die Vorgruppierung der Zeitstrahl-Phase P6 und den
 * Abgleich der Analyse gegen vom Autor bearbeitete Zeilen (db/zeitstrahl.js,
 * `ki_key`); der Server laedt das Modul ueber lib/esm-bridge.js.
 * Datum: das strukturierte Datum, sonst der Story-Tag, sonst das Label. Text:
 * ohne Gross-/Kleinschreibung und Leerraum-Varianten.
 */
export function eventGroupKey(ev) {
  const y = validYear(ev?.datum_year);
  let stamp;
  if (y !== null) {
    stamp = `${y}-${validMonth(ev.datum_month) ?? ''}-${validDay(ev.datum_day) ?? ''}`;
  } else if (Number.isFinite(ev?.story_tag) && ev.story_tag >= 1) {
    stamp = `t${Math.trunc(ev.story_tag)}`;
  } else {
    stamp = String(ev?.datum_label || ev?.datum || '').trim().toLowerCase();
  }
  const text = String(ev?.ereignis || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return `${stamp}|${text}`;
}

/** Kanonform fuer eine ganze Liste. */
export function normalizeEvents(list) {
  return (list || []).map(normalizeEvent);
}

// Sortier-Schluessel mit strukturierten Datums-Feldern. Events ohne Jahr landen
// am Ende ("unbekannt"-Bucket). story_tag faengt relative Story-Zeit ohne
// Kalender. Spiegelt die ORDER-BY-Klausel von GET /figures/zeitstrahl/:book_id
// (routes/figures/zeitstrahl.js) — inklusive `id` als letztem Tiebreaker, sonst
// ordnet ein Client-Resort gleich datierte Events anders als der Server.
//
// Ueber validYear/validMonth/validDay statt `??`: ein 0-Platzhalter aus einem
// nicht migrierten Bestand zaehlt wie in der Anzeige (date.js) als unbekannt —
// sonst sortierte er ein «ohne Datum»-Ereignis ganz nach vorn.
function _sortKey(ev) {
  return [
    validYear(ev.datum_year)   ?? 9999,
    validMonth(ev.datum_month) ?? 99,
    validDay(ev.datum_day)     ?? 99,
    ev.story_tag   ?? 99999,
    ev.sort_order  ?? 0,
    ev.id          ?? 0,
  ];
}

export function compareEvents(a, b) {
  const ka = _sortKey(a), kb = _sortKey(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return 0;
}

/** Sortierte Kopie (nie in-place — die Quelle ist ein Alpine-Store-Array). */
export function sortEvents(list) {
  return [...(list || [])].sort(compareEvents);
}
