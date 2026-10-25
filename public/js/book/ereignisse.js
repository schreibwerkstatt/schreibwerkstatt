// Ereignisse/Zeitstrahl-Methoden am Root-Spread (figuren.js ruft
// _buildGlobalZeitstrahl, app-komplett.js ruft _reloadZeitstrahl).
//
// Beide Pfade schreiben `Alpine.store('catalog').globalZeitstrahl` und sind
// damit die EINZIGEN Stellen, an denen die Kanonform hergestellt wird
// (normalizeEvents) — jede Leseseite darf sich danach auf Arrays verlassen.

import { fetchJson } from '../utils.js';
import { normalizeEvents, sortEvents } from '../cards/ereignisse/model.js';

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

    // Events mit identischem datum+ereignis zusammenführen (O(n) via Map statt
    // O(n²) Doppelschleife). Insertion-Order der Map bleibt für stabile Sortier-
    // Tiebreaker erhalten. Gruppierungs-Schluessel ist das strukturierte Datum
    // (mit Label-Rueckfall), weil Ereignisse mit gleichem Kalenderdatum, aber
    // leerem Freitext-Label sonst alle in denselben Topf fielen.
    const byKey = new Map();
    for (const ev of allEvents) {
      const stamp = ev.datum_year != null
        ? `${ev.datum_year}-${ev.datum_month ?? ''}-${ev.datum_day ?? ''}`
        : (ev.datum_label || ev.datum || '');
      const key = `${stamp} ${ev.ereignis}`;
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
      group.figuren.push(ev.figur);
      if (ev.kapitel && !group.kapitel.includes(ev.kapitel)) group.kapitel.push(ev.kapitel);
      if (ev.seite   && !group.seiten.includes(ev.seite))   group.seiten.push(ev.seite);
      // Kapitel-/Abschnittsfilter arbeiten auf den IDs (chapter-filter.js).
      if (ev.chapter_id != null && !group.chapter_ids.includes(ev.chapter_id)) group.chapter_ids.push(ev.chapter_id);
      if (ev.page_id    != null && !group.page_ids.includes(ev.page_id))       group.page_ids.push(ev.page_id);
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
      } else if (!this.$store.catalog.globalZeitstrahl.length) {
        // Kein konsolidierter Zeitstrahl (unkonsolidiertes Buch) → Fallback erlaubt.
        this._buildGlobalZeitstrahl();
      }
    } catch (e) {
      console.error('[reloadZeitstrahl]', e);
      if (!this.$store.catalog.globalZeitstrahl.length) this._buildGlobalZeitstrahl();
    }
  },
};
