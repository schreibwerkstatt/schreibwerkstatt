// Alpine.data('orteCard') — Sub-Komponente der Schauplatz-Karte.
//
// Eigener State: Meta-Flags (Loading/Progress/Status/PollTimer).
// Geteilt:
//   - `orte` (Alpine.store('catalog'))
//   - `orteFilters`/`selectedOrtId` (Alpine.store('catalogUi') —
//     app-navigation/Hash-Router schreiben darauf)
// Root behält:
//   - `loadOrte` (Root-Spread; von komplett-Job, Szenen-Trigger
//     und _reloadVisibleBookCards genutzt)
//   - `patchOrtCoords` (Koordinaten-Patch für Geo-Edits) und die Pflege-Calls
//     `createOrt`/`updateOrt`/`mergeOrt`/`deleteOrt` (book/orte.js)
import { setupCardLifecycle } from './card-lifecycle.js';
import { memoMethods } from './card-memo.js';
import { orteMapMethods } from '../book/orte-map.js';
import { orteEditMethods, closedOrtEdit } from '../book/orte-edit.js';
import { orteInsightMethods } from '../book/orte-insights.js';
import { lsGet, lsSet } from '../safe-storage.js';
import { formatLastRun } from '../utils/date.js';

export function registerOrteCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('orteCard', () => ({
    orteLoading: false,
    orteProgress: 0,
    orteStatus: '',
    viewMode: lsGet('orte.viewMode') === 'grid' ? 'grid' : 'list', // 'list' | 'grid' | 'map'
    // Geo-Karte (View-Mode 'map') — siehe book/orte-map.js.
    orteRealEnabled: false,   // book_settings.orte_real → blendet Karten-Tab ein
    geocodingId: null,        // loc-id, fuer die gerade ein Geocode laeuft
    geocodingAll: false,      // Batch-Geocode laeuft (sperrt Einzel-Buttons)
    highlightOrtId: null,     // Cross-Highlight Marker ↔ Locate-Liste
    orteMapStatus: '',
    geoLocked: lsGet('orte.geoLocked') !== '0', // verortete Marker gegen versehentliches Ziehen sperren (Default an)
    _geoUndoStack: [],        // Pin-Positions-History (max 10) — siehe orte-map.js
    _geoRedoStack: [],
    _geoLang: 'de',
    _bookLand: null,          // book_settings.schauplatz_land → Geocode-Länder-Bias
    _map: null,               // Leaflet-Instanz (transienter Runtime-Handle)
    _markers: null,           // Leaflet-LayerGroup
    _markerById: {},          // ort-id → Leaflet-Marker (Cross-Highlight-Lookup)
    _unlocatedLatLng: {},     // ort-id → { lat, lng }: stabile Raster-Position unverorteter Pins
    _gridRowsCache: null,     // Memo fuer orteGridRows() (Land-Label-Sort im Grid)
    // Memo für den orteFiltered-Getter: { sig, val }. Der Getter wird pro Render
    // mehrfach gelesen (Liste, Grid, Karte) und filtert + sortiert je voll —
    // Cache liefert bei unveränderten Eingaben dieselbe Array-Referenz zurück
    // (stabile Keys, kein Doppel-Compute in der Karte).
    _orteFilteredCache: null,
    _ortePollTimer: null,
    _geocodeJobTimer: null,   // transienter Poll-Timer fuer den KI-Geocode-Fallback-Job
    _orteMapStatusTimer: null,// Auto-Clear-Timer fuer orteMapStatus
    _lifecycle: null,
    // Pflege-Formular (book/orte-edit.js): { mode: null|'new'|'edit', id, draft, busy, error }.
    ortEdit: closedOrtEdit(),
    ortMergeTarget: '',       // Ziel-loc_id der «Zusammenführen mit …»-Auswahl im Detail

    init() {
      this.$watch('viewMode', (v) => {
        // 'map' nicht persistieren — Tab existiert nur bei orte_real.
        if (v === 'list' || v === 'grid') lsSet('orte.viewMode', v);
        if (v === 'map') this.ensureOrteMap();
      });
      // Karten-Marker reaktiv an den Filter koppeln. orteFiltered ist die
      // Marker-Quelle, aber Leaflet zeichnet imperativ — ohne Watch bleiben die
      // Marker nach Such-/Filteraenderung (inkl. Reset) stehen, waehrend die
      // Locate-Liste schon gefiltert ist. Signatur ueber die gefilterten ids
      // feuert nur bei echter Mengenaenderung (Drag/Geocode rendern selbst).
      this.$watch(
        () => this.orteFiltered.map(o => o.id).join(','),
        () => this.refreshOrteMarkersForFilter(),
      );
      this._lifecycle = setupCardLifecycle(this, {
        name: 'orte',
        showFlag: 'showOrteCard',
        timerKeys: ['_ortePollTimer', '_geocodeJobTimer', '_orteMapStatusTimer'],
        resetState: { orteLoading: false, orteProgress: 0, orteStatus: '', orteRealEnabled: false, geocodingId: null, geocodingAll: false, highlightOrtId: null, orteMapStatus: '', ortMergeTarget: '' },
        load: (root) => root.loadOrte(Alpine.store('nav').selectedBookId),
        onShow: async (root) => {
          const tasks = [root.loadOrte(Alpine.store('nav').selectedBookId), this.loadOrteReal()];
          if (!root.$store.catalog.szenen.length) tasks.push(root.loadSzenen(Alpine.store('nav').selectedBookId));
          await Promise.all(tasks);
        },
        extraListeners: [
          // Buchwechsel: Map verwerfen + auf Liste zuruecksetzen — neues Buch ist
          // evtl. nicht orte_real, und Marker-Daten stammen vom alten Buch.
          { type: 'book:changed', handler: () => { this._teardownMap(); this.ortEdit = closedOrtEdit(); if (this.viewMode === 'map') this.viewMode = 'list'; } },
          { type: 'view:reset', handler: () => { this._teardownMap(); if (this.viewMode === 'map') this.viewMode = 'list'; } },
        ],
      });
    },

    destroy() {
      this._teardownMap();
      this._lifecycle?.destroy();
    },

    // Gefilterte + sortierte Orte für Liste/Grid/Karte. Filter-State + Kapitel-/
    // Seiten-Order leben am Root, darum via window.__app gelesen; der Cache ist
    // Karten-State (eine Referenz pro unveränderter Eingabe → stabile Keys).
    get orteFiltered() {
      const root = window.__app;
      const f = Alpine.store('catalogUi').orteFilters;
      const sig = [root.$store.catalog.orte, root.$store.catalog.szenen, f.suche || '', f.figurId || '', f.kapitel || '', f.szeneId || ''];
      const c = this._orteFilteredCache;
      if (c && c.sig.length === sig.length && c.sig.every((v, i) => v === sig[i])) return c.val;
      const { val, depth } = this._nestByParent(this._computeOrteFiltered());
      this._orteFilteredCache = { sig, val, depth };
      return val;
    },

    // Stand des Katalogs (jüngster Edit oder Analyse-Lauf) für die Kopfzeile.
    orteUpdatedLabel() {
      const app = window.__app;
      return formatLastRun(Alpine.store('catalogUi').orteUpdatedAt, (k, p) => app.t(k, p), app.$store.shell.uiLocale);
    },

    // Einrücktiefe eines Orts in der gefilterten Liste (0 = Wurzel). Tiefe zählt nur
    // über Elternorte, die selbst in der Liste stehen — sonst hinge das Kind
    // eingerückt unter einem fremden Nachbarn.
    ortDepth(id) {
      this.orteFiltered;
      return this._orteFilteredCache?.depth.get(id) || 0;
    },

    // Unterorte direkt unter ihren Elternort ziehen (Tiefensuche, Geschwister in
    // der Reihenfolge der Sortierung). Zyklen aus Altbeständen brechen über `seen`.
    _nestByParent(list) {
      const ids = new Set(list.map(o => o.id));
      const kids = new Map();
      const roots = [];
      for (const o of list) {
        if (o.parent && o.parent !== o.id && ids.has(o.parent)) {
          if (!kids.has(o.parent)) kids.set(o.parent, []);
          kids.get(o.parent).push(o);
        } else roots.push(o);
      }
      const val = [];
      const depth = new Map();
      const seen = new Set();
      const walk = (o, d) => {
        if (seen.has(o.id)) return;
        seen.add(o.id);
        val.push(o);
        depth.set(o.id, d);
        for (const k of (kids.get(o.id) || [])) walk(k, Math.min(d + 1, 3));
      };
      for (const r of roots) walk(r, 0);
      for (const o of list) if (!seen.has(o.id)) walk(o, 0);
      return { val, depth };
    },
    _computeOrteFiltered() {
      const root = window.__app;
      const f = Alpine.store('catalogUi').orteFilters;
      const q = f.suche ? f.suche.toLowerCase() : '';
      const matchText = (o) => !q || [o.name, o.typ, o.stimmung, o.beschreibung, o.land]
        .some(v => v && String(v).toLowerCase().includes(q));
      return root.$store.catalog.orte.filter(o =>
        matchText(o) &&
        (!f.figurId || (o.figuren || []).includes(f.figurId)) &&
        (!f.kapitel || (o.kapitel || []).some(k => k.name === f.kapitel || String(k.chapter_id) === String(f.kapitel))) &&
        (!f.szeneId || root.$store.catalog.szenen.some(s => String(s.id) === String(f.szeneId) && (s.ort_ids || []).includes(o.id)))
      ).sort((a, b) => {
        const aK = Math.min(...(a.kapitel || []).map(k => root._chapterIdx(k.name)), 9999);
        const bK = Math.min(...(b.kapitel || []).map(k => root._chapterIdx(k.name)), 9999);
        if (aK !== bK) return aK - bK;
        const aP = root._pageIdIdx(a.erste_erwaehnung_page_id);
        const bP = root._pageIdIdx(b.erste_erwaehnung_page_id);
        if (aP !== bP) return aP - bP;
        return (a.name || '').localeCompare(b.name || '', 'de');
      });
    },

    ...memoMethods,
    ...orteMapMethods,
    ...orteEditMethods,
    ...orteInsightMethods,
  }));
}
