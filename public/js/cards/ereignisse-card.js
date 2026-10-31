// Alpine.data('ereignisseCard') — Sub-Komponente der Zeitstrahl-Karte.
//
// Eigener State: Meta-Flags (Loading/Status/Progress/PollTimer) + UI-Helper.
// Geteilt:
//   - `globalZeitstrahl` (Alpine.store('catalog'))
//   - `ereignisseFilters` (Alpine.store('catalogUi') — app-navigation schreibt darauf)
// Root behält:
//   - `_buildGlobalZeitstrahl` (wird aus figuren.js / loadFiguren gerufen)
//   - `_reloadZeitstrahl` (wird aus app-komplett.js gerufen)
//
// Die Sachlogik liegt als reine Module im Subfolder `ereignisse/` (Datum,
// Subtyp, Band-Geometrie, Event-Modell) und wird hier re-exportiert, damit
// Tests und Konsumenten einen Einstieg behalten.
import { setupCardLifecycle } from './card-lifecycle.js';
import { hasEventYear, formatEventDateParts } from './ereignisse/date.js';
import { subtypIcon, bandMarkerColor, eventSpanYears, POINT_SUBTYPES } from './ereignisse/subtyp.js';
import {
  buildTimelineItems, timelineBounds, layoutBandItems, bandAxisTicks, buildBandModel,
} from './ereignisse/band.js';
import { normalizeEvent, normalizeEvents, compareEvents, sortEvents, eventGroupKey } from './ereignisse/model.js';
import { ereignisEditMethods } from './ereignisse/edit.js';
import { memoMethods } from './card-memo.js';
import { activeFilterId, hasId, sameId } from '../chapter-filter.js';

export { hasEventYear, formatEventDateParts };
export { subtypIcon, bandMarkerColor, eventSpanYears, POINT_SUBTYPES };
export { buildTimelineItems, timelineBounds, layoutBandItems, bandAxisTicks, buildBandModel };
export { normalizeEvent, normalizeEvents, compareEvents, sortEvents };

// Pure Filter-Logik. Aus dem memoized Wrapper extrahiert, damit sie ohne
// Alpine-Root testbar ist (siehe tests/unit/ereignisse-card-filter.test.mjs).
// Setzt die Kanonform aus `ereignisse/model.js` voraus: Kapitel/Seiten sind
// Arrays, weil beide Produzenten durch `normalizeEvent` laufen.
// `kapitelId`/`seiteId` sind die bereits wirksamen Werte (activeFilterId gegen die
// Optionen); Kapitel und Abschnitte per ID (chapter-filter.js).
// Die Suche liest alles, was die Zeile zeigt: Text, Bedeutung, Datums-Label,
// Figuren-, Kapitel- und Abschnittsnamen — «1987» oder ein Figurenname finden so
// auch Ereignisse, in deren Text sie nicht stehen.
export function eventSearchText(ev) {
  return [
    ev.ereignis, ev.bedeutung, ev.datum_label || ev.datum,
    ...(ev.figuren || []).map(f => f?.name), ...(ev.kapitel || []), ...(ev.seiten || []),
  ].filter(Boolean).join('\n').toLowerCase();
}

export function applyEreignisseFilters(events, { suche = '', figurId = '', subtyp = '', kapitelId = '', seiteId = '' } = {}) {
  let result = events || [];
  if (suche) {
    const q = suche.toLowerCase();
    result = result.filter(ev => eventSearchText(ev).includes(q));
  }
  if (figurId) result = result.filter(ev => (ev.figuren || []).some(f => f.id === figurId));
  if (subtyp) result = result.filter(ev => (ev.subtyp || 'sonstiges') === subtyp);
  if (kapitelId) result = result.filter(ev => hasId(ev.chapter_ids, kapitelId));
  // Die Abschnitts-Achse ist an ein gewaehltes Kapitel gebunden; die Combobox ist
  // ohne Kapitel deaktiviert.
  if (seiteId && kapitelId) result = result.filter(ev => hasId(ev.page_ids, seiteId));
  return result;
}

