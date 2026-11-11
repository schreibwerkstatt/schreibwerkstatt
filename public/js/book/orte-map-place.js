// Manuelles Platzieren auf der Geo-Karte der Orte-Karte (View-Mode 'map'):
// Klick-Platzieren, Ortssuche, Kartenhintergrund (Karte/Luftbild) und die
// Rückgängig-/Wiederholen-Griffe. Gespreadet über orteMapMethods (orte-map.js)
// in Alpine.data('orteCard').
//
// Klick-Platzieren: «Platzieren» (Locate-Liste oder Marker-Popup) schaltet die
// Karte in den Platzier-Modus; der nächste Klick in die Karte legt den Ort dort
// ab — derselbe Speicherweg wie ein Marker-Drag (_onMarkerDropped: Patch +
// Verlaufsschritt). Esc oder «Abbrechen» in der Platzier-Leiste beenden ihn. Bewusst auch für gesperrte verortete Orte:
// die Sperre schützt vor versehentlichem Ziehen, Platzieren ist eine ausdrückliche
// Wahl. Danach gilt der Zoom-Anker (orte-map.js#_installZoomAnchor) wie nach einem
// Drag: reinzoomen hält den Pin an seiner Bildschirmstelle.
//
// Ortssuche: GET /geocode (Heuristik-Lookup, kein KI-Call) mit Buchsprache und
// Schauplatz-Land als Region. Die Suche verschiebt nur den Ausschnitt; gesetzt
// wird ein Ort immer erst per Klick oder Drag.

import { fetchJson } from '../utils.js';
import { lsSet } from '../safe-storage.js';
import { matchHistoryCommand } from '../editor/shared/shortcuts.js';

// Zoomstufe nach einem Suchtreffer: Strassenebene, fein genug zum Platzieren.
const SEARCH_HIT_ZOOM = 16;

export const orteMapPlaceMethods = {
  // Einmal je Karten-Instanz (aus ensureOrteMap nach dem Zoom-Anker).
  _installMapPlace() {
    const map = this._map;
    map.on('click', (e) => {
      if (this.placingOrtId == null) return;
      const id = this.placingOrtId;
      const ll = e.latlng;
      this.cancelPlaceOrt();
      // Nach dem Zoom-Anker-Reset auf «click» (registriert vorher) setzen.
      this._zoomAnchor = window.L.latLng(ll.lat, ll.lng);
      this.highlightOrtId = id;
      const w = ll.wrap();
      this._onMarkerDropped(id, w.lat, w.lng);
    });
    // «Platzieren»-Knopf im Marker-Popup (Popup ist ein HTML-String → Delegation).
    map.on('popupopen', (e) => {
      const btn = e.popup.getElement()?.querySelector('[data-place-ort]');
      if (!btn) return;
      btn.onclick = () => {
        map.closePopup();
        this.startPlaceOrt(Number(btn.dataset.placeOrt));
      };
    });
  },

  // --- Klick-Platzieren --------------------------------------------------------

  startPlaceOrt(id) {
    if (!this._map) return;
    const o = window.__app.$store.catalog.orte.find(x => x.id === id);
    if (!o) return;
    if (this.placingOrtId != null) this.cancelPlaceOrt();
    this.placingOrtId = id;
    this.highlightOrtId = id;
    this._map.getContainer().classList.add('ort-map--placing');
    // Esc überall abfangen (Fokus liegt oft noch auf dem Knopf in der Liste),
    // in der Capture-Phase, damit kein Karten-/Karten-Esc mitfeuert.
    this._placeEscHandler = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      this.cancelPlaceOrt();
    };
    document.addEventListener('keydown', this._placeEscHandler, true);
    this._map.getContainer().scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  },

  cancelPlaceOrt() {
    if (this.placingOrtId == null) return;
    this.placingOrtId = null;
    this._map?.getContainer().classList.remove('ort-map--placing');
    if (this._placeEscHandler) document.removeEventListener('keydown', this._placeEscHandler, true);
    this._placeEscHandler = null;
  },

  placingOrtName() {
    if (this.placingOrtId == null) return '';
    return window.__app.$store.catalog.orte.find(x => x.id === this.placingOrtId)?.name || '';
  },

  // --- Ortssuche ---------------------------------------------------------------

  async runMapSearch() {
    const q = (this.mapSearchQuery || '').trim();
    if (!q || !this._map || this.mapSearchBusy) return;
    this.mapSearchBusy = true;
    this.mapSearchResults = null;
    try {
      const params = new URLSearchParams({ q, lang: this._geoLang === 'en' ? 'en' : 'de' });
      if (this._bookLand && /^[A-Za-z]{2}$/.test(this._bookLand)) params.set('region', this._bookLand.toLowerCase());
      const res = await fetchJson('/geocode?' + params);
      const list = (Array.isArray(res?.candidates) ? res.candidates : [])
        .filter(c => Number.isFinite(c?.lat) && Number.isFinite(c?.lng));
      this.mapSearchResults = list;
      if (list.length) this.pickMapSearchResult(list[0]);
    } catch {
      this.mapSearchResults = null;
      this.setOrteMapStatus(window.__app.t('orte.map.search.failed'));
    } finally {
      this.mapSearchBusy = false;
    }
  },

  // Ausschnitt auf einen Treffer setzen + Treffer markieren (nicht klickbar,
  // damit der Platzier-Klick genau dort durchgeht).
  pickMapSearchResult(r) {
    if (!this._map) return;
    this._searchHitLayer?.remove();
    this._searchHitLayer = window.L.circleMarker([r.lat, r.lng], {
      radius: 10, interactive: false, className: 'ort-map-search-hit',
    }).addTo(this._map);
    this._zoomAnchor = null;
    this._map.setView([r.lat, r.lng], SEARCH_HIT_ZOOM);
    this.mapSearchActive = r;
  },

  clearMapSearch() {
    this.mapSearchQuery = '';
    this.mapSearchResults = null;
    this.mapSearchActive = null;
    this._searchHitLayer?.remove();
    this._searchHitLayer = null;
  },

  // --- Kartenhintergrund -------------------------------------------------------

  hasSatelliteLayer() {
    return !!this.$store.config.mapTiles?.satellite?.url;
  },

  toggleMapLayer() {
    this.mapLayer = this.mapLayer === 'satellite' ? 'map' : 'satellite';
    lsSet('orte.mapLayer', this.mapLayer);
    if (this._map) this._syncTileLayer(window.L);
  },

  // --- Tastatur ----------------------------------------------------------------

  // Cmd/Ctrl+Z bzw. Cmd/Ctrl+Umschalt+Z / Ctrl+Y im Karten-Bereich (Karte, Knöpfe,
  // Locate-Liste) → Koordinaten-Verlauf. Nicht in Textfeldern (Ortssuche).
  onOrteMapKeydown(e) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const cmd = matchHistoryCommand(e);
    if (!cmd) return;
    e.preventDefault();
    e.stopPropagation();
    const view = e.currentTarget;
    const step = cmd === 'undo' ? this.undoGeoMove() : this.redoGeoMove();
    // Während des Speicherns sperren sich Rückgängig/Wiederholen; lag der Fokus
    // auf einem der Knöpfe, fiele er auf den <body> und das nächste Kürzel käme
    // nicht mehr an. Dann den Fokus auf die Karte holen.
    Promise.resolve(step).then(() => this.$nextTick(() => {
      if (view && !view.contains(document.activeElement)) this._map?.getContainer().focus({ preventScroll: true });
    }));
  },

  _teardownMapPlace() {
    this.cancelPlaceOrt();
    this.clearMapSearch();
  },
};
