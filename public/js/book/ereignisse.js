// Ereignisse/Zeitstrahl-Methoden am Root-Spread (figuren.js ruft
// _buildGlobalZeitstrahl, app-komplett.js ruft _reloadZeitstrahl).
//
// Beide Pfade schreiben `Alpine.store('catalog').globalZeitstrahl` und sind
// damit die EINZIGEN Stellen, an denen die Kanonform hergestellt wird
// (normalizeEvents) — jede Leseseite darf sich danach auf Arrays verlassen.

import { fetchJson } from '../utils.js';
import { normalizeEvents, sortEvents, eventGroupKey, addRefPair } from '../cards/ereignisse/model.js';

export const ereignisseMethods = {
  _buildGlobalZeitstrahl() {
    // Reiner Fallback: nie die kanonischen Server-Daten (zeitstrahl_events)
    // überschreiben. loadFiguren ruft diese Methode bei jedem Figuren-Reload —
    // ohne diese Sperre clobbert ein paralleles/späteres loadFiguren den vom
    // Server geladenen Zeitstrahl (Race im alleAktualisieren-Promise.all), die
    // datierten Events fallen weg und das Jahres-Band verschwindet.
    if (this.$store.catalog.zeitstrahlServerLoaded) return;
    // Fallback-Pfad: konstruiert den globalen Zeitstrahl aus
    // figuren[].lebensereignisse, wenn der konsolidierte Server-Endpunkt nichts
    // liefert. Die strukturierten Datums-Felder kommen aus `figure_events` und
    // werden von GET /figures/:book_id mitgeliefert — ohne sie waere hier jedes
    // Ereignis datumslos und das Jahres-Band bliebe bei einem unkonsolidierten
    // Buch leer.
    const allEvents = [];
    for (const f of (this.$store.catalog.figuren || [])) {
      for (const ev of (f.lebensereignisse || [])) {
        allEvents.push({
          datum:        ev.datum || '',
          datum_label:  ev.datum_label || ev.datum || '',
          datum_year:   ev.datum_year   ?? null,
          datum_month:  ev.datum_month  ?? null,
          datum_day:    ev.datum_day    ?? null,
          datum_ende_year:  ev.datum_ende_year  ?? null,
          datum_ende_month: ev.datum_ende_month ?? null,
          datum_ende_day:   ev.datum_ende_day   ?? null,
          story_tag:    ev.story_tag    ?? null,
          datum_unsicher: ev.datum_unsicher ?? false,
          ereignis: ev.ereignis || '',
          typ:      ev.typ || 'persoenlich',
          subtyp:   ev.subtyp || 'sonstiges',
          bedeutung: ev.bedeutung || '',
          sort_order: 0,
          kapitel: ev.kapitel || '',
          seite:   ev.seite || '',
          chapter_id: ev.chapter_id ?? null,
          page_id:    ev.page_id ?? null,
          figur:   { id: f.id, name: f.kurzname || f.name, typ: f.typ },
        });
      }
    }

    // Events mit gleichem Datum + Text zusammenführen (O(n) via Map). Der
    // Schlüssel ist derselbe wie in der Zeitstrahl-Phase P6 (eventGroupKey), damit
    // ein Buch vor und nach der Konsolidierung dieselben Doppel zusammenlegt.
    // Insertion-Order der Map bleibt für stabile Sortier-Tiebreaker erhalten.
    const byKey = new Map();
    for (const ev of allEvents) {
      const key = eventGroupKey(ev);
      let group = byKey.get(key);
      if (!group) {
        group = { ...ev, kapitel: [], chapter_ids: [], seiten: [], page_ids: [], figuren: [] };
        // Die Skalar-Anker des Einzel-Events gehen in die Listen der Gruppe.
        delete group.figur;
        delete group.seite;
        delete group.chapter_id;
        delete group.page_id;
        byKey.set(key, group);
      }
      if (!group.figuren.some(f => f.id === ev.figur.id)) group.figuren.push(ev.figur);
      // Name und ID als Paar (kapitel[i] ↔ chapter_ids[i]): Template und Filter
      // lesen beide über denselben Index.
      addRefPair(group.kapitel, group.chapter_ids, ev.kapitel, ev.chapter_id);
      addRefPair(group.seiten, group.page_ids, ev.seite, ev.page_id);
    }

    this.$store.catalog.globalZeitstrahl = sortEvents(normalizeEvents([...byKey.values()]));
  },

  async _reloadZeitstrahl() {
    try {
      const { ereignisse, chronology } = await fetchJson(`/figures/zeitstrahl/${this.$store.nav.selectedBookId}`);
      // Jahres-Kennzahlen (nur bei book_settings.zeitlinie_real serverseitig
      // berechnet, sonst null → Banner bleibt aus).
      this.$store.catalog.zeitstrahlChronology = chronology || null;
      if (ereignisse) {
        // Server liefert bereits nach derselben Ordnung sortiert (compareEvents
        // spiegelt sein ORDER BY); der Client-Sort ist defensiv gegen
        // abweichende Tiebreaker bei Auto-Reorder.
        this.$store.catalog.globalZeitstrahl = sortEvents(normalizeEvents(ereignisse));
        // Kanonische Daten geladen → figuren-Fallback ab jetzt sperren.
        this.$store.catalog.zeitstrahlServerLoaded = true;
      } else {
        // Kein konsolidierter Zeitstrahl (unkonsolidiertes Buch) → Fallback aus
        // den Figuren. Auch wenn vorher Server-Daten standen: die gibt es nicht
        // mehr, und stehen gelassen zeigte die Karte einen Zeitstrahl, den der
        // Server nicht mehr kennt.
        this.$store.catalog.zeitstrahlServerLoaded = false;
        this._buildGlobalZeitstrahl();
      }
    } catch (e) {
      console.error('[reloadZeitstrahl]', e);
      if (!this.$store.catalog.globalZeitstrahl.length) this._buildGlobalZeitstrahl();
    }
  },
};