export function registerEreignisseCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('ereignisseCard', () => ({
    ereignisseLoading: false,
    ereignisseProgress: 0,
    ereignisseStatus: '',
    zeitstrahlConsolidating: false,
    zeitstrahlProgress: 0,
    zeitstrahlStatus: '',
    _consolidatePollTimer: null,
    _ereignisseExtractPollTimer: null,
    _lifecycle: null,
    // Ein Memo-Helper pro Modul (CLAUDE.md): filteredEreignisse()/bandModel()
    // werden im Template mehrfach pro Render gelesen → Cache mit shallow-Array-
    // Deps. Reset bei jedem Daten-Reload via this._memos = {} im load-Pfad.
    _memos: {},
    _bandRO: null,
    // Gerenderte Track-Breite (px, auf 16er gerundet gegen Resize-Thrashing).
    // Speist die Chip-Kollisionsauflösung in bandModel(); 0 = noch nicht gemessen.
    _bandWidth: 0,
    // Ausgewähltes Ereignis als stabiler Schlüssel (`_eventSelKey`), NICHT als
    // Listen-Index: nach einem Filterwechsel stünde an derselben Position ein
    // anderes Ereignis, und dessen Marker leuchtete. Die Achse rechnet den Index
    // daraus (selectedEventIndex()). Ereignisse mit ID spiegeln die Auswahl
    // zusätzlich in den Store (Deep-Link, Hervorhebung der Listenzeile).
    _selKey: null,
    // Ereignis bearbeiten (ereignisse/edit.js).
    eventEditId: null,
    eventEditDraft: {},
    eventEditBusy: false,
    eventEditError: '',
    eventEditMessage: '',

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'ereignisse',
        showFlag: 'showEreignisseCard',
        timerKeys: ['_consolidatePollTimer', '_ereignisseExtractPollTimer'],
        resetState: {
          ereignisseLoading: false,
          ereignisseProgress: 0,
          ereignisseStatus: '',
          zeitstrahlConsolidating: false,
          zeitstrahlProgress: 0,
          zeitstrahlStatus: '',
          _selKey: null,
          eventEditId: null,
          eventEditDraft: {},
          eventEditBusy: false,
          eventEditError: '',
          eventEditMessage: '',
        },
        load: async (root) => {
          this._memos = {};
          await root._reloadZeitstrahl();
          // Nach dem Laden erneut spiegeln: bei einem Kaltstart (Palette-Klick,
          // Deep-Link) stand die Auswahl schon, bevor die Liste da war.
          this._syncSelectedEreignis();
        },
        refreshNeedsBookId: false,
      });
      // Auswahl (Store-SSoT, vom Hash-Router/Palette gesetzt) auf den
      // Listen-Index spiegeln, an dem der Band-Marker haengt. Die Listenzeile
      // selbst markiert sich im Template direkt ueber die ID — nur die Achse
      // rechnet in Indizes.
      this.$watch(() => Alpine.store('catalogUi').selectedEreignisId, () => this._syncSelectedEreignis());
      // Das Jahres-Band rendert deklarativ aus bandModel() (reaktiv über
      // filteredEreignisse) — kein imperativer Render-Pfad, kein Lazy-Lib-Load,
      // kein asynchrones Layout. Damit gibt es keinen Einklapp-/Expandier-Effekt.
      //
      // Track-Breite beobachten: die „+N"-Chip-Kollisionsauflösung
      // (layoutBandItems) braucht die echte Pixelbreite, um Chip-Breiten in
      // Prozent umzurechnen. ResizeObserver schreibt _bandWidth → bandModel()
      // rechnet reaktiv neu. Auf 16px gerundet, damit Sub-Pixel-Resizes nicht
      // jedes Frame ein Re-Layout auslösen.
      if (typeof ResizeObserver !== 'undefined') {
        this._bandRO = new ResizeObserver((entries) => {
          const raw = entries[0]?.contentRect?.width || 0;
          const w = Math.round(raw / 16) * 16;
          if (w && w !== this._bandWidth) this._bandWidth = w;
        });
        this.$nextTick(() => {
          if (this.$refs.bandTrack) this._bandRO.observe(this.$refs.bandTrack);
        });
      }
    },

    destroy() {
      this._bandRO?.disconnect();
      this._bandRO = null;
      this._lifecycle?.destroy();
    },

    // Memo-Helper (cards/card-memo.js); Reset über this._memos = {} (load-Pfad).
    ...memoMethods,
    ...ereignisEditMethods,

    // Figuren, die in mindestens einem Ereignis vorkommen (Filter-Optionen).
    ereignisseFigurOptionen() {
      const events = Alpine.store('catalog').globalZeitstrahl;
      const figuren = Alpine.store('catalog').figuren;
      return this._memo('figOpt', [events, figuren], () => {
        const ids = new Set();
        for (const ev of (events || [])) for (const f of ev.figuren) if (f.id != null) ids.add(f.id);
        return (figuren || []).filter(f => ids.has(f.id)).map(f => ({ value: f.id, label: f.kurzname || f.name }));
      });
    },

    // UI-Helper. Lesen $root-Filter + -Daten.
    ereignisseKapitelOptionen() {
      const events = Alpine.store('catalog').globalZeitstrahl;
      const root = window.__app;
      return this._memo('kapOpt', [events, root._chapterLabelMap, root._chapterIdOrderMap],
        () => root._kapitelOptionen((events || []).flatMap(ev => ev.chapter_ids || [])));
    },

    // Abschnitte des gewählten Kapitels, in denen ein Ereignis verankert ist.
    ereignisseSeitenOptionen() {
      const events = Alpine.store('catalog').globalZeitstrahl;
      const root = window.__app;
      const kapitelId = activeFilterId(Alpine.store('catalogUi').ereignisseFilters.kapitelId, this.ereignisseKapitelOptionen());
      return this._memo('seiteOpt', [events, kapitelId, root._pageIdOrderMap, root.$store.nav.pages], () => {
        if (!kapitelId) return [];
        const pages = root.$store.nav.pages || [];
        const inChapter = new Set(pages.filter(p => sameId(p.chapter_id, kapitelId)).map(p => String(p.id)));
        const ids = (events || []).filter(ev => hasId(ev.chapter_ids, kapitelId))
          .flatMap(ev => ev.page_ids || []).filter(id => inChapter.has(String(id)));
        return root._seitenOptionen(ids);
      });
    },

    // Liste sichtbarer Subtypen im aktuellen Buch — Filter zeigt nur was vorkommt.
    ereignisseSubtypListe() {
      const seen = new Set();
      for (const ev of (Alpine.store('catalog').globalZeitstrahl || [])) {
        seen.add(ev.subtyp || 'sonstiges');
      }
      return [...seen].sort();
    },

    formatEventDate(ev) {
      return formatEventDateParts(ev, (k, p) => window.__app.t(k, p));
    },

    // Die reinen Module direkt in den Alpine-Scope haengen, statt sie durch
    // gleichnamige Wrapper zu reichen: ein zweiter Name fuer dieselbe Funktion
    // ist die Stelle, an der die beiden auseinanderlaufen.
    //   eventHasYear  — Template-Gate „hat ein Kalenderjahr" (Achsen-Sprung,
    //                   «ca.»-Hinweis, Unbekannt-Klasse der Listenzeile)
    //   eventSpanYears— Spannen-Hoehe in Jahren fuer --span-years (0 = Punkt)
    eventHasYear: hasEventYear,
    subtypIcon,
    eventSpanYears,

    filteredEreignisse() {
      const events = Alpine.store('catalog').globalZeitstrahl;
      const f = Alpine.store('catalogUi').ereignisseFilters;
      const suche = f.suche ?? '', figurId = f.figurId ?? '', subtyp = f.subtyp ?? '';
      const kapitelId = activeFilterId(f.kapitelId, this.ereignisseKapitelOptionen());
      const seiteId = kapitelId ? activeFilterId(f.seiteId, this.ereignisseSeitenOptionen()) : '';
      return this._memo('filtered', [events, suche, figurId, kapitelId, seiteId, subtyp],
        () => applyEreignisseFilters(events, { suche, figurId, kapitelId, seiteId, subtyp }));
    },

    // Auswahl-Schlüssel eines Ereignisses: die DB-ID, im Figuren-Fallback (ohne
    // ID) der Vergleichsschlüssel aus Datum + Text.
    _eventSelKey(ev) {
      return ev?.id != null ? 'i' + ev.id : 'k' + eventGroupKey(ev);
    },

    isEventSelected(ev) {
      return this._selKey != null && this._eventSelKey(ev) === this._selKey;
    },

    // Listen-Index des ausgewählten Ereignisses in der gefilterten Liste (Brücke
    // zum Band-Marker), oder null, wenn es gerade herausgefiltert ist.
    selectedEventIndex() {
      const list = this.filteredEreignisse();
      const key = this._selKey;
      return this._memo('selIdx', [list, key], () => {
        if (key == null) return null;
        const idx = list.findIndex(ev => this._eventSelKey(ev) === key);
        return idx >= 0 ? idx : null;
      });
    },

    // Ein Ereignis auswählen (Marker- oder Datums-Klick). Mit ID auch im Store,
    // damit Listenzeile, Deep-Link und Achse dasselbe Ereignis zeigen.
    _selectEventAt(index) {
      const ev = this.filteredEreignisse()[index];
      if (!ev) return;
      this._selKey = this._eventSelKey(ev);
      if (ev.id != null) Alpine.store('catalogUi').selectedEreignisId = ev.id;
    },

    // Store-Auswahl (Hash-Router/Palette) → lokaler Schlüssel. Kein Scroll hier:
    // den macht `openEreignisById` ueber das `data-event-id` der Zeile (gleicher
    // Weg wie bei Figur/Ort/Szene), und zwar wartend, bis die Zeile im DOM steht.
    _syncSelectedEreignis() {
      const id = Alpine.store('catalogUi').selectedEreignisId;
      if (id != null) this._selKey = 'i' + id;
      else if (this._selKey?.startsWith('i')) this._selKey = null;
    },

    // Scrollt das Event am Listen-Index ins Sichtfeld (Klick auf Timeline-Item).
    // $root (Karten-Wurzel), nicht $el: aus einem @click-Handler heraus zeigt
    // $el auf das geklickte Kind (Band-Marker bzw. Achse-Hinweis), dessen
    // Subtree die Liste nicht enthält — die Suche liefe sonst leer.
    scrollToEventIndex(index) {
      const node = this.$root?.querySelector(`.global-zeitstrahl-body--card [data-ev-index="${index}"]`);
      node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },

    // Index des ersten undatierten Events (kein Kalenderjahr) in der gefilterten
    // Liste, oder -1. Diese Events landen nicht auf der Achse — Basis für die
    // Listen-Trennlinie (gz-section-divider) und den klickbaren Achse-Hinweis.
    // Memoisiert auf die (ihrerseits memoisierte) gefilterte Liste: ereignisse.html
    // liest den Index ZWEIMAL pro Ereigniszeile (Trennlinie + Achse-Hinweis), und
    // bei durchgaengig datierten Buechern laeuft jeder Aufruf die ganze Liste ab —
    // ungecacht ist die Liste damit O(Ereignisse²).
    firstUndatedIndex() {
      const list = this.filteredEreignisse();
      return this._memo('firstUndated', [list], () => {
        for (let i = 0; i < list.length; i++) if (!hasEventYear(list[i])) return i;
        return -1;
      });
    },

    // Klick auf den Achse-Hinweis → zum ersten undatierten Listeneintrag scrollen.
    scrollToFirstUndated() {
      const idx = this.firstUndatedIndex();
      if (idx >= 0) this.scrollToEventIndex(idx);
    },

    // Liste → Band: hebt den Marker zum Listen-Index hervor und scrollt ihn
    // horizontal ins Bild. No-op für undatierte Events (kein Marker auf der Achse).
    selectTimelineEvent(index) {
      this._selectEventAt(index);
      this.$nextTick(() => {
        const marker = this.$root?.querySelector(`.gz-band-marker[data-ev-index="${index}"]`);
        marker?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      });
    },

    // Achse/Zeile → Manuskript: öffnet den ersten verknüpften Abschnitt, sonst
    // das erste Kapitel — beides per ID (chapter-filter.js); nur ein Anker ohne ID
    // (Figuren-Fallback) löst über den Namen auf. Liefert true bei Sprungziel.
    openEventText(ev) {
      if (!ev) return false;
      const pageId = ev.page_ids?.find(id => id != null);
      if (pageId != null) { window.__app.gotoPageById(pageId); return true; }
      const chapterId = ev.chapter_ids?.find(id => id != null);
      if (chapterId != null) { window.__app.gotoChapterById(chapterId); return true; }
      const kap = ev.kapitel?.[0];
      if (kap) { window.__app.gotoStelle(kap, null); return true; }
      return false;
    },

    // True, wenn openEventText ein Ziel hätte (steuert .internal-link-Affordance).
    eventHasTarget(ev) {
      return ev?.page_ids?.some(id => id != null) || !!ev?.kapitel?.length;
    },

    // --- Jahres-Band ---------------------------------------------------------
    // Anzeige-Modell (Achsen-Ticks + Lane-gepackte Marker), gecacht über die
    // Identität der gefilterten Liste — filteredEreignisse() liefert dieselbe
    // Array-Referenz solange Daten/Filter unverändert, also rechnet das Layout
    // nur bei echtem Wechsel neu. Das Template ruft bandModel() mehrfach pro
    // Render (Höhe, Tick-Loop, Marker-Loop) — Memo hält das Layout stabil.
    bandModel() {
      const events = this.filteredEreignisse();
      return this._memo('band', [events, this._bandWidth],
        () => buildBandModel(events, this._bandWidth));
    },

    // Anzahl datierter Events (auf der Achse). Treibt die Sichtbarkeit des Bands
    // und den Hinweis auf undatierte Events. Getter statt State — kein
    // imperativer Render mehr, der ihn pflegen müsste.
    get timelineItemCount() {
      return this.bandModel().itemCount;
    },

    // Inline-CSS-Props eines Markers: x-Position (Prozent), Spur (Lane → top via
    // calc in der CSS), Akzentfarbe, sowie Breite bei Spannen. `:style`-Binding
    // mit Custom-Props ist das etablierte Muster (vgl. --span-years/--progress).
    bandMarkerStyle(m) {
      const style = {
        left: m.x.toFixed(3) + '%',
        '--gz-band-lane': m.lane,
        '--gz-marker-color': m.kind === 'more' ? 'var(--color-muted)' : bandMarkerColor(m.subtyp, m.extern),
      };
      if (m.isRange) style.width = m.widthPct.toFixed(3) + '%';
      return style;
    },

    // Klick auf einen Band-Marker → zum Listeneintrag scrollen + hervorheben.
    onBandMarkerClick(index) {
      this._selectEventAt(index);
      this.scrollToEventIndex(index);
    },
  }));
}
